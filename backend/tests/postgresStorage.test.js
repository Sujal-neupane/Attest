/**
 * Document storage in Postgres, against a real database.
 *
 * This backend exists so a deployment needs no object-storage account, and the
 * question it has to answer is whether it is as safe as the bucket it replaces.
 * These tests hold it to the same two promises the S3 backend makes: the stored
 * bytes are ciphertext, and one firm cannot read another's.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const testDb = require('./helpers/testDatabase');

const available = testDb.isAvailable();
const fixture = available ? testDb.setup('attest_pgstore_test', 'attest_test_pgstore') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('Postgres storage tests skipped — no database reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

const KEY = crypto.randomBytes(32);

let db;
let store;
let storage;
let firmA;
let firmB;

before(async () => {
  db = require('../src/config/db');
  storage = require('../src/services/storage');
  const { createPostgresStorage } = require('../src/services/storage/postgres');

  store = createPostgresStorage({
    encrypt: storage._internals.encrypt,
    decrypt: storage._internals.decrypt,
    key: KEY,
  });

  const makeFirm = async (name) => {
    const id = crypto.randomUUID();
    const client = await db.pool.connect();
    await client.query('SELECT set_config($1, $2, false)', ['app.current_firm_id', id]);
    await client.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [id, name]);
    client.release();
    return id;
  };

  firmA = await makeFirm('Firm A');
  firmB = await makeFirm('Firm B');
});

after(async () => {
  await db?.close().catch(() => {});
});

const keyFor = (firmId) => `${firmId}/${crypto.randomUUID()}/${crypto.randomUUID()}`;

run('a document round-trips through the database', async () => {
  const key = keyFor(firmA);
  const contents = Buffer.from('Date,Narration,Debit\n16/07/2024,PAYMENT,500\n');

  const result = await store.put(key, contents);
  assert.ok(result.byteSize > contents.length, 'the stored row carries an IV and auth tag');

  assert.deepEqual(await store.get(key), contents);
});

run('what is stored in the TABLE is not the plaintext', async () => {
  const key = keyFor(firmA);
  const secret = 'SHARMA TRADERS CONFIDENTIAL BALANCE 1,00,000';
  await store.put(key, Buffer.from(secret));

  // Read the raw column, bypassing our decrypt, to see what the database holds.
  const raw = await db.withFirm(firmA, async (c) => {
    const { rows } = await c.query('SELECT contents FROM document_blobs WHERE storage_key = $1', [key]);
    return Buffer.from(rows[0].contents);
  });

  // A database dump, a backup, or an engineer with read access must not expose
  // a client's bank statement.
  assert.ok(!raw.includes(Buffer.from(secret)), 'the database must hold ciphertext only');
  assert.ok(!raw.includes(Buffer.from('SHARMA')), 'not even partially');
});

run("ONE FIRM CANNOT READ ANOTHER FIRM'S DOCUMENT", async () => {
  const key = keyFor(firmA);
  await store.put(key, Buffer.from('firm A financials'));

  // The key names firm A, so the read is scoped to firm A and succeeds. The
  // real test is whether firm B's own session can see the row at all.
  const visibleToB = await db.withFirm(firmB, async (c) => {
    const { rows } = await c.query('SELECT count(*)::int AS n FROM document_blobs');
    return rows[0].n;
  });

  assert.equal(visibleToB, 0, 'row-level security must hide it entirely');
});

run('a row altered in the database fails its integrity check', async () => {
  const key = keyFor(firmA);
  await store.put(key, Buffer.from('Date,Amount\n16/07/2024,500\n'));

  await db.withFirm(firmA, async (c) => {
    const { rows } = await c.query('SELECT contents FROM document_blobs WHERE storage_key = $1', [key]);
    const tampered = Buffer.from(rows[0].contents);
    tampered[tampered.length - 5] ^= 0xff;
    await c.query('UPDATE document_blobs SET contents = $2 WHERE storage_key = $1', [key, tampered]);
  });

  await assert.rejects(
    () => store.get(key),
    (err) => /integrity check/.test(err.message),
    'tampered ciphertext must not be parsed into transactions',
  );
});

run('a document written with one key cannot be read with another', async () => {
  const key = keyFor(firmA);
  await store.put(key, Buffer.from('client financials'));

  const other = require('../src/services/storage/postgres').createPostgresStorage({
    encrypt: storage._internals.encrypt,
    decrypt: storage._internals.decrypt,
    key: crypto.randomBytes(32),
  });

  await assert.rejects(() => other.get(key), /integrity check/);
});

run('a missing document is reported clearly', async () => {
  await assert.rejects(() => store.get(keyFor(firmA)), /no longer in storage/);
  assert.equal(await store.exists(keyFor(firmA)), false);
});

run('exists() distinguishes present from absent', async () => {
  const key = keyFor(firmA);
  assert.equal(await store.exists(key), false);
  await store.put(key, Buffer.from('x'));
  assert.equal(await store.exists(key), true);
});

run('a malformed storage key is refused rather than guessed at', async () => {
  // A key that is not firm/period/document means something upstream is wrong.
  // Guessing at the firm would be the worst possible response.
  for (const bad of ['not-a-key', '../escape', 'a/b', `${firmA}/only-two`]) {
    await assert.rejects(() => store.get(bad), /not firm\/period\/document/, `should refuse ${bad}`);
  }
  assert.equal(await store.exists('not-a-key'), false, 'exists() answers false rather than throwing');
});

run('re-storing the same key overwrites rather than failing', async () => {
  const key = keyFor(firmA);
  await store.put(key, Buffer.from('first'));
  await store.put(key, Buffer.from('second'));
  assert.equal((await store.get(key)).toString(), 'second');
});
