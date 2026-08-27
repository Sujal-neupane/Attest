/**
 * The S3 backend, against a REAL S3 server.
 *
 * MinIO speaks the genuine S3 API and verifies every signature the way AWS
 * does. That is the whole point of testing here rather than against a mock: a
 * mock would only confirm that the mock agrees with my reading of the spec,
 * which is exactly the thing in doubt when the signing is hand-rolled.
 *
 * Skipped when MinIO is not running, so `npm test` stays clean on a machine
 * with nothing set up:
 *
 *   docker run -d --name attest-minio -p 9000:9000 \
 *     -e MINIO_ROOT_USER=attestminio -e MINIO_ROOT_PASSWORD=attestminio123 \
 *     quay.io/minio/minio:latest server /data
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createS3Storage, S3Error } = require('../src/services/storage/s3');
const storage = require('../src/services/storage');
const { signRequest } = require('../src/services/storage/sigv4');

const ENDPOINT = process.env.S3_TEST_ENDPOINT || 'http://127.0.0.1:9000';
const CONFIG = {
  bucket: 'attest-test',
  endpoint: ENDPOINT,
  region: 'us-east-1',
  accessKeyId: process.env.S3_TEST_KEY || 'attestminio',
  secretAccessKey: process.env.S3_TEST_SECRET || 'attestminio123',
  // MinIO serves path-style; a virtual host would need DNS for the bucket.
  forcePathStyle: true,
};

// Probed synchronously, like the database helper does: the availability check
// has to complete before test() calls are registered, and top-level await is
// not available in CommonJS.
let available = false;
try {
  require('node:child_process').execFileSync(
    'curl',
    ['-sf', '-m', '2', '-o', '/dev/null', `${ENDPOINT}/minio/health/live`],
    { stdio: 'pipe' },
  );
  available = true;
} catch {
  available = false;
}

if (!available) {
  test('S3 tests skipped — no MinIO reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

const KEY = crypto.randomBytes(storage.KEY_BYTES);
let store;

before(async () => {
  if (!available) return;

  // Create the bucket, signed with the same code under test — so even the
  // setup step is evidence the signature is right.
  const url = `${ENDPOINT}/${CONFIG.bucket}`;
  const signed = signRequest({
    method: 'PUT',
    host: new URL(ENDPOINT).host,
    path: `/${CONFIG.bucket}`,
    body: '',
    accessKeyId: CONFIG.accessKeyId,
    secretAccessKey: CONFIG.secretAccessKey,
    region: CONFIG.region,
    now: new Date(),
  });
  await fetch(url, { method: 'PUT', headers: signed.headers }).catch(() => {});

  store = createS3Storage(CONFIG, {
    encrypt: storage._internals.encrypt,
    decrypt: storage._internals.decrypt,
    key: KEY,
  });
});

after(() => {});

const uniqueKey = () => `firm-${crypto.randomUUID()}/period/doc`;

run('a document round-trips through real S3', async () => {
  const key = uniqueKey();
  const contents = Buffer.from('Date,Narration,Debit\n16/07/2024,PAYMENT,500\n');

  const result = await store.put(key, contents);
  assert.ok(result.byteSize > contents.length, 'the stored object carries an IV and auth tag');

  assert.deepEqual(await store.get(key), contents);
});

run('what is stored in the bucket is NOT the plaintext', async () => {
  const key = uniqueKey();
  const secret = 'SHARMA TRADERS CONFIDENTIAL BALANCE 1,00,000';
  await store.put(key, Buffer.from(secret));

  // Fetched raw, bypassing our decrypt, to see what the provider actually holds.
  const signed = signRequest({
    method: 'GET',
    host: new URL(ENDPOINT).host,
    path: `/${CONFIG.bucket}/${key}`,
    body: '',
    accessKeyId: CONFIG.accessKeyId,
    secretAccessKey: CONFIG.secretAccessKey,
    region: CONFIG.region,
    now: new Date(),
  });
  const raw = Buffer.from(
    await (await fetch(`${ENDPOINT}/${CONFIG.bucket}/${key}`, { headers: signed.headers })).arrayBuffer(),
  );

  // The company renting us the bucket must not be able to read a client's
  // bank statement. Server-side encryption alone would not achieve this —
  // they hold those keys.
  assert.ok(!raw.includes(Buffer.from(secret)), 'the provider must hold ciphertext only');
  assert.ok(!raw.includes(Buffer.from('SHARMA')), 'not even partially');
});

run('an object altered in the bucket fails its integrity check', async () => {
  const key = uniqueKey();
  await store.put(key, Buffer.from('Date,Amount\n16/07/2024,500\n'));

  // Overwrite with tampered ciphertext, the way someone with bucket access
  // could.
  const original = await rawGet(key);
  original[original.length - 5] ^= 0xff;
  await rawPut(key, original);

  await assert.rejects(
    () => store.get(key),
    (err) => /integrity check/.test(err.message),
    'tampered ciphertext must not be parsed into transactions',
  );
});

run('a missing object is reported clearly, not as a crash', async () => {
  await assert.rejects(
    () => store.get(uniqueKey()),
    (err) => err instanceof S3Error && err.status === 404,
  );
  assert.equal(await store.exists(uniqueKey()), false);
});

run('exists() distinguishes present from absent', async () => {
  const key = uniqueKey();
  assert.equal(await store.exists(key), false);
  await store.put(key, Buffer.from('x'));
  assert.equal(await store.exists(key), true);
});

run('a wrong secret is rejected by the server, not by us', async () => {
  const wrong = createS3Storage(
    { ...CONFIG, secretAccessKey: 'not-the-right-secret' },
    { encrypt: storage._internals.encrypt, decrypt: storage._internals.decrypt, key: KEY },
  );

  // Proof the signature is genuinely being verified: a bad secret produces a
  // 403 from MinIO. If signing were broken in a way that ignored the secret,
  // this would pass and everything else would too.
  await assert.rejects(
    () => wrong.put(uniqueKey(), Buffer.from('x')),
    (err) => err instanceof S3Error && err.status === 403,
  );
});

run('a document written with one key cannot be read with another', async () => {
  const key = uniqueKey();
  await store.put(key, Buffer.from('client financials'));

  const other = createS3Storage(CONFIG, {
    encrypt: storage._internals.encrypt,
    decrypt: storage._internals.decrypt,
    key: crypto.randomBytes(storage.KEY_BYTES),
  });

  await assert.rejects(() => other.get(key), /integrity check/);
});

run('a traversing storage key is refused before it reaches the wire', async () => {
  for (const bad of ['../escape', 'a/../../escape', '/absolute']) {
    await assert.rejects(() => store.get(bad), S3Error, `should refuse ${bad}`);
  }
});

run('missing configuration fails loudly at construction, not at first upload', () => {
  for (const missing of ['bucket', 'endpoint', 'region', 'accessKeyId', 'secretAccessKey']) {
    assert.throws(
      () => createS3Storage({ ...CONFIG, [missing]: undefined }, {
        encrypt: storage._internals.encrypt,
        decrypt: storage._internals.decrypt,
        key: KEY,
      }),
      new RegExp(missing),
    );
  }
});

run('remove() deletes, and is idempotent', async () => {
  const key = uniqueKey();
  await store.put(key, Buffer.from('x'));
  assert.equal(await store.remove(key), true);
  assert.equal(await store.exists(key), false);
  // Deleting something already gone is not an error worth propagating.
  assert.equal(await store.remove(key), true);
});

// --- helpers that talk to MinIO directly, to inspect what it really holds ----

async function rawGet(key) {
  const signed = signRequest({
    method: 'GET',
    host: new URL(ENDPOINT).host,
    path: `/${CONFIG.bucket}/${key}`,
    body: '',
    accessKeyId: CONFIG.accessKeyId,
    secretAccessKey: CONFIG.secretAccessKey,
    region: CONFIG.region,
    now: new Date(),
  });
  const res = await fetch(`${ENDPOINT}/${CONFIG.bucket}/${key}`, { headers: signed.headers });
  return Buffer.from(await res.arrayBuffer());
}

async function rawPut(key, body) {
  const signed = signRequest({
    method: 'PUT',
    host: new URL(ENDPOINT).host,
    path: `/${CONFIG.bucket}/${key}`,
    body,
    accessKeyId: CONFIG.accessKeyId,
    secretAccessKey: CONFIG.secretAccessKey,
    region: CONFIG.region,
    now: new Date(),
  });
  await fetch(`${ENDPOINT}/${CONFIG.bucket}/${key}`, {
    method: 'PUT',
    headers: signed.headers,
    body,
  });
}
