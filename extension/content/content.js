// LambSafe content script. Runs in every frame of AWS console tabs (the Lambda
// code editor lives in an iframe) and tells the service worker when you are
// about to change a function, so the deployed code is saved first:
//
//   edit   - you typed/pasted in the page or moved focus into the editor
//   deploy - you pressed Deploy or Ctrl/Cmd+Shift+U
//   upload - you opened "Upload from" (.zip / S3), which also replaces code
//   open   - the tab navigated to a function (top frame only)
//
// It never blocks or alters the console: signals are fire-and-forget. The top
// frame also shows small toasts with the result.
(() => {
  if (globalThis.__lambsafeLoaded) return;
  globalThis.__lambsafeLoaded = true;

  const isTop = window === window.top;
  if (isTop && !location.pathname.startsWith('/lambda')) return;

  const EDIT_THROTTLE_MS = 3000;
  const INTENT_DEDUPE_MS = 1500;
  const BUTTONISH =
    'button, [role="button"], [role="menuitem"], [role="option"], a, ' +
    '.monaco-button, .monaco-text-button, input[type="button"], input[type="submit"]';
  const DEPLOY_LABEL = /^deploy\b/i;
  const UPLOAD_LABEL = /^(upload from|\.zip file|amazon s3 location)\b/i;

  let lastEditAt = 0;
  let lastIntent = { kind: null, at: 0 };

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function send(message) {
    if (!extensionAlive()) return; // Extension was reloaded; this copy is orphaned.
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function signal(kind) {
    const now = Date.now();
    if (kind === 'edit') {
      if (now - lastEditAt < EDIT_THROTTLE_MS) return;
      lastEditAt = now;
    } else if (kind === lastIntent.kind && now - lastIntent.at < INTENT_DEDUPE_MS) {
      return; // pointerdown + click for the same press
    } else {
      lastIntent = { kind, at: now };
    }
    const message = { type: 'lambsafe:signal', kind };
    if (isTop) message.hint = readAccountHint();
    send(message);
  }

  // --- What did the user just press? ---

  function classifyElement(el) {
    const labels = [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent, el.value];
    for (const raw of labels) {
      if (!raw) continue;
      const text = String(raw).trim().replace(/\s+/g, ' ');
      if (!text || text.length > 60) continue; // a container, not a button
      if (DEPLOY_LABEL.test(text)) return 'deploy';
      if (UPLOAD_LABEL.test(text)) return 'upload';
    }
    return null;
  }

  function classifyEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path.slice(0, 12)) {
      if (node instanceof Element && node.matches(BUTTONISH)) return classifyElement(node);
    }
    return null;
  }

  function onPress(event) {
    if (!event.isTrusted) return;
    const kind = classifyEvent(event);
    if (kind) signal(kind);
  }

  function isEditingKey(event) {
    const key = (event.key || '').toLowerCase();
    if (event.ctrlKey || event.metaKey) return ['v', 'x', 'z', 'y', 'd', '/', 'enter'].includes(key);
    return key.length === 1 || ['backspace', 'delete', 'enter', 'tab'].includes(key);
  }

  function onKeyDown(event) {
    if (!event.isTrusted) return;
    const key = (event.key || '').toLowerCase();
    if (event.shiftKey && (event.ctrlKey || event.metaKey) && key === 'u') {
      signal('deploy'); // Lambda editor's Deploy shortcut
    } else if (isEditingKey(event)) {
      signal('edit');
    }
  }

  const opts = { capture: true, passive: true };
  window.addEventListener('pointerdown', onPress, opts);
  window.addEventListener('click', onPress, opts);
  window.addEventListener('keydown', onKeyDown, opts);
  for (const type of ['beforeinput', 'paste', 'cut', 'drop']) {
    window.addEventListener(type, (e) => e.isTrusted && signal('edit'), opts);
  }

  if (!isTop) return;

  // --- Top frame only ---

  let lastHref = null;
  let hintSent = null;
  let hintAttempts = 0;
  let cachedHint = { value: null, at: 0 };
  const shownErrors = new Set(); // error toasts already shown on this page
  let toastRoot = null;
  let hideTimer = null;

  // The code editor is an iframe. If this script can't run inside it (e.g. it
  // is served from another origin), focus moving into it is still visible
  // here, and is a reliable "about to edit" moment.
  window.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement?.tagName === 'IFRAME') signal('edit');
    }, 0);
  });

  // The console is a single-page app: watch for navigation to another function.
  function checkLocation() {
    if (!extensionAlive()) return;
    if (location.href !== lastHref) {
      lastHref = location.href;
      hintAttempts = 0;
      hintSent = readAccountHint();
      send({ type: 'lambsafe:signal', kind: 'open', hint: hintSent });
      return;
    }
    // The account usually appears on the page a moment after load.
    if (!hintSent && hintAttempts < 30) {
      hintAttempts += 1;
      const hint = readAccountHint();
      if (hint) {
        hintSent = hint;
        send({ type: 'lambsafe:hint', hint });
      }
    }
  }

  /** Best-effort AWS account ID of the signed-in console session. */
  function readAccountHint() {
    const now = Date.now();
    if (cachedHint.value && now - cachedHint.at < 10_000) return cachedHint.value;
    const value = readAccountHintUncached();
    cachedHint = { value, at: now };
    return value;
  }

  function readAccountHintUncached() {
    // Multi-session console URLs carry the account ID; the worker reads that
    // from the URL itself.
    const meta = document.querySelector('meta[name="awsc-session-data"]');
    if (meta?.content) {
      try {
        const data = JSON.parse(meta.content);
        const id = data.accountId || String(data.sessionARN || data.sessionArn || '').split(':')[4];
        if (/^\d{12}$/.test(id || '')) return id;
      } catch {
        /* not JSON */
      }
    }
    const text = document.body?.textContent || '';
    const fn = location.hash.match(/^#\/functions\/([A-Za-z0-9_-]+)/)?.[1];
    if (fn) {
      const arn = text.match(new RegExp(`arn:aws[\\w-]*:lambda:[\\w-]+:(\\d{12}):function:${fn}(?![\\w-])`));
      if (arn) return arn[1];
    }
    const nav = text.match(/Account ID:?\s*(\d{4})-?(\d{4})-?(\d{4})/);
    return nav ? nav.slice(1, 4).join('') : null;
  }

  // --- Toasts ---

  function onStatus(msg) {
    if (!msg.toasts) return;
    const name = msg.target?.functionName || 'function';
    const userAsked = msg.kind === 'deploy' || msg.kind === 'upload' || msg.kind === 'manual';
    const account = msg.accountId ? ` (account ${msg.accountId}${msg.accountVerified ? '' : ', not verified'})` : '';

    switch (msg.status) {
      case 'started':
        toast('info', `Backing up the deployed code of ${name}${account}…`, null, 30000);
        break;
      case 'in-progress':
        if (userAsked) toast('info', `Backup of ${name} is still downloading…`);
        break;
      case 'saved':
        toast('success', `Saved deployed version of ${name}`, msg.record?.path || msg.record?.filename, 5000);
        break;
      case 'already':
        if (userAsked) toast('success', `Deployed version of ${name} is already backed up`, null, 2500);
        break;
      case 'image':
        if (userAsked) toast('info', `${name} is a container image function; there is no .zip to back up.`, null, 5000);
        break;
      case 'error':
      case 'failed': {
        // Background checks can repeat the same error; say it once per page.
        const key = `${msg.code}|${name}`;
        if (!userAsked && shownErrors.has(key)) return;
        shownErrors.add(key);
        const needsSettings = ['NO_CREDENTIALS', 'NO_PROFILE_FOR_ACCOUNT', 'ResourceNotFoundException',
          'UnrecognizedClientException', 'InvalidClientTokenId', 'ExpiredTokenException', 'ExpiredToken',
          'AccessDeniedException', 'InvalidSignatureException'].includes(msg.code);
        toast('error', `LambSafe could not back up ${name}`, msg.message, 12000,
          needsSettings ? { label: 'Open settings', onClick: () => send({ type: 'lambsafe:open-options' }) } : null);
        break;
      }
      default:
        break;
    }
  }

  function ensureToastRoot() {
    if (toastRoot?.isConnected) return toastRoot;
    const host = document.createElement('lambsafe-toast');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .t { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 360px;
             display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 8px;
             background: #1f2328; color: #f6f8fa; box-shadow: 0 6px 24px rgba(0,0,0,.25);
             border-left: 4px solid var(--c); }
        .info { --c: #d4a72c; } .success { --c: #2da44e; } .error { --c: #f85149; }
        .body { flex: 1; min-width: 0; }
        .title { font-weight: 600; }
        .title::before { content: "LambSafe · "; font-weight: 400; opacity: .7; }
        .detail { opacity: .8; margin-top: 2px; word-break: break-all; }
        button { font: inherit; cursor: pointer; border-radius: 6px; }
        .action { margin-top: 8px; padding: 3px 10px; border: 1px solid #8c959f; background: transparent; color: inherit; }
        .close { border: 0; background: transparent; color: inherit; opacity: .6; padding: 0 2px; font-size: 16px; line-height: 1; }
        .close:hover { opacity: 1; }
      </style>
      <div class="t" role="status" aria-live="polite" hidden></div>`;
    (document.body || document.documentElement).appendChild(host);
    toastRoot = shadow.querySelector('.t');
    return toastRoot;
  }

  function toast(kind, title, detail = null, timeoutMs = 0, action = null) {
    const el = ensureToastRoot();
    el.className = `t ${kind}`;
    el.replaceChildren();

    const body = document.createElement('div');
    body.className = 'body';
    const titleEl = document.createElement('div');
    titleEl.className = 'title';
    titleEl.textContent = title;
    body.append(titleEl);
    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'detail';
      detailEl.textContent = detail;
      body.append(detailEl);
    }
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'action';
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      body.append(btn);
    }
    const close = document.createElement('button');
    close.className = 'close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => (el.hidden = true));
    el.append(body, close);
    el.hidden = false;

    clearTimeout(hideTimer);
    if (timeoutMs) hideTimer = setTimeout(() => (el.hidden = true), timeoutMs);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'lambsafe:status') onStatus(message);
  });
  setInterval(checkLocation, 1000);
  checkLocation();
})();
