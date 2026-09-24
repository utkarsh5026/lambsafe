import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AwsError } from '../extension/lib/aws.js';
import { createBackupService, shouldCheck } from '../extension/lib/backup.js';
import { DEFAULT_SETTINGS } from '../extension/lib/settings.js';

// --- Fakes for the chrome.* APIs ---

class MemoryArea {
  data = {};
  async get(keys) {
    if (keys == null) return structuredClone(this.data);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(list.filter((k) => k in this.data).map((k) => [k, structuredClone(this.data[k])]));
  }
  async set(items) {
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys) {
    for (const k of [].concat(keys)) delete this.data[k];
  }
}

class FakeDownloads {
  items = new Map();
  calls = [];
  nextId = 1;
  onStart = null;
  async download(options) {
    const id = this.nextId++;
    this.calls.push(options);
    this.items.set(id, {
      id,
      filename: `/home/me/Downloads/${options.filename}`,
      state: 'in_progress',
      exists: true,
      fileSize: 4321,
    });
    this.onStart?.(id);
    return id;
  }
  async search({ id }) {
    const item = this.items.get(id);
    return item ? [{ ...item }] : [];
  }
}

const SHA_A = Buffer.from('a'.repeat(32)).toString('base64');
const SHA_B = Buffer.from('b'.repeat(32)).toString('base64');
const PROFILE = {
  id: 'p1',
  name: 'dev',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  accountId: '123456789012',
};
const TARGET = { region: 'us-east-1', functionName: 'my-fn', accountId: null, qualifier: null, editable: true };

function deployed({ sha = SHA_A, account = '123456789012', image = false } = {}) {
  return {
    Configuration: {
      FunctionName: 'my-fn',
      FunctionArn: `arn:aws:lambda:us-east-1:${account}:function:my-fn`,
      CodeSha256: sha,
      CodeSize: 1000,
      LastModified: '2025-01-31T09:15:00.000+0000',
      PackageType: image ? 'Image' : 'Zip',
      Runtime: image ? undefined : 'nodejs22.x',
    },
    Code: image
      ? { RepositoryType: 'ECR', ImageUri: '123.dkr.ecr.us-east-1.amazonaws.com/x:latest' }
      : { RepositoryType: 'S3', Location: `https://s3.example/${sha}` },
  };
}

async function setup({ profiles = [PROFILE], settings = {}, current = deployed() } = {}) {
  const local = new MemoryArea();
  const session = new MemoryArea();
  await local.set({ profiles, settings });
  const downloads = new FakeDownloads();
  const lambda = {
    calls: [],
    async getFunction(region, name, creds) {
      this.calls.push({ region, name, creds });
      if (current instanceof Error) throw current;
      return structuredClone(current);
    },
  };
  const events = [];
  let clock = 1_700_000_000_000;
  const service = createBackupService({
    local,
    session,
    downloads,
    lambda,
    notify: (e) => events.push(e),
    now: () => clock,
  });

  return {
    service,
    local,
    downloads,
    lambda,
    events,
    setDeployed(next) {
      current = next;
    },
    tick(ms) {
      clock += ms;
    },
    signal(kind, extra = {}) {
      return service.handleSignal({ kind, target: TARGET, tabId: 7, ...extra });
    },
    async finish(id, state = 'complete', error) {
      if (state === 'complete') downloads.items.get(id).state = 'complete';
      return service.finalizeDownload(id, state, error);
    },
  };
}

