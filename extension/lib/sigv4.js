// Minimal AWS Signature Version 4 signer built on WebCrypto, so the extension
// can call AWS APIs without bundling the AWS SDK.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

const encoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key, message) {
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

/** RFC 3986 encoding, which is what SigV4 expects (encodeURIComponent leaves !'()* alone). */
export function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUri(pathname, service) {
  if (!pathname) return '/';
  // S3 paths are encoded once; every other service encodes each segment twice.
  // `pathname` from URL is already encoded once, so we encode it again here.
  if (service === 's3') return pathname;
  return pathname
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Formats a Date as the SigV4 timestamp, e.g. 20150830T123600Z. */
export function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Signs a request and returns the headers to send with it.
 * The `host` header is used for signing but not returned, because fetch()
 * refuses to let callers set it.
 *
 * @param {object} req
 * @param {string} req.method
 * @param {string} req.url
 * @param {Record<string, string>} [req.headers]
 * @param {string} [req.body]
 * @param {string} req.region
 * @param {string} req.service
 * @param {{accessKeyId: string, secretAccessKey: string, sessionToken?: string}} req.credentials
 * @param {Date} [req.date]
 * @returns {Promise<Record<string, string>>}
 */
export async function signRequest({
  method,
  url,
  headers = {},
  body = '',
  region,
  service,
  credentials,
  date = new Date(),
}) {
  const parsed = new URL(url);
  const amzDate = toAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);

  const signed = {};
  for (const [name, value] of Object.entries(headers)) signed[name.toLowerCase()] = String(value);
  signed.host = parsed.host;
  signed['x-amz-date'] = amzDate;
  if (credentials.sessionToken) signed['x-amz-security-token'] = credentials.sessionToken;

  const headerNames = Object.keys(signed).sort();
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${signed[name].trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = headerNames.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(parsed.pathname, service),
    canonicalQuery(parsed.searchParams),
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(body),
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const { host: _host, ...out } = signed;
  out.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
