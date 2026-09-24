import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeAwsError, getCallerIdentity, getFunction } from '../extension/lib/aws.js';

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };

function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      text: async () => body,
    };
  };
  return { calls, fetchImpl };
}

test('getFunction calls the regional Lambda endpoint with a signed request', async () => {
  const { calls, fetchImpl } = fakeFetch(200, JSON.stringify({ Configuration: { CodeSha256: 'x' } }));
  const result = await getFunction('eu-west-1', 'my-fn', credentials, { fetchImpl });
  assert.equal(result.Configuration.CodeSha256, 'x');
  assert.equal(calls[0].url, 'https://lambda.eu-west-1.amazonaws.com/2015-03-31/functions/my-fn');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/lambda\//);
});

test('uses the .com.cn domain in China regions', async () => {
  const { calls, fetchImpl } = fakeFetch(200, '{}');
  await getFunction('cn-north-1', 'f', credentials, { fetchImpl });
  assert.equal(calls[0].url, 'https://lambda.cn-north-1.amazonaws.com.cn/2015-03-31/functions/f');
});

test('Lambda errors carry the AWS error code', async () => {
  const { fetchImpl } = fakeFetch(404, JSON.stringify({ Type: 'User', message: 'Function not found: arn:...' }), {
    'x-amzn-errortype': 'ResourceNotFoundException:http://internal.amazon.com/coral/com.amazonaws.awslambda/',
  });
  await assert.rejects(getFunction('us-east-1', 'nope', credentials, { fetchImpl }), (err) => {
    assert.equal(err.code, 'ResourceNotFoundException');
    assert.equal(err.status, 404);
    assert.match(describeAwsError(err), /same AWS account/);
    return true;
  });
});

test('getCallerIdentity reads the account from the STS XML response', async () => {
  const xml = `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
    <GetCallerIdentityResult>
      <Arn>arn:aws:iam::123456789012:user/lambsafe</Arn>
      <UserId>AIDAEXAMPLE</UserId>
      <Account>123456789012</Account>
    </GetCallerIdentityResult>
  </GetCallerIdentityResponse>`;
  const { calls, fetchImpl } = fakeFetch(200, xml);
  assert.deepEqual(await getCallerIdentity(credentials, { fetchImpl }), {
    account: '123456789012',
    arn: 'arn:aws:iam::123456789012:user/lambsafe',
  });
  assert.equal(calls[0].init.body, 'Action=GetCallerIdentity&Version=2011-06-15');
});

test('STS XML errors carry the AWS error code', async () => {
  const xml = `<ErrorResponse><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code>
    <Message>The security token included in the request is invalid.</Message></Error></ErrorResponse>`;
  const { fetchImpl } = fakeFetch(403, xml);
  await assert.rejects(getCallerIdentity(credentials, { fetchImpl }), (err) => {
    assert.equal(err.code, 'InvalidClientTokenId');
    assert.match(describeAwsError(err), /access key/);
    return true;
  });
});

test('network failures become readable errors', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(getFunction('us-east-1', 'f', credentials, { fetchImpl }), { code: 'NetworkError' });
});

test('clock skew gets a specific hint', () => {
  const err = { code: 'InvalidSignatureException', message: 'Signature expired: 20250101T000000Z is now earlier than ...' };
  assert.match(describeAwsError(err), /clock/);
});
