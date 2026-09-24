// Builds the Downloads-relative path for a backup:
//   LambSafe/<account>/<region>/<function>/<function>_<deployed-at>_<sha8>.zip

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f~]/g;

export function sanitizeSegment(segment) {
  const cleaned = String(segment)
    .replace(INVALID_CHARS, '_')
    .trim()
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '');
  return cleaned || '_';
}

export function sanitizeFolder(folder) {
  return String(folder || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .map(sanitizeSegment)
    .join('/');
}

/** Lambda reports LastModified like "2024-10-22T17:32:15.123+0000". */
export function parseLambdaDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDeployedAt(lastModified) {
  const date = parseLambdaDate(lastModified);
  if (!date) return 'unknown-date';
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace('T', '_').replace(/:/g, '-');
}

/** CodeSha256 is base64; hex is friendlier in file names. */
export function shaToHex(sha) {
  try {
    return Array.from(atob(sha), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return sanitizeSegment(sha);
  }
}

export function buildBackupPath({ folder, accountId, region, functionName, lastModified, sha }) {
  const file = `${functionName}_${formatDeployedAt(lastModified)}_${shaToHex(sha).slice(0, 8)}.zip`;
  return [
    sanitizeFolder(folder) || 'LambSafe',
    sanitizeSegment(accountId || 'unknown-account'),
    sanitizeSegment(region),
    sanitizeSegment(functionName),
    sanitizeSegment(file),
  ].join('/');
}
