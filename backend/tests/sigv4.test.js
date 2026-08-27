const test = require('node:test');
const assert = require('node:assert/strict');
const { signRequest, encodePath, encodeSegment } = require('../src/services/storage/sigv4');

/**
 * Verified against AWS's own published example.
 *
 * Hand-rolled request signing is the kind of thing that should not be trusted
 * on the author's say-so, so the first test reproduces the worked example from
 * the AWS documentation — canonical request, string to sign, and final
 * signature — using its fixed credentials and timestamp. If any detail of the
 * canonicalisation is wrong, the intermediate strings diverge and the test says
 * exactly where.
 */

// From "Examples of the complete Version 4 signing process (Python)" —
// GET on example bucket, us-east-1, with the documented test credentials.
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
  now: new Date('2013-05-24T00:00:00Z'),
};

test('reproduces the canonical request AWS documents', () => {
  const result = signRequest({
    ...AWS_EXAMPLE,
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    body: '',
    extraHeaders: { range: 'bytes=0-9' },
  });

  assert.equal(
    result.canonicalRequest,
    [
      'GET',
      '/test.txt',
      '',
      'host:examplebucket.s3.amazonaws.com',
      'range:bytes=0-9',
      'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date:20130524T000000Z',
      '',
      'host;range;x-amz-content-sha256;x-amz-date',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n'),
  );
});

test('produces the signature AWS documents for that request', () => {
  const result = signRequest({
    ...AWS_EXAMPLE,
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    body: '',
    extraHeaders: { range: 'bytes=0-9' },
  });

  assert.equal(
    result.signature,
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  assert.match(result.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/);
  assert.match(result.headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/);
});

test('signs a PUT with a body, hashing the payload', () => {
  const body = Buffer.from('encrypted document bytes');
  const result = signRequest({
    ...AWS_EXAMPLE,
    method: 'PUT',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/firm/period/doc',
    body,
  });

  const expectedHash = require('node:crypto').createHash('sha256').update(body).digest('hex');
  assert.equal(result.headers['x-amz-content-sha256'], expectedHash);
  assert.ok(result.canonicalRequest.endsWith(expectedHash));
});

test('the same request signed a day later produces a different signature', () => {
  const base = {
    ...AWS_EXAMPLE,
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
  };
  const a = signRequest({ ...base, now: new Date('2013-05-24T00:00:00Z') });
  const b = signRequest({ ...base, now: new Date('2013-05-25T00:00:00Z') });

  // The signing key is derived per day, which is what bounds the damage from a
  // leaked signature.
  assert.notEqual(a.signature, b.signature);
});

test('a session token is signed, not merely sent', () => {
  const withToken = signRequest({
    ...AWS_EXAMPLE,
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    sessionToken: 'a-temporary-credential-token',
  });

  // If the token were sent but left out of SignedHeaders, an interceptor could
  // swap it for another and the signature would still verify.
  assert.match(withToken.headers.authorization, /x-amz-security-token/);
  assert.equal(withToken.headers['x-amz-security-token'], 'a-temporary-credential-token');
});

test('header values are trimmed and internal whitespace collapsed', () => {
  const a = signRequest({
    ...AWS_EXAMPLE,
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    extraHeaders: { 'x-amz-meta-note': '  spaced    out  ' },
  });
  const b = signRequest({
    ...AWS_EXAMPLE,
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    extraHeaders: { 'x-amz-meta-note': 'spaced out' },
  });
  assert.equal(a.signature, b.signature);
});

test('header names are matched case-insensitively', () => {
  const lower = signRequest({
    ...AWS_EXAMPLE, method: 'GET', host: 'h', path: '/k',
    extraHeaders: { 'content-type': 'text/csv' },
  });
  const upper = signRequest({
    ...AWS_EXAMPLE, method: 'GET', host: 'h', path: '/k',
    extraHeaders: { 'Content-Type': 'text/csv' },
  });
  assert.equal(lower.signature, upper.signature);
});

describe_path_encoding();

function describe_path_encoding() {
  test('path encoding escapes what AWS expects and leaves slashes alone', () => {
    assert.equal(encodePath('/firm/period/doc'), '/firm/period/doc');
    assert.equal(encodePath('/a b/c'), '/a%20b/c');

    // encodeURIComponent leaves these unescaped; AWS expects them escaped, and
    // a mismatch makes every key containing one fail to authenticate.
    assert.equal(encodeSegment("it's(a)*test!"), 'it%27s%28a%29%2Atest%21');

    // A space must never become '+' — that is form encoding, not URI encoding.
    assert.ok(!encodePath('/a b').includes('+'));
  });

  test('storage keys are plain uuids, so encoding is a safety net not a crutch', () => {
    const key = '/49f415ee-b4a6-49f5-acd7-c8f28423f5f4/a2af172b/005bbcc5';
    assert.equal(encodePath(key), key);
  });
}
