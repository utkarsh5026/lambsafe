import { loadSettings, saveSettings } from '../lib/settings.js';
import { el, formatAgo, formatBytes, formatDate, shortSha, showDownload } from '../ui/format.js';

const $ = (id) => document.getElementById(id);
let tab = null;
let transient = null; // last status event for this tab, shown until the next refresh

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const settings = await loadSettings(chrome.storage.local);
  $('enabled').checked = settings.enabled;
  $('enabled').addEventListener('change', (e) => {
    saveSettings(chrome.storage.local, { enabled: e.target.checked });
  });
  for (const button of document.querySelectorAll('[data-open-options]')) {
    button.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }
  $('open-folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
  $('backup-now').addEventListener('click', () => backupNow(false));
  $('download-again').addEventListener('click', () => backupNow(true));

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'lambsafe:status') return;
    if (message.tabId === tab?.id) transient = message;
    refresh();
  });

  await refresh();
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function backupNow(force) {
  $('backup-now').disabled = true;
  $('download-again').disabled = true;
  $('fn-status').replaceChildren(el('span', { className: 'muted' }, 'Checking AWS…'));
  transient = await send({ type: 'lambsafe:backup-now', tabId: tab.id, url: tab.url, force });
  $('backup-now').disabled = false;
  $('download-again').disabled = false;
  await refresh();
}

async function refresh() {
  const [status, backups] = await Promise.all([
    send({ type: 'lambsafe:tab-status', tabId: tab?.id, url: tab?.url }),
    send({ type: 'lambsafe:list-backups' }),
  ]);
  $('setup').hidden = status.hasProfiles;
  renderCurrent(status);
  renderRecent(backups);
}

function renderCurrent(status) {
  const { target } = status;
  $('no-function').hidden = Boolean(target);
  $('function').hidden = !target;
  if (!target) return;

  $('fn-name').textContent = target.functionName;
  const account = target.accountId
    ? `account ${target.accountId}`
    : status.profile
      ? `account ${status.profile.accountId} (from “${status.profile.name}”, not verified against the console)`
      : 'account unknown';
  $('fn-meta').textContent = `${target.region} · ${account}`;

  $('fn-status').replaceChildren(statusLine(status));
  $('download-again').hidden = !status.currentBackedUp;
  $('backup-now').disabled = !status.hasProfiles || !target.editable;

  const versions = status.versions || [];
  $('version-count').textContent = versions.length ? `(${versions.length})` : '';
  $('versions').replaceChildren(
    ...(versions.length
      ? versions.map((v) => versionItem(v, v.sha === status.state?.sha))
      : [el('li', { className: 'empty' }, 'Nothing saved yet for this function.')]),
  );
}

function statusLine(status) {
  if (!status.target.editable) {
    return el('span', { className: 'muted' }, 'Viewing a published version or alias. Only $LATEST can be changed, so there is nothing to protect here.');
  }
  const event = transient;
  if (event?.status === 'already') return el('span', { className: 'ok' }, '✓ Already backed up. Nothing downloaded.');
  if (event?.status === 'started' || event?.status === 'in-progress') return el('span', { className: 'warn' }, 'Downloading backup…');
  if (event?.status === 'saved') return el('span', { className: 'ok' }, `✓ Saved to ${event.record?.path || event.record?.filename}`);
  if (event?.status === 'error' || event?.status === 'failed') return el('span', { className: 'err' }, event.message || 'Backup failed.');
  if (event?.status === 'image') return el('span', { className: 'muted' }, event.message);

  const { state } = status;
  if (status.profileError === 'NO_PROFILE_FOR_ACCOUNT') {
    return el('span', { className: 'err' }, `No credentials saved for account ${status.target.accountId}.`);
  }
  if (!state) return el('span', { className: 'muted' }, 'Not checked yet. It will be checked when you start editing or deploy.');
  if (status.currentBackedUp) {
    return el('span', { className: 'ok' }, `✓ Deployed version ${shortSha(state.sha)} is backed up (checked ${formatAgo(state.at)}).`);
  }
  if (state.status === 'error') return el('span', { className: 'err' }, state.message || 'The last check failed.');
  if (state.status === 'image') return el('span', { className: 'muted' }, 'Container image function: there is no .zip to back up.');
  if (state.status === 'started' || state.status === 'in-progress') return el('span', { className: 'warn' }, 'Downloading backup…');
  return el('span', { className: 'muted' }, `Last checked ${formatAgo(state.at)}.`);
}

function versionItem(v, isCurrent) {
  return el(
    'li',
    {},
    el(
      'div',
      { className: 'grow' },
      el('div', { className: 'title' }, `Deployed ${formatDate(v.lastModified)}`, isCurrent ? el('span', { className: 'ok' }, ' · live') : null),
      el('div', { className: 'sub mono' }, [shortSha(v.sha), formatBytes(v.bytes ?? v.codeSize), `saved ${formatAgo(v.savedAt)}`].filter(Boolean).join(' · ')),
    ),
    el('button', { onclick: () => showDownload(v.downloadId), title: v.path || v.filename }, 'Show'),
  );
}

function renderRecent(rows) {
  const recent = (rows || []).slice(0, 8);
  $('recent').replaceChildren(
    ...(recent.length
      ? recent.map((r) =>
          el(
            'li',
            {},
            el(
              'div',
              { className: 'grow' },
              el('div', { className: 'title mono' }, r.functionName),
              el('div', { className: 'sub' }, `${r.region} · ${r.accountId} · saved ${formatAgo(r.savedAt)}`),
            ),
            el('button', { onclick: () => showDownload(r.downloadId), title: r.path || r.filename }, 'Show'),
          ),
        )
      : [el('li', { className: 'empty' }, 'No backups yet.')]),
  );
}

init();
