// Service worker: turns page signals into backups and reports back to the
// page (toasts), the toolbar badge and the popup.

import { getFunction } from './lib/aws.js';
import { checkStateKey, createBackupService } from './lib/backup.js';
import { parseLambdaConsoleUrl } from './lib/console-url.js';
import { loadProfiles, loadSettings, pickProfile } from './lib/settings.js';

const local = chrome.storage.local;
const session = chrome.storage.session;

const service = createBackupService({
  local,
  session,
  downloads: {
    download: (options) => chrome.downloads.download(options),
    search: (query) => chrome.downloads.search(query),
  },
  lambda: { getFunction },
  notify: (event) => {
    deliver(event).catch(() => {});
  },
});

// --- Listeners (registered synchronously so Chrome can wake us for them) ---

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') {
    service.finalizeDownload(delta.id, state, delta.error?.current);
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !(await loadProfiles(local)).length) chrome.runtime.openOptionsPage();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  session.remove(hintKey(tabId));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromExtensionPage = Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
  const handler = (fromExtensionPage ? pageHandlers : contentHandlers)[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(sendResponse, (err) => sendResponse({ status: 'error', message: String(err?.message || err) }));
  return true;
});

// Downloads that finished while the worker was asleep.
service.reconcilePending().catch(() => {});

// --- Messages from content scripts (any frame of an AWS console tab) ---

const contentHandlers = {
  async 'lambsafe:signal'(message, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return { status: 'ignored' };
    // Only the top frame can read the page's account; it resets the hint on
    // every page load so a role switch in the same tab can't leave it stale.
    if (sender.frameId === 0 && 'hint' in message) await setHint(tabId, message.hint);
    const target = await resolveTarget(tabId, sender.tab.url);
    if (message.kind === 'open') await refreshBadge(tabId, sender.tab.url);
    return service.handleSignal({ kind: message.kind, target, tabId });
  },

  async 'lambsafe:hint'(message, sender) {
    if (sender.frameId === 0 && sender.tab?.id != null) await setHint(sender.tab.id, message.hint);
    return { ok: true };
  },

  'lambsafe:open-options'() {
    chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

// --- Messages from the popup and options page ---

const pageHandlers = {
  'lambsafe:tab-status': ({ tabId, url }) => getTabStatus(tabId, url),

  async 'lambsafe:backup-now'({ tabId, url, force }) {
    const target = await resolveTarget(tabId, url);
    if (!target) return { status: 'error', message: 'This tab is not showing a Lambda function.' };
    return service.handleSignal({ kind: 'manual', target, tabId, force: Boolean(force) });
  },

  'lambsafe:list-backups': () => service.listBackups(),

  'lambsafe:forget-history': () => service.forgetHistory(),
};

// --- Helpers ---

function hintKey(tabId) {
  return `hint:${tabId}`;
}

async function setHint(tabId, accountId) {
  const valid = typeof accountId === 'string' && /^\d{12}$/.test(accountId) ? accountId : null;
  await session.set({ [hintKey(tabId)]: valid });
}

async function resolveTarget(tabId, url) {
  const target = parseLambdaConsoleUrl(url || '');
  if (!target) return null;
  if (target.accountId) return { ...target, accountSource: 'url' };
  const hint = tabId == null ? null : (await session.get(hintKey(tabId)))[hintKey(tabId)];
  return { ...target, accountId: hint ?? null, accountSource: hint ? 'page' : null };
}

async function getTabStatus(tabId, url) {
  const settings = await loadSettings(local);
  const profiles = await loadProfiles(local);
  const target = await resolveTarget(tabId, url);
  const base = { enabled: settings.enabled, hasProfiles: profiles.length > 0 };
  if (!target) return { ...base, target: null };

  const pick = pickProfile(profiles, target.accountId, settings.defaultProfileId);
  const stateKey = checkStateKey(target, pick.profile);
  const state = (await session.get(stateKey))[stateKey] ?? null;
  const fnKey =
    state?.fnKey ?? (pick.profile ? `${pick.profile.accountId}:${target.region}:${target.functionName}` : null);
  const entry = fnKey ? await service.getEntry(fnKey) : null;
  const versions = Object.values(entry?.versions || {}).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

  return {
    ...base,
    target,
    // Never hand secrets to UI pages.
    profile: pick.profile ? { id: pick.profile.id, name: pick.profile.name, accountId: pick.profile.accountId } : null,
    profileError: pick.error ?? null,
    accountVerified: Boolean(pick.accountVerified),
    state,
    currentBackedUp: Boolean(state?.sha && entry?.versions?.[state.sha]),
    versions,
  };
}

async function deliver(event) {
  setBadge(event.tabId, event.status);
  const { toasts } = await loadSettings(local);
  const message = { type: 'lambsafe:status', ...event, toasts };
  if (event.tabId != null) {
    chrome.tabs.sendMessage(event.tabId, message, { frameId: 0 }).catch(() => {});
  }
  // The popup, if it is open.
  chrome.runtime.sendMessage(message).catch(() => {});
}

const BADGES = {
  already: ['✓', '#1a7f37'],
  saved: ['✓', '#1a7f37'],
  started: ['…', '#9a6700'],
  'in-progress': ['…', '#9a6700'],
  error: ['!', '#cf222e'],
  failed: ['!', '#cf222e'],
  image: ['–', '#6e7781'],
  clear: ['', '#6e7781'],
};

function setBadge(tabId, status) {
  const badge = BADGES[status];
  if (tabId == null || !badge) return;
  chrome.action.setBadgeText({ tabId, text: badge[0] }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: badge[1] }).catch(() => {});
}

/** Shows what we last learned about the function the tab has navigated to. */
async function refreshBadge(tabId, url) {
  const status = await getTabStatus(tabId, url);
  if (!status.target?.editable) setBadge(tabId, 'clear');
  else if (status.currentBackedUp) setBadge(tabId, 'saved');
  else if (status.state?.status === 'error') setBadge(tabId, 'error');
  else setBadge(tabId, 'clear');
}