describe('deduplication', () => {
  test('downloads a deployed version once and never again', async () => {
    const t = await setup();

    const first = await t.signal('deploy');
    assert.equal(first.status, 'started');
    assert.equal(t.downloads.calls.length, 1);
    assert.equal(t.downloads.calls[0].url, `https://s3.example/${SHA_A}`);
    assert.equal(t.downloads.calls[0].filename, 'LambSafe/123456789012/us-east-1/my-fn/my-fn_2025-01-31_09-15-00Z_61616161.zip');
    assert.equal(t.downloads.calls[0].saveAs, false);

    const saved = await t.finish(first.record.downloadId);
    assert.equal(saved.status, 'saved');
    assert.equal(saved.tabId, 7);
    assert.match(saved.record.path, /^\/home\/me\/Downloads\/LambSafe\//);

    for (const kind of ['deploy', 'upload', 'manual']) {
      assert.equal((await t.signal(kind)).status, 'already', kind);
    }
    assert.equal(t.downloads.calls.length, 1);
  });

  test('downloads again once a different version is deployed', async () => {
    const t = await setup();
    await t.finish((await t.signal('deploy')).record.downloadId);

    t.setDeployed(deployed({ sha: SHA_B }));
    const next = await t.signal('deploy');
    assert.equal(next.status, 'started');
    assert.equal(t.downloads.calls.length, 2);
    await t.finish(next.record.downloadId);

    const versions = (await t.service.getEntry('123456789012:us-east-1:my-fn')).versions;
    assert.deepEqual(Object.keys(versions).sort(), [SHA_A, SHA_B].sort());
  });

  test('rolling back to an already saved version does not download it again', async () => {
    const t = await setup();
    await t.finish((await t.signal('deploy')).record.downloadId);
    t.setDeployed(deployed({ sha: SHA_B }));
    await t.finish((await t.signal('deploy')).record.downloadId);
    t.setDeployed(deployed({ sha: SHA_A }));
    assert.equal((await t.signal('deploy')).status, 'already');
    assert.equal(t.downloads.calls.length, 2);
  });

  test('downloads again when the saved file was deleted from disk', async () => {
    const t = await setup();
    const { record } = await t.signal('deploy');
    await t.finish(record.downloadId);
    t.downloads.items.get(record.downloadId).exists = false;

    assert.equal((await t.signal('deploy')).status, 'started');
    assert.equal(t.downloads.calls.length, 2);
  });

  test('trusts its own record when Chrome download history was cleared', async () => {
    const t = await setup();
    const { record } = await t.signal('deploy');
    await t.finish(record.downloadId);
    t.downloads.items.clear();

    assert.equal((await t.signal('deploy')).status, 'already');
    assert.equal(t.downloads.calls.length, 1);
  });

  test('does not start a second download while the first is still running', async () => {
    const t = await setup();
    await t.signal('deploy');
    assert.equal((await t.signal('deploy')).status, 'in-progress');
    assert.equal(t.downloads.calls.length, 1);
  });

  test('simultaneous signals share one AWS call and one download', async () => {
    const t = await setup();
    const results = await Promise.all([t.signal('edit'), t.signal('deploy'), t.signal('upload')]);
    assert.deepEqual(new Set(results.map((r) => r.status)), new Set(['started']));
    assert.equal(t.lambda.calls.length, 1);
    assert.equal(t.downloads.calls.length, 1);
  });

  test('a download that finishes instantly is still recorded', async () => {
    const t = await setup();
    let finalized;
    t.downloads.onStart = (id) => {
      t.downloads.items.get(id).state = 'complete';
      finalized = t.service.finalizeDownload(id, 'complete');
    };
    await t.signal('deploy');
    assert.equal((await finalized).status, 'saved');
    assert.equal((await t.signal('deploy')).status, 'already');
  });

  test('a failed or cancelled download is retried next time', async () => {
    const t = await setup();
    const { record } = await t.signal('deploy');
    const failed = await t.finish(record.downloadId, 'interrupted', 'USER_CANCELED');
    assert.equal(failed.status, 'failed');
    assert.match(failed.message, /cancelled/);

    assert.equal((await t.signal('deploy')).status, 'started');
    assert.equal(t.downloads.calls.length, 2);
  });

  test('"download again" forces a fresh copy', async () => {
    const t = await setup();
    await t.finish((await t.signal('deploy')).record.downloadId);
    assert.equal((await t.signal('manual', { force: true })).status, 'started');
    assert.equal(t.downloads.calls.length, 2);
  });

  test('forgetting history makes the next check download again', async () => {
    const t = await setup();
    await t.finish((await t.signal('deploy')).record.downloadId);
    assert.equal(await t.service.forgetHistory(), 1);
    assert.equal((await t.signal('deploy')).status, 'started');
  });

  test('reconciles downloads that finished while the worker was asleep', async () => {
    const t = await setup();
    const { record } = await t.signal('deploy');
    t.downloads.items.get(record.downloadId).state = 'complete';
    await t.service.reconcilePending();
    assert.equal(t.events.at(-1).status, 'saved');
    assert.equal((await t.service.listBackups()).length, 1);
  });
});

describe('what gets checked', () => {
  test('container image functions are skipped', async () => {
    const t = await setup({ current: deployed({ image: true }) });
    assert.equal((await t.signal('deploy')).status, 'image');
    assert.equal(t.downloads.calls.length, 0);
  });

  test('published versions and aliases are ignored', async () => {
    const t = await setup();
    const result = await t.service.handleSignal({
      kind: 'deploy',
      target: { ...TARGET, qualifier: '3', editable: false },
    });
    assert.equal(result.status, 'ignored');
    assert.equal(t.lambda.calls.length, 0);
  });

  test('without credentials nothing is called and the user is told', async () => {
    const t = await setup({ profiles: [] });
    const result = await t.signal('deploy');
    assert.equal(result.code, 'NO_CREDENTIALS');
    assert.equal(t.lambda.calls.length, 0);
  });

  test('never uses credentials of a different account than the console tab', async () => {
    const t = await setup();
    const result = await t.service.handleSignal({ kind: 'deploy', target: { ...TARGET, accountId: '999999999999' } });
    assert.equal(result.code, 'NO_PROFILE_FOR_ACCOUNT');
    assert.equal(t.lambda.calls.length, 0);
  });

  test('picks the profile that matches the console account', async () => {
    const other = { ...PROFILE, id: 'p2', accountId: '999999999999' };
    const t = await setup({ profiles: [PROFILE, other], current: deployed({ account: '999999999999' }) });
    const result = await t.service.handleSignal({ kind: 'deploy', target: { ...TARGET, accountId: '999999999999' } });
    assert.equal(t.lambda.calls[0].creds.id, 'p2');
    assert.equal(result.accountVerified, true);
    assert.equal(result.fnKey, '999999999999:us-east-1:my-fn');
  });

  test('AWS errors are reported with a readable message', async () => {
    const t = await setup({ current: new AwsError('AccessDeniedException', 'not authorized', 403) });
    const result = await t.signal('deploy');
    assert.equal(result.status, 'error');
    assert.match(result.message, /lambda:GetFunction/);
  });

  test('turning LambSafe off stops automatic checks but not manual ones', async () => {
    const t = await setup({ settings: { enabled: false } });
    assert.equal((await t.signal('deploy')).status, 'skipped');
    assert.equal((await t.signal('manual')).status, 'started');
  });
});

describe('check frequency', () => {
  test('edits check once, then wait for the recheck interval', async () => {
    const t = await setup();
    await t.finish((await t.signal('edit')).record.downloadId);
    assert.equal((await t.signal('edit')).status, 'skipped');
    t.tick(9 * 60_000);
    assert.equal((await t.signal('edit')).status, 'skipped');
    t.tick(61_000);
    assert.equal((await t.signal('edit')).status, 'already');
    assert.equal(t.lambda.calls.length, 2);
  });

  test('deploy always checks, even right after another check', async () => {
    const t = await setup();
    await t.finish((await t.signal('edit')).record.downloadId);
    assert.equal((await t.signal('deploy')).status, 'already');
    assert.equal((await t.signal('deploy')).status, 'already');
    assert.equal(t.lambda.calls.length, 3);
  });

  test('after a deploy, editing soon captures the newly deployed version', async () => {
    const t = await setup();
    await t.finish((await t.signal('deploy')).record.downloadId);

    // The console deploys B; the user keeps editing.
    t.setDeployed(deployed({ sha: SHA_B }));
    t.tick(5_000);
    assert.equal((await t.signal('edit')).status, 'skipped');
    t.tick(11_000);
    const next = await t.signal('edit');
    assert.equal(next.status, 'started');
    assert.equal(next.sha, SHA_B);
    await t.finish(next.record.downloadId);

    // B is saved and the "just deployed" state is over: back to the slow interval.
    t.tick(16_000);
    assert.equal((await t.signal('edit')).status, 'skipped');
  });

  test('errors are retried after a minute, not on every keystroke', async () => {
    const t = await setup({ current: new AwsError('ExpiredTokenException', 'expired', 403) });
    assert.equal((await t.signal('edit')).status, 'error');
    t.tick(30_000);
    assert.equal((await t.signal('edit')).status, 'skipped');
    t.tick(31_000);
    assert.equal((await t.signal('edit')).status, 'error');
    assert.equal(t.lambda.calls.length, 2);
  });

  test('trigger toggles are respected', () => {
    const settings = { ...DEFAULT_SETTINGS, triggers: { deploy: false, edit: false, open: false } };
    for (const kind of ['deploy', 'upload', 'edit', 'open']) {
      assert.equal(shouldCheck(kind, null, settings, 0), false, kind);
    }
    assert.equal(shouldCheck('open', null, DEFAULT_SETTINGS, 0), false, 'open is off by default');
    assert.equal(shouldCheck('manual', null, settings, 0), true);
  });
});
