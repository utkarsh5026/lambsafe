import assert from 'node:assert/strict';
import { test } from 'node:test';

import { signRequest, toAmzDate } from '../extension/lib/sigv4.js';

const date = new Date('2025-01-31T09:15:00Z');
const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

// Expected values were produced with botocore's SigV4Auth (the signer inside
// the official AWS SDKs for Python) for the same inputs and timestamp.

test('signs Lambda GetFunction with a session token like botocore', async () => {
  const headers = await signRequest({
    method: 'GET',
    url: 'https://lambda.eu-west-1.amazonaws.com/2015-03-31/functions/my-function_v2',
    region: 'eu-west-1',
    service: 'lambda',
    credentials: { ...credentials, sessionToken: 'FQoGZXIvYXdzEXAMPLE//token+/=' },
    date,
  });
  assert.equal(headers['x-amz-date'], '20250131T091500Z');
  assert.equal(headers['x-amz-security-token'], 'FQoGZXIvYXdzEXAMPLE//token+/=');
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20250131/eu-west-1/lambda/aws4_request, ' +
      'SignedHeaders=host;x-amz-date;x-amz-security-token, ' +
      'Signature=837debb2e02481f10bb8e4bd83295f8616f400ae4f6728bb5dbfc6fe0227e5c1',
  );
  assert.equal(headers.host, undefined, 'fetch() refuses a host header');
});

test('signs an STS POST with a form body like botocore', async () => {
  const headers = await signRequest({
    method: 'POST',
    url: 'https://sts.us-east-1.amazonaws.com/',
    body: 'Action=GetCallerIdentity&Version=2011-06-15',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    region: 'us-east-1',
    service: 'sts',
    credentials,
    date,
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20250131/us-east-1/sts/aws4_request, ' +
      'SignedHeaders=content-type;host;x-amz-date, ' +
      'Signature=2267e2ff3c5400a1d66c23240eed06528de726f45083816968ca3ffcdd43bc77',
  );
});

test('double-encodes path segments and sorts the query string like botocore', async () => {
  const headers = await signRequest({
    method: 'GET',
    url:
      'https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/' +
      'arn%3Aaws%3Alambda%3Aus-east-1%3A123456789012%3Afunction%3Afoo?Qualifier=%24LATEST&b=2&a=1',
    region: 'us-east-1',
    service: 'lambda',
    credentials,
    date,
  });
  assert.match(
    headers.authorization,
    /Signature=3d3e00d674a2f6eb4754cc155db14940fb293aa61ecfd065056af625ac82e0f3$/,
  );
});

test('passes the AWS SigV4 test suite "get-vanilla" case', async () => {
  const headers = await signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    region: 'us-east-1',
    service: 'service',
    credentials,
    date: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('formats the SigV4 timestamp', () => {
  assert.equal(toAmzDate(new Date('2015-08-30T12:36:00.123Z')), '20150830T123600Z');
});
