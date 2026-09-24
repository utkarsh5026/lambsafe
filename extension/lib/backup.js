// Core backup logic: "make sure the currently deployed code of this function
// is saved to disk, and never download the same version twice".
//
// Versions are identified by CodeSha256, the hash Lambda computes over the
// deployment package, so re-deploying identical code, re-opening a function or
// clicking Deploy twice never produces a duplicate download.
//
// Chrome APIs are injected so the logic can be unit tested in Node.

import { describeAwsError } from './aws.js';
import { buildBackupPath } from './paths.js';
import { loadProfiles, loadSettings, pickProfile } from './settings.js';

const MINUTE = 60_000;
// After a deploy, keep looking for the newly deployed version while the user
// keeps editing, so it is saved before it can be overwritten in turn.
const DIRTY_RECHECK_MS = 15_000;
const DIRTY_WINDOW_MS = 5 * MINUTE;
// Don't hammer AWS with a failing request on every keystroke.
const ERROR_RETRY_MS = MINUTE;

const TRIGGER_FOR_KIND = { deploy: 'deploy', upload: 'deploy', edit: 'edit', open: 'open' };

/**
 * Whether a signal from the page should cause a GetFunction call.
 * @param {'deploy'|'upload'|'edit'|'open'|'manual'} kind
 */
export function shouldCheck(kind, state, settings, now) {
  if (kind === 'manual') return true;
  if (!settings.enabled) return false;
  const trigger = TRIGGER_FOR_KIND[kind];
  if (!trigger || !settings.triggers[trigger]) return false;
  // Right before code is replaced we always look, whatever we saw earlier:
  // someone else may have deployed since.
  if (trigger === 'deploy') return true;
  if (!state) return true;
  const age = now - state.at;
  if (state.status === 'error') return age >= ERROR_RETRY_MS;
  if (trigger === 'edit' && state.dirty && age >= DIRTY_RECHECK_MS) return true;
  return age >= settings.recheckMinutes * MINUTE;
}

/** The per-function check state after a check has run. */
export function nextCheckState(prev, kind, result, now) {
  const sha = result.sha ?? prev?.sha ?? null;
  let dirty = prev?.dirty ?? null;
  if (dirty && (now - dirty.since > DIRTY_WINDOW_MS || (result.sha && result.sha !== dirty.fromSha))) {
    dirty = null;
  }
  if (kind === 'deploy' || kind === 'upload') dirty = { since: now, fromSha: result.sha ?? null };
  return {
    at: now,
    status: result.status,
    code: result.code ?? null,
    message: result.message ?? null,
    sha,
    fnKey: result.fnKey ?? prev?.fnKey ?? null,
    dirty,
  };
}

export function checkStateKey(target, profile) {
  const account = target.accountId ?? profile?.accountId ?? '?';
  return `check:${account}:${target.region}:${target.functionName}`;
}

function profileErrorMessage(pick) {
  return pick.error === 'NO_CREDENTIALS'
    ? 'Add AWS credentials in LambSafe settings to start backing up.'
    : `No LambSafe credentials for AWS account ${pick.accountId}. Add them in LambSafe settings.`;
}

/**
 * @param {object} deps
 * @param {chrome.storage.StorageArea} deps.local    Durable: settings, profiles, backup records.
 * @param {chrome.storage.StorageArea} deps.session  Per browser session: check state.
 * @param {{download: Function, search: Function}} deps.downloads
 * @param {{getFunction: Function}} deps.lambda
 * @param {(event: object) => void} [deps.notify]
 * @param {() => number} [deps.now]
 */
