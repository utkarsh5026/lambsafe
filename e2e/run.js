// End-to-end test: real Chromium with the unpacked extension, against a fake
// AWS console page and fake Lambda / STS / S3 endpoints served locally.
//
// All browser traffic goes through a tiny CONNECT proxy that sends every
// host to one local HTTPS server, which answers based on the Host header.
// Needs: `npm install`, a Playwright Chromium, and `openssl` on PATH.
//
//   npm run test:e2e            (screenshots land in e2e/output/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(here, '..', 'extension');
const OUTPUT = join(here, 'output');
const ACCOUNT = '123456789012';
const ACCESS_KEY = 'AKIAE2ETESTKEY123456';
const sha = (letter) => Buffer.from(letter.repeat(32)).toString('base64');

// --- Fake AWS ---

const aws = {
  deployed: { 'my-fn': sha('A'), 'other-fn': sha('O') },
  getFunctionCalls: 0,
  zipDownloads: 0,
};

const consoleHtml = (fn, crossOriginEditor) => `<!doctype html><title>Lambda</title>
<h1>${fn}</h1>
<p>Function ARN <span>arn:aws:lambda:us-east-1:${ACCOUNT}:function:${fn}</span></p>
<iframe id="editor" width="600" height="260"
  src="${crossOriginEditor ? 'https://editor.fake-cdn.net/editor.html' : '/lambda/editor.html'}"></iframe>`;

// Roughly the shape of the Code-OSS based editor's deploy panel.
const editorHtml = `<!doctype html>
<div class="pane-header" role="button">DEPLOY</div>
<a class="monaco-button monaco-text-button" role="button" id="deploy" tabindex="0">
  <span>Deploy</span> <span>(Ctrl+Shift+U)</span></a>
<textarea id="code" rows="8" cols="60">exports.handler = async () => 'hi';</textarea>`;

