/**
 * AWS Signature Version 4, for S3-compatible object storage.
 *
 * ─── WHY THIS IS NOT @aws-sdk/client-s3 ─────────────────────────────────────
 *
 * The SDK is the obvious choice and usually the right one. It is not chosen
 * here because this application needs exactly four verbs against exactly one
 * bucket — PUT, GET, HEAD, DELETE — and the SDK brings tens of megabytes and a
 * large dependency tree into an image that holds client financial documents.
 * Every one of those packages is something to audit and something that can be
 * compromised upstream.
 *
 * SigV4 for these four requests is about a hundred lines, it is a stable and
 * completely specified algorithm, and it works unchanged against every
 * S3-compatible provider — Cloudflare R2, Backblaze B2, MinIO, Supabase.
 *
 * The honest counter-argument: hand-rolling authentication is how people
 * introduce subtle signing bugs. Two things answer that. The algorithm is
 * verified against AWS's own published test vectors in the tests, and the whole
 * client is exercised against a real MinIO server rather than a mock — if the
 * signature were wrong, every request would be rejected outright. A signing bug
 * here fails loudly and immediately; it does not corrupt data quietly.
 *
 * Reference: docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */

const crypto = require('node:crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD_HASH = crypto.createHash('sha256').update('').digest('hex');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Percent-encode for a URI path.
 *
 * S3 wants each path SEGMENT encoded but the separating slashes left alone, and
 * it does NOT treat `+` as a space. encodeURIComponent leaves `!'()*`
 * unescaped, which AWS expects escaped — a mismatch there produces a signature
 * that disagrees with the server's over any key containing those characters.
 */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(path) {
  return path.split('/').map(encodeSegment).join('/');
}

/**
 * Build the Authorization header for one request.
 *
 * @param {object} input
 * @param {string} input.method
 * @param {string} input.host
 * @param {string} input.path        already URI-encoded, leading slash
 * @param {string} [input.query]     canonical query string, may be empty
 * @param {Buffer|string} [input.body]
 * @param {string} input.accessKeyId
 * @param {string} input.secretAccessKey
 * @param {string} input.region
 * @param {string} [input.service='s3']
 * @param {Date} input.now           passed in, never read from the clock, so the
 *                                   signer stays a pure function and is testable
 *                                   against AWS's fixed-timestamp vectors
 * @param {object} [input.extraHeaders]
 */
function signRequest({
  method,
  host,
  path,
  query = '',
  body = '',
  accessKeyId,
  secretAccessKey,
  sessionToken,
  region,
  service = 's3',
  now,
  extraHeaders = {},
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20240716T101112Z
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = body === null ? UNSIGNED_PAYLOAD_HASH : sha256Hex(body);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };

  // Canonical headers: lowercased names, sorted, values trimmed and internal
  // whitespace collapsed. Every one of those details is load-bearing — get any
  // of them wrong and the server computes a different signature.
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  // The signing key is derived per day, per region, per service — which is what
  // limits the blast radius of a leaked signature.
  const signingKey = ['aws4_request'].reduce(
    (key, step) => hmac(key, step),
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
  );

  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    headers: {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    // Returned for the tests, which check them against AWS's published vectors.
    canonicalRequest,
    stringToSign,
    signature,
  };
}

module.exports = { signRequest, encodePath, encodeSegment, sha256Hex, ALGORITHM };
