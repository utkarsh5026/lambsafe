// The two AWS calls LambSafe needs: Lambda GetFunction (to learn the deployed
// code's hash and get a download link) and STS GetCallerIdentity (to learn
// which account a set of credentials belongs to).

import { signRequest } from './sigv4.js';

export class AwsError extends Error {
  /**
   * @param {string} code AWS error code, e.g. ResourceNotFoundException
   * @param {string} message
   * @param {number} [status] HTTP status
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'AwsError';
    this.code = code;
    this.status = status;
  }
}

function domainFor(region) {
  return region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
}

function parseError(status, headerType, text) {
  let code = headerType ? headerType.split(':')[0] : '';
  let message = '';
  try {
    const json = JSON.parse(text);
    code ||= String(json.__type || json.code || json.Code || '').split('#').pop();
    message = json.message || json.Message || '';
  } catch {
    code ||= text.match(/<Code>([^<]+)<\/Code>/)?.[1] || '';
    message = text.match(/<Message>([^<]+)<\/Message>/)?.[1] || '';
  }
  return new AwsError(code || `HTTP${status}`, message || `AWS returned HTTP ${status}`, status);
}

async function awsRequest({ method, url, body = '', headers = {}, region, service, credentials, fetchImpl }) {
  const signed = await signRequest({ method, url, body, headers, region, service, credentials });
  let res;
  try {
    res = await (fetchImpl || fetch)(url, {
      method,
      headers: signed,
      body: body || undefined,
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (err) {
    throw new AwsError('NetworkError', `Could not reach AWS: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw parseError(res.status, res.headers.get('x-amzn-errortype'), text);
  return text;
}

/**
 * Lambda GetFunction for the unpublished ($LATEST) code.
 * https://docs.aws.amazon.com/lambda/latest/api/API_GetFunction.html
 */
export async function getFunction(region, functionName, credentials, { fetchImpl } = {}) {
  const url =
    `https://lambda.${region}.${domainFor(region)}` +
    `/2015-03-31/functions/${encodeURIComponent(functionName)}`;
  const text = await awsRequest({
    method: 'GET',
    url,
    region,
    service: 'lambda',
    credentials,
    fetchImpl,
  });
  return JSON.parse(text);
}

/**
 * STS GetCallerIdentity. Needs no IAM permissions, so it is a safe way to
 * validate credentials and learn their account ID.
 */
export async function getCallerIdentity(credentials, { region = 'us-east-1', fetchImpl } = {}) {
  const text = await awsRequest({
    method: 'POST',
    url: `https://sts.${region}.${domainFor(region)}/`,
    body: 'Action=GetCallerIdentity&Version=2011-06-15',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    region,
    service: 'sts',
    credentials,
    fetchImpl,
  });
  const account = text.match(/<Account>(\d{12})<\/Account>/)?.[1];
  const arn = text.match(/<Arn>([^<]+)<\/Arn>/)?.[1];
  if (!account) throw new AwsError('BadResponse', 'STS response did not include an account ID');
  return { account, arn };
}

/** Turns an AWS error into a sentence a person can act on. */
export function describeAwsError(err) {
  const code = err?.code || '';
  const raw = err?.message || String(err);
  switch (code) {
    case 'ResourceNotFoundException':
      return 'Function not found with these credentials. Check that they belong to the same AWS account as the console tab.';
    case 'AccessDeniedException':
    case 'AccessDenied':
      return 'These credentials are not allowed to call lambda:GetFunction on this function.';
    case 'UnrecognizedClientException':
    case 'InvalidClientTokenId':
      return 'AWS did not recognise the access key. Update your credentials in LambSafe settings.';
    case 'ExpiredTokenException':
    case 'ExpiredToken':
      return 'The session token has expired. Paste fresh credentials in LambSafe settings.';
    case 'InvalidSignatureException':
    case 'SignatureDoesNotMatch':
      return /expired|future/i.test(raw)
        ? 'AWS rejected the request timestamp. Check that your computer clock is correct.'
        : 'AWS rejected the request signature. Check the secret access key in LambSafe settings.';
    case 'TooManyRequestsException':
    case 'Throttling':
      return 'AWS is throttling requests. LambSafe will try again on your next change.';
    case 'NetworkError':
      return raw;
    default:
      return raw;
  }
}