export function createBackupService({ local, session, downloads, lambda, notify = () => {}, now = Date.now }) {
  const inflight = new Map();

  // Storage updates are read-modify-write, so run them one at a time.
  let queue = Promise.resolve();
  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function read(area, key) {
    return (await area.get(key))[key];
  }

  /**
   * Entry point for every trigger.
   * @param {object} args
   * @param {'deploy'|'upload'|'edit'|'open'|'manual'} args.kind
   * @param {import('./console-url.js').LambdaTarget|null} args.target
   * @param {number|null} [args.tabId]
   * @param {boolean} [args.force] Download again even if this version was saved before.
   */
  async function handleSignal({ kind, target, tabId = null, force = false }) {
    if (!target || (!target.editable && kind !== 'manual')) return { status: 'ignored' };

    const settings = await loadSettings(local);
    const pick = pickProfile(await loadProfiles(local), target.accountId, settings.defaultProfileId);
    const stateKey = checkStateKey(target, pick.profile);
    if (!force && !shouldCheck(kind, await read(session, stateKey), settings, now())) {
      return { status: 'skipped' };
    }

    const result = pick.error
      ? { status: 'error', code: pick.error, accountId: pick.accountId ?? null, message: profileErrorMessage(pick) }
      : await check({ target, profile: pick.profile, settings, kind, tabId, force });

    await serialize(async () => {
      const prev = await read(session, stateKey);
      await session.set({ [stateKey]: nextCheckState(prev, kind, result, now()) });
    });

    const event = {
      ...result,
      kind,
      tabId,
      target,
      accountVerified: Boolean(pick.accountVerified),
    };
    notify(event);
    return event;
  }

  function check(args) {
    const { target, profile, force } = args;
    const key = `${profile.id}|${target.region}|${target.functionName}|${force}`;
    if (!inflight.has(key)) {
      inflight.set(key, runCheck(args).finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  }

  async function runCheck({ target, profile, settings, kind, tabId, force }) {
    let fn;
    try {
      fn = await lambda.getFunction(target.region, target.functionName, profile);
    } catch (err) {
      return { status: 'error', code: err?.code || 'Error', message: describeAwsError(err) };
    }

    const config = fn.Configuration || {};
    const functionName = config.FunctionName || target.functionName;
    const accountId = String(config.FunctionArn || '').split(':')[4] || profile.accountId;
    const base = {
      fnKey: `${accountId}:${target.region}:${functionName}`,
      accountId,
      sha: config.CodeSha256 ?? null,
      lastModified: config.LastModified ?? null,
    };

    if (config.PackageType === 'Image' || fn.Code?.RepositoryType === 'ECR') {
      return { ...base, status: 'image', message: 'Container image functions have no .zip to back up.' };
    }
    if (!base.sha || !fn.Code?.Location) {
      return { ...base, status: 'error', code: 'NoCode', message: 'AWS did not return a download link for this function.' };
    }

    return serialize(async () => {
      const entry = await read(local, `backup:${base.fnKey}`);
      const existing = entry?.versions?.[base.sha];
      if (existing && !force && (await fileStillThere(existing))) {
        return { ...base, status: 'already', record: existing };
      }
      const pending = await findPending(base.fnKey, base.sha);
      if (pending) return { ...base, status: 'in-progress', record: pending.record };

      const filename = buildBackupPath({
        folder: settings.folder,
        accountId,
        region: target.region,
        functionName,
        lastModified: config.LastModified,
        sha: base.sha,
      });
      let downloadId;
      try {
        downloadId = await downloads.download({
          url: fn.Code.Location,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
      } catch (err) {
        return { ...base, status: 'error', code: 'DownloadFailed', message: `Chrome refused the download: ${err?.message || err}` };
      }
      const record = {
        sha: base.sha,
        lastModified: config.LastModified ?? null,
        codeSize: config.CodeSize ?? null,
        runtime: config.Runtime ?? null,
        handler: config.Handler ?? null,
        filename,
        downloadId,
        reason: kind,
        requestedAt: now(),
      };
      await local.set({
        [`pending:${downloadId}`]: {
          fnKey: base.fnKey,
          accountId,
          region: target.region,
          functionName,
          record,
          tabId,
          target,
        },
      });
      return { ...base, status: 'started', record };
    });
  }

  /** False when Chrome knows the file was deleted or never finished. */
  async function fileStillThere(record) {
    if (record.downloadId == null) return true;
    let item;
    try {
      [item] = await downloads.search({ id: record.downloadId });
    } catch {
      return true;
    }
    // Download history was cleared (or the id now belongs to another file):
    // we can't tell, so trust our own record rather than re-downloading.
    if (!item || (record.path && item.filename !== record.path)) return true;
    if (item.state === 'interrupted') return false;
    return item.exists !== false;
  }

  async function findPending(fnKey, sha) {
    const all = await local.get(null);
    return Object.entries(all).find(
      ([key, value]) => key.startsWith('pending:') && value.fnKey === fnKey && value.record.sha === sha,
    )?.[1];
  }

  /** Called from chrome.downloads.onChanged when a download finishes either way. */
  function finalizeDownload(downloadId, state, error) {
    return serialize(async () => {
      const key = `pending:${downloadId}`;
      const pending = await read(local, key);
      if (!pending) return null;
      await local.remove(key);

      const { fnKey, accountId, region, functionName, record, tabId, target } = pending;
      const common = { fnKey, accountId, sha: record.sha, kind: record.reason, tabId, target };

      if (state !== 'complete') {
        const event = {
          ...common,
          status: 'failed',
          code: error || 'Interrupted',
          message: error === 'USER_CANCELED'
            ? 'The backup download was cancelled.'
            : `The backup download did not finish (${error || 'interrupted'}).`,
        };
        notify(event);
        return event;
      }

      let item;
      try {
        [item] = await downloads.search({ id: downloadId });
      } catch {
        item = null;
      }
      const saved = { ...record, path: item?.filename || null, bytes: item?.fileSize ?? null, savedAt: now() };
      const entry = (await read(local, `backup:${fnKey}`)) || { accountId, region, functionName, versions: {} };
      entry.versions[record.sha] = saved;
      await local.set({ [`backup:${fnKey}`]: entry });

      const event = { ...common, status: 'saved', record: saved };
      notify(event);
      return event;
    });
  }

  /** Finishes downloads that completed while the service worker was asleep. */
  async function reconcilePending() {
    const all = await local.get(null);
    for (const key of Object.keys(all)) {
      if (!key.startsWith('pending:')) continue;
      const downloadId = Number(key.slice('pending:'.length));
      let item;
      try {
        [item] = await downloads.search({ id: downloadId });
      } catch {
        continue;
      }
      if (!item) await finalizeDownload(downloadId, 'interrupted', 'NOT_FOUND');
      else if (item.state !== 'in_progress') await finalizeDownload(downloadId, item.state, item.error);
    }
  }

  async function getEntry(fnKey) {
    return read(local, `backup:${fnKey}`);
  }

  /** Every saved version of every function, newest first. */
  async function listBackups() {
    const all = await local.get(null);
    const rows = [];
    for (const [key, entry] of Object.entries(all)) {
      if (!key.startsWith('backup:')) continue;
      for (const record of Object.values(entry.versions || {})) {
        rows.push({
          fnKey: key.slice('backup:'.length),
          accountId: entry.accountId,
          region: entry.region,
          functionName: entry.functionName,
          ...record,
        });
      }
    }
    return rows.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  /** Forget what was downloaded, so the next check downloads again. Files stay on disk. */
  function forgetHistory() {
    return serialize(async () => {
      const keys = Object.keys(await local.get(null)).filter((k) => k.startsWith('backup:'));
      if (keys.length) await local.remove(keys);
      const checks = Object.keys(await session.get(null)).filter((k) => k.startsWith('check:'));
      if (checks.length) await session.remove(checks);
      return keys.length;
    });
  }

  return { handleSignal, finalizeDownload, reconcilePending, getEntry, listBackups, forgetHistory };
}
