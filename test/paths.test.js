import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildBackupPath, formatDeployedAt, sanitizeFolder, shaToHex } from '../extension/lib/paths.js';

const sha = Buffer.from('abcdef0123456789abcdef0123456789', 'hex').toString('base64');

test('builds an organised, sortable backup path', () => {
  assert.equal(
    buildBackupPath({
      folder: 'LambSafe',
      accountId: '123456789012',
      region: 'us-east-1',
      functionName: 'my-fn',
      lastModified: '2024-10-22T17:32:15.123+0000',
      sha,
    }),
    'LambSafe/123456789012/us-east-1/my-fn/my-fn_2024-10-22_17-32-15Z_abcdef01.zip',
  );
});

test('converts Lambda dates with a +hhmm offset to UTC', () => {
  assert.equal(formatDeployedAt('2024-10-22T19:32:15.000+0200'), '2024-10-22_17-32-15Z');
  assert.equal(formatDeployedAt('garbage'), 'unknown-date');
  assert.equal(formatDeployedAt(null), 'unknown-date');
});

test('keeps the download folder inside Downloads', () => {
  assert.equal(sanitizeFolder('../../etc'), 'etc');
  assert.equal(sanitizeFolder('/abs/path/'), 'abs/path');
  assert.equal(sanitizeFolder('C:\\Backups\\Lambda'), 'C_/Backups/Lambda');
  assert.equal(sanitizeFolder('a/./b'), 'a/b');
  assert.equal(sanitizeFolder('bad<>name'), 'bad__name');
  assert.equal(sanitizeFolder(''), '');
  assert.match(
    buildBackupPath({ folder: '..', accountId: '1', region: 'r', functionName: 'f', lastModified: null, sha }),
    /^LambSafe\//,
  );
});

test('turns base64 CodeSha256 into hex', () => {
  assert.equal(shaToHex(sha), 'abcdef0123456789abcdef0123456789');
  assert.equal(shaToHex('not base64!'), 'not base64!');
});
