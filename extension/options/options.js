import { describeAwsError, getCallerIdentity } from '../lib/aws.js';
import { buildBackupPath } from '../lib/paths.js';
import { loadProfiles, loadSettings, saveProfiles, saveSettings } from '../lib/settings.js';
import { el } from '../ui/format.js';

const area = chrome.storage.local;
const $ = (id) => document.getElementById(id);

const POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'LambSafeReadDeployedCode',
      Effect: 'Allow',
      Action: 'lambda:GetFunction',
      Resource: 'arn:aws:lambda:*:*:function:*',
    },
  ],
};

async function init() {
  $('policy').value = JSON.stringify(POLICY, null, 2);
  $('copy-policy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('policy').value);
    flash('Policy copied');
  });

  $('profile-form').addEventListener('submit', onSaveProfile);
  $('forget').addEventListener('click', onForget);

  const settings = await loadSettings(area);
  $('t-deploy').checked = settings.triggers.deploy;
  $('t-edit').checked = settings.triggers.edit;
  $('t-open').checked = settings.triggers.open;
  $('recheck').value = settings.recheckMinutes;
  $('folder').value = settings.folder;
  $('toasts').checked = settings.toasts;
  renderPathExample();

  for (const id of ['t-deploy', 't-edit', 't-open']) {
    $(id).addEventListener('change', () =>
      save({ triggers: { deploy: $('t-deploy').checked, edit: $('t-edit').checked, open: $('t-open').checked } }),
    );
  }
  $('recheck').addEventListener('change', () => {
    const minutes = Math.min(120, Math.max(1, Math.round(Number($('recheck').value) || 10)));
    $('recheck').value = minutes;
    save({ recheckMinutes: minutes });
  });
  $('folder').addEventListener('input', renderPathExample);
  $('folder').addEventListener('change', () => save({ folder: $('folder').value.trim() || 'LambSafe' }));
  $('toasts').addEventListener('change', () => save({ toasts: $('toasts').checked }));

  await renderProfiles();
  await renderHistory();
}

async function save(patch) {
  await saveSettings(area, patch);
  flash('Saved');
}

let flashTimer;
function flash(text) {
  $('saved').textContent = text;
  $('saved').classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => $('saved').classList.remove('show'), 1400);
}

function renderPathExample() {
  $('path-example').textContent = `Downloads/${buildBackupPath({
    folder: $('folder').value,
    accountId: '123456789012',
    region: 'us-east-1',
    functionName: 'my-function',
    lastModified: '2025-01-31T09:15:00.000+0000',
    sha: 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80=',
  })}`;
}

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '…';
}

async function renderProfiles() {
  const profiles = await loadProfiles(area);
  const { defaultProfileId } = await loadSettings(area);
  const defaultId = profiles.some((p) => p.id === defaultProfileId) ? defaultProfileId : profiles[0]?.id;

  $('profiles').replaceChildren(
    ...profiles.map((p) =>
      el(
        'li',
        {},
        el(
          'div',
          { className: 'grow' },
          el('div', {}, el('strong', {}, p.name), ' ', el('span', { className: 'mono' }, p.accountId), ' ',
            profiles.length > 1 && p.id === defaultId ? el('span', { className: 'badge' }, 'default') : null),
          el('div', { className: 'sub' }, `${maskKey(p.accessKeyId)}${p.sessionToken ? ' · temporary' : ''} · ${p.arn || ''}`),
        ),
        profiles.length > 1 && p.id !== defaultId
          ? el('button', {
              title: 'Used when LambSafe cannot tell which account a console tab is signed in to',
              onclick: async () => {
                await save({ defaultProfileId: p.id });
                renderProfiles();
              },
            }, 'Make default')
          : null,
        el('button', { className: 'danger', onclick: () => removeProfile(p.id) }, 'Remove'),
      ),
    ),
  );
}

async function removeProfile(id) {
  if (!confirm('Remove these credentials from LambSafe?')) return;
  await saveProfiles(area, (await loadProfiles(area)).filter((p) => p.id !== id));
  flash('Removed');
  renderProfiles();
}

async function onSaveProfile(event) {
  event.preventDefault();
  const credentials = {
    accessKeyId: $('p-key').value.trim(),
    secretAccessKey: $('p-secret').value.trim(),
    sessionToken: $('p-token').value.trim() || undefined,
  };
  const result = $('p-result');
  result.className = 'muted';
  result.textContent = 'Checking with AWS…';
  $('p-save').disabled = true;

  try {
    const identity = await getCallerIdentity(credentials);
    const profiles = await loadProfiles(area);
    const existing = profiles.find((p) => p.accountId === identity.account);
    const profile = {
      id: existing?.id || crypto.randomUUID(),
      name: $('p-name').value.trim() || existing?.name || `Account ${identity.account}`,
      ...credentials,
      accountId: identity.account,
      arn: identity.arn,
      savedAt: Date.now(),
    };
    await saveProfiles(area, existing ? profiles.map((p) => (p.id === existing.id ? profile : p)) : [...profiles, profile]);
    $('profile-form').reset();
    result.className = 'ok';
    result.textContent = `${existing ? 'Updated' : 'Saved'} credentials for account ${identity.account}.`;
    renderProfiles();
  } catch (err) {
    result.className = 'err';
    result.textContent = describeAwsError(err);
  } finally {
    $('p-save').disabled = false;
  }
}

async function renderHistory() {
  const rows = await chrome.runtime.sendMessage({ type: 'lambsafe:list-backups' });
  $('history-count').textContent = String(rows?.length ?? 0);
}

async function onForget() {
  if (!confirm('Forget which versions were downloaded? Files on disk are kept.')) return;
  await chrome.runtime.sendMessage({ type: 'lambsafe:forget-history' });
  flash('History cleared');
  renderHistory();
}

init();
