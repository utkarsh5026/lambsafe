import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLambdaConsoleUrl } from '../extension/lib/console-url.js';

const base = 'https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1';

test('reads region and function from a regular console URL', () => {
  assert.deepEqual(parseLambdaConsoleUrl(`${base}#/functions/my-fn?tab=code`), {
    region: 'us-east-1',
    functionName: 'my-fn',
    accountId: null,
    qualifier: null,
    editable: true,
  });
});

test('reads the account ID from multi-session console URLs', () => {
  const target = parseLambdaConsoleUrl(
    'https://123456789012-abcd1234.eu-west-2.console.aws.amazon.com/lambda/home?region=eu-west-2#/functions/api_handler',
  );
  assert.equal(target.accountId, '123456789012');
  assert.equal(target.region, 'eu-west-2');
  assert.equal(target.functionName, 'api_handler');
});

test('falls back to the region in the host name', () => {
  const target = parseLambdaConsoleUrl('https://ap-southeast-2.console.aws.amazon.com/lambda/home#/functions/x');
  assert.equal(target.region, 'ap-southeast-2');
});

test('the region query parameter wins over the host', () => {
  const target = parseLambdaConsoleUrl('https://console.aws.amazon.com/lambda/home?region=us-gov-west-1#/functions/x');
  assert.equal(target.region, 'us-gov-west-1');
});

test('published versions and aliases are not editable, $LATEST is', () => {
  assert.equal(parseLambdaConsoleUrl(`${base}#/functions/my-fn/versions/3?tab=code`).editable, false);
  assert.equal(parseLambdaConsoleUrl(`${base}#/functions/my-fn/aliases/prod`).qualifier, 'prod');
  assert.equal(parseLambdaConsoleUrl(`${base}#/functions/my-fn/versions/$LATEST?tab=code`).editable, true);
  assert.equal(parseLambdaConsoleUrl(`${base}#/functions/my-fn/versions/%24LATEST`).editable, true);
});

test('accepts a function ARN in the route', () => {
  const target = parseLambdaConsoleUrl(
    `${base}#/functions/${encodeURIComponent('arn:aws:lambda:eu-central-1:210987654321:function:worker')}`,
  );
  assert.equal(target.functionName, 'worker');
  assert.equal(target.region, 'eu-central-1');
  assert.equal(target.accountId, '210987654321');
});

test('ignores pages that are not a single function', () => {
  for (const url of [
    `${base}#/functions`,
    `${base}#/functions?fo=and`,
    `${base}#/layers/my-layer`,
    'https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#/functions/x',
    'https://evil.example.com/lambda/home?region=us-east-1#/functions/x',
    'https://console.aws.amazon.com.evil.example/lambda/home?region=us-east-1#/functions/x',
    'http://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/x',
    `${base}#/functions/not%20valid`,
    'https://console.aws.amazon.com/lambda/home#/functions/no-region',
    'not a url',
  ]) {
    assert.equal(parseLambdaConsoleUrl(url), null, url);
  }
});