function route(req, res, body) {
  const host = req.headers.host.split(':')[0];
  const url = new URL(req.url, `https://${host}`);
  const reply = (status, type, content, headers = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(content);
  };

  if (host.endsWith('.console.aws.amazon.com')) {
    if (url.pathname === '/lambda/editor.html') return reply(200, 'text/html', editorHtml);
    return reply(200, 'text/html', consoleHtml(url.searchParams.get('fn') || 'my-fn', url.searchParams.has('xo')));
  }
  if (host === 'editor.fake-cdn.net') return reply(200, 'text/html', editorHtml);

  if (host === 'sts.us-east-1.amazonaws.com') {
    if (!body.includes('Action=GetCallerIdentity')) return reply(400, 'text/xml', '<Error/>');
    return reply(200, 'text/xml', `<GetCallerIdentityResponse><GetCallerIdentityResult>
      <Arn>arn:aws:iam::${ACCOUNT}:user/lambsafe</Arn><Account>${ACCOUNT}</Account>
      </GetCallerIdentityResult></GetCallerIdentityResponse>`);
  }

  if (host === 'lambda.us-east-1.amazonaws.com') {
    aws.getFunctionCalls += 1;
    const auth = req.headers.authorization || '';
    const expected = new RegExp(
      `^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/\\d{8}/us-east-1/lambda/aws4_request, ` +
        'SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$',
    );
    if (!expected.test(auth)) return reply(403, 'application/json', JSON.stringify({ message: `bad auth: ${auth}` }));
    const fn = decodeURIComponent(url.pathname.split('/').pop());
    const codeSha = aws.deployed[fn];
    if (!codeSha) {
      return reply(404, 'application/json', JSON.stringify({ Type: 'User', message: `Function not found: ${fn}` }), {
        'x-amzn-errortype': 'ResourceNotFoundException:http://internal.amazon.com/coral/com.amazonaws.awslambda/',
      });
    }
    return reply(200, 'application/json', JSON.stringify({
      Configuration: {
        FunctionName: fn,
        FunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${fn}`,
        CodeSha256: codeSha,
        CodeSize: 22,
        LastModified: '2025-01-31T09:15:00.000+0000',
        PackageType: 'Zip',
        Runtime: 'nodejs22.x',
      },
      Code: {
        RepositoryType: 'S3',
        Location: `https://awslambda-us-east-1-tasks.s3.us-east-1.amazonaws.com/snapshots/${ACCOUNT}/${fn}?v=${encodeURIComponent(codeSha)}`,
      },
    }));
  }

  if (host === 'awslambda-us-east-1-tasks.s3.us-east-1.amazonaws.com') {
    aws.zipDownloads += 1;
    return reply(200, 'application/zip', Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
  }

  reply(404, 'text/plain', `no fake for ${host}${url.pathname}`);
}

async function startFakeAws() {
  const certDir = mkdtempSync(join(tmpdir(), 'lambsafe-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fake-aws',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
  ], { stdio: 'ignore' });

  const server = https.createServer(
    { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
    (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => route(req, res, body));
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // Every CONNECT, whatever the host, is tunnelled to the fake server.
  const proxy = http.createServer((_, res) => res.writeHead(405).end());
  proxy.on('connect', (_req, client, head) => {
    const upstream = net.connect(server.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));

  return {
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    close: () => {
      proxy.close();
      server.close();
    },
  };
}

// --- Helpers ---

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

async function waitFor(fn, label, timeout = 10_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const toastText = (page) =>
  page.evaluate(() => document.querySelector('lambsafe-toast')?.shadowRoot?.querySelector('.t')?.textContent || '');

const consoleUrl = (fn, extra = '') =>
  `https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1&fn=${fn}${extra}#/functions/${fn}?tab=code`;

// --- The test ---

async function main() {
  mkdirSync(OUTPUT, { recursive: true });
  const fake = await startFakeAws();
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'lambsafe-profile-')), {
    channel: 'chromium', // the full browser; headless-shell cannot load extensions
    headless: true,
    ignoreHTTPSErrors: true,
    proxy: { server: fake.proxyUrl },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, '--ignore-certificate-errors'],
  });
  const pageErrors = [];
  context.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(`${p.url()}: ${e.message}`)));

  try {
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    console.log('Settings page');
    const options = await waitFor(
      () => context.pages().find((p) => p.url().includes('/options/options.html')),
      'settings page to open on install',
    );
    check(true, 'opens on first install');
    await options.fill('#p-name', 'e2e');
    await options.fill('#p-key', ACCESS_KEY);
    await options.fill('#p-secret', 'not-a-real-secret');
    await options.click('#p-save');
    await options.waitForSelector('#p-result.ok');
    check((await options.textContent('#p-result')).includes(ACCOUNT), 'verifies credentials with STS and learns the account');
    check((await options.textContent('#profiles')).includes('AKIA…3456'), 'lists the credentials with the key masked');
    await options.screenshot({ path: join(OUTPUT, 'settings.png'), fullPage: true });

    console.log('Editing and deploying in a same-origin editor iframe');
    const page = await context.newPage();
    await page.goto(consoleUrl('my-fn'));
    await page.waitForTimeout(1500);
    check(aws.getFunctionCalls === 0, 'only opening a function does not call AWS');

    const editor = page.frameLocator('#editor');
    await editor.locator('#code').click();
    await editor.locator('#code').pressSequentially('// edit', { delay: 20 });
    await waitFor(() => aws.zipDownloads === 1, 'first backup');
    await waitFor(async () => (await toastText(page)).includes('Saved deployed version of my-fn'), 'saved toast');
    check(aws.getFunctionCalls === 1, 'starting to edit downloads the deployed version once');
    await page.screenshot({ path: join(OUTPUT, 'console-saved.png') });

    await editor.locator('#code').pressSequentially(' more', { delay: 20 });
    await page.waitForTimeout(3500);
    await editor.locator('#code').pressSequentially(' typing', { delay: 20 });
    await page.waitForTimeout(800);
    check(aws.getFunctionCalls === 1 && aws.zipDownloads === 1, 'more typing neither calls AWS nor downloads');

    await editor.locator('#deploy').click();
    await waitFor(async () => (await toastText(page)).includes('already backed up'), '"already backed up" toast');
    check(aws.getFunctionCalls === 2 && aws.zipDownloads === 1, 'Deploy re-checks AWS but downloads nothing for a saved version');

    aws.deployed['my-fn'] = sha('B'); // that deploy went live
    await page.waitForTimeout(1600);
    await editor.locator('#code').press('Control+Shift+U');
    await waitFor(() => aws.zipDownloads === 2, 'backup of the new version');
    check(true, 'Ctrl+Shift+U counts as Deploy and saves the newly live version first');

    await page.waitForTimeout(1600);
    await editor.locator('#deploy').click();
    await waitFor(() => aws.getFunctionCalls === 4, 'another deploy check');
    await page.waitForTimeout(500);
    check(aws.zipDownloads === 2, 'the same version is never downloaded twice');

    const recorded = await worker.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return Object.values(all['backup:123456789012:us-east-1:my-fn']?.versions || {}).map((v) => v.filename).sort();
    });
    check(
      JSON.stringify(recorded) ===
        JSON.stringify([
          'LambSafe/123456789012/us-east-1/my-fn/my-fn_2025-01-31_09-15-00Z_41414141.zip',
          'LambSafe/123456789012/us-east-1/my-fn/my-fn_2025-01-31_09-15-00Z_42424242.zip',
        ]),
      'both versions are recorded under LambSafe/<account>/<region>/<function>/',
    );
    const completed = await worker.evaluate(async () =>
      (await chrome.downloads.search({})).filter((d) => d.state === 'complete').length,
    );
    check(completed === 2, 'Chrome reports both downloads complete');

    const tabId = await worker.evaluate(
      async () => (await chrome.tabs.query({ url: 'https://us-east-1.console.aws.amazon.com/*' }))[0].id,
    );
    check((await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)) === '✓', 'toolbar badge shows ✓');

    console.log('Cross-origin editor iframe (content script cannot run inside it)');
    const page2 = await context.newPage();
    await page2.goto(consoleUrl('other-fn', '&xo=1'));
    await page2.waitForTimeout(1200);
    await page2.frameLocator('#editor').locator('#code').click();
    await waitFor(() => aws.zipDownloads === 3, 'backup after focusing the cross-origin editor');
    check(true, 'clicking into the editor is enough to trigger the backup');

    console.log('Errors');
    const page3 = await context.newPage();
    await page3.goto(consoleUrl('missing-fn'));
    await page3.waitForTimeout(1200);
    await page3.frameLocator('#editor').locator('#deploy').click();
    await waitFor(async () => (await toastText(page3)).includes('could not back up'), 'error toast');
    check((await toastText(page3)).includes('same AWS account'), 'a missing function is explained as a likely account mismatch');
    await page3.screenshot({ path: join(OUTPUT, 'console-error.png') });

    console.log('Popup');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 560 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForSelector('#recent li');
    const recent = await popup.textContent('#recent');
    check(recent.includes('my-fn') && recent.includes('other-fn'), 'lists recent backups');
    const status = await popup.evaluate(async (id) => {
      const tab = await chrome.tabs.get(id);
      return chrome.runtime.sendMessage({ type: 'lambsafe:tab-status', tabId: id, url: tab.url });
    }, tabId);
    check(status.currentBackedUp && status.versions.length === 2, 'knows the live version of my-fn is backed up');
    check(status.target.accountId === ACCOUNT && status.target.accountSource === 'page', 'read the account ID from the page');
    await popup.screenshot({ path: join(OUTPUT, 'popup.png') });

    // Open the popup as if the console tab were the active tab.
    const tabUrl = (await worker.evaluate((id) => chrome.tabs.get(id), tabId)).url;
    const popupForTab = await context.newPage();
    await popupForTab.setViewportSize({ width: 380, height: 560 });
    await popupForTab.addInitScript(({ id, url }) => {
      chrome.tabs.query = async () => [{ id, url }];
    }, { id: tabId, url: tabUrl });
    await popupForTab.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popupForTab.waitForSelector('#versions li');
    check((await popupForTab.textContent('#fn-status')).includes('is backed up'), 'popup shows the live version is backed up');
    check((await popupForTab.locator('#versions li').count()) === 2, 'popup lists both saved versions of my-fn');
    await popupForTab.click('#backup-now');
    await popupForTab.waitForFunction(() => document.querySelector('#fn-status').textContent.includes('Already backed up'));
    check(aws.zipDownloads === 3, '"Back up now" on a saved version downloads nothing');
    await popupForTab.screenshot({ path: join(OUTPUT, 'popup-function.png') });

    check(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
    console.log(`\n${passed} checks passed. Screenshots in ${OUTPUT}`);
  } finally {
    await context.close();
    fake.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
