// Settings and credential profiles, stored in chrome.storage.local (never
// chrome.storage.sync, so secrets stay on this machine).

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  triggers: Object.freeze({
    // Check right before a Deploy / "Upload from" click or Ctrl/Cmd+Shift+U.
    deploy: true,
    // Check when you start typing in (or click into) the code editor. This is
    // what makes the backup land before you can possibly hit Deploy.
    edit: true,
    // Check as soon as a function page opens. Off by default because it backs
    // up every function you merely look at.
    open: false,
  }),
  // While editing, look again for a newly deployed version at most this often.
  recheckMinutes: 10,
  // Sub-folder of the browser's Downloads folder.
  folder: 'LambSafe',
  toasts: true,
  defaultProfileId: null,
});

export async function loadSettings(area) {
  const { settings } = await area.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    triggers: { ...DEFAULT_SETTINGS.triggers, ...settings?.triggers },
  };
}

export async function saveSettings(area, patch) {
  const current = await loadSettings(area);
  const next = {
    ...current,
    ...patch,
    triggers: { ...current.triggers, ...patch?.triggers },
  };
  await area.set({ settings: next });
  return next;
}

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} name
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} [sessionToken]
 * @property {string} accountId  From STS GetCallerIdentity when saved.
 * @property {string} [arn]
 */

/** @returns {Promise<Profile[]>} */
export async function loadProfiles(area) {
  const { profiles } = await area.get('profiles');
  return Array.isArray(profiles) ? profiles : [];
}

export async function saveProfiles(area, profiles) {
  await area.set({ profiles });
}

/**
 * Chooses which credentials to use for a console tab.
 *
 * When the tab's account is known we insist on a profile for that account, so
 * a function with the same name in another account is never backed up by
 * mistake. When it is unknown we fall back to the default profile and flag the
 * result as unverified.
 *
 * @param {Profile[]} profiles
 * @param {string|null} accountId
 * @param {string|null} defaultProfileId
 */
export function pickProfile(profiles, accountId, defaultProfileId) {
  if (!profiles.length) return { error: 'NO_CREDENTIALS' };
  if (accountId) {
    const profile = profiles.find((p) => p.accountId === accountId);
    return profile
      ? { profile, accountVerified: true }
      : { error: 'NO_PROFILE_FOR_ACCOUNT', accountId };
  }
  const profile = profiles.find((p) => p.id === defaultProfileId) || profiles[0];
  return { profile, accountVerified: false };
}
