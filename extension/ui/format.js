import { parseLambdaDate, shaToHex } from '../lib/paths.js';

export function shortSha(sha) {
  return sha ? shaToHex(sha).slice(0, 8) : '—';
}

export function formatDate(value) {
  const date = typeof value === 'number' ? new Date(value) : parseLambdaDate(value);
  return date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown date';
}

export function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

/** Tiny DOM helper: el('div', {className: 'x'}, 'text', child). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

/** Reveals a backup in the file manager, falling back to the Downloads folder. */
export async function showDownload(downloadId) {
  try {
    const [item] = downloadId == null ? [] : await chrome.downloads.search({ id: downloadId });
    if (item && item.exists !== false) {
      chrome.downloads.show(downloadId);
      return;
    }
  } catch {
    /* fall through */
  }
  chrome.downloads.showDefaultFolder();
}
