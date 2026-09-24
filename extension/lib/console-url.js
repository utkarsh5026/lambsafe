// Works out which Lambda function a console tab is showing, from its URL.
//
// Examples:
//   https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/my-fn?tab=code
//   https://123456789012-abcd1234.us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/my-fn
//   https://console.aws.amazon.com/lambda/home?region=eu-west-1#/functions/my-fn/versions/3

const CONSOLE_HOST = /(^|\.)console\.aws\.amazon\.com$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const FUNCTION_ARN = /^arn:aws[\w-]*:lambda:([\w-]+):(\d{12}):function:([A-Za-z0-9_-]+)$/;
// Multi-session console URLs start with "<account id>-<session id>.".
const MULTI_SESSION_HOST = /^(\d{12})-[a-z0-9]+\./i;

/**
 * @typedef {object} LambdaTarget
 * @property {string} region
 * @property {string} functionName
 * @property {string|null} accountId  Known only from multi-session URLs or ARNs.
 * @property {string|null} qualifier  Version or alias being viewed, if any.
 * @property {boolean} editable       Only $LATEST can be changed in the console.
 */

/**
 * @param {string} href
 * @returns {LambdaTarget|null}
 */
export function parseLambdaConsoleUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !CONSOLE_HOST.test(url.hostname)) return null;
  if (!url.pathname.startsWith('/lambda')) return null;

  const hash = url.hash.replace(/^#/, '');
  const hashPath = hash.split('?')[0];
  const match = hashPath.match(/^\/functions\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;

  let functionName = safeDecode(match[1]);
  let accountId = url.hostname.match(MULTI_SESSION_HOST)?.[1] ?? null;
  let region = url.searchParams.get('region') || regionFromHost(url.hostname);

  const arn = functionName.match(FUNCTION_ARN);
  if (arn) {
    [, region, accountId, functionName] = arn;
  }
  if (!region || !REGION.test(region) || !FUNCTION_NAME.test(functionName)) return null;

  let qualifier = null;
  const sub = (match[2] || '').match(/^(versions|aliases)\/([^/]+)/);
  if (sub) {
    const value = safeDecode(sub[2]);
    if (value !== '$LATEST') qualifier = value;
  }

  return { region, functionName, accountId, qualifier, editable: qualifier === null };
}

function regionFromHost(hostname) {
  const labels = hostname.split('.');
  const idx = labels.indexOf('console');
  const candidate = idx > 0 ? labels[idx - 1] : '';
  return REGION.test(candidate) ? candidate : null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
