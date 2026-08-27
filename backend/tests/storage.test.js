const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const storage = require('../src/services/storage');

const KEY = crypto.randomBytes(storage.KEY_BYTES);

async function tempStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attest-store-'));
  return { root, store: storage.createLocalStorage({ root, key: KEY }) };
}

test('a stored document comes back byte-identical', async () => {
  const { store } = await tempStore();
  const contents = Buffer.from('Date,Narration,Debit\n16/07/2024,PAYMENT,500\n');
  await store.put('firm/period/doc', contents);
  assert.deepEqual(await store.get('firm/period/doc'), contents);
});

test('what lands on disk is not the plaintext', async () => {
  const { root, store } = await tempStore();
  const secret = 'SHARMA TRADERS CONFIDENTIAL BALANCE 1,00,000';
  await store.put('firm/period/doc', Buffer.from(secret));

  const raw = await fs.readFile(path.join(root, 'firm/period/doc'));
  assert.ok(!raw.includes(Buffer.from(secret)), 'client data must not be readable on disk');
  assert.ok(!raw.includes(Buffer.from('SHARMA')), 'not even partially');
});

test('the same bytes encrypt differently every time', async () => {
  const { root, store } = await tempStore();
  const contents = Buffer.from('identical contents');
  await store.put('a', contents);
  await store.put('b', contents);

  const first = await fs.readFile(path.join(root, 'a'));
  const second = await fs.readFile(path.join(root, 'b'));
  // A fresh random IV per file. Identical ciphertext would leak that two
  // documents are the same file without either being decrypted.
  assert.ok(!first.equals(second), 'each file must use a fresh IV');
  assert.deepEqual(await store.get('a'), await store.get('b'));
});

test('a document altered on disk fails its integrity check rather than parsing', async () => {
  const { root, store } = await tempStore();
  await store.put('firm/period/doc', Buffer.from('Date,Amount\n16/07/2024,500\n'));

  const target = path.join(root, 'firm/period/doc');
  const raw = await fs.readFile(target);
  raw[raw.length - 5] ^= 0xff; // flip a bit in the ciphertext
  await fs.writeFile(target, raw);

  await assert.rejects(() => store.get('firm/period/doc'), (err) =>
    err instanceof storage.StorageError && /integrity check/.test(err.message));
});

test('a document cannot be read with a different key', async () => {
  const { root } = await tempStore();
  const writer = storage.createLocalStorage({ root, key: KEY });
  await writer.put('doc', Buffer.from('client financials'));

  const other = storage.createLocalStorage({ root, key: crypto.randomBytes(storage.KEY_BYTES) });
  await assert.rejects(() => other.get('doc'), storage.StorageError);
});

test('a missing document is reported clearly, not as a crash', async () => {
  const { store } = await tempStore();
  await assert.rejects(() => store.get('never/written'), (err) =>
    err instanceof storage.StorageError && /no longer in storage/.test(err.message));
  assert.equal(await store.exists('never/written'), false);
});

test('a key that tries to escape the store is refused', async () => {
  const { store } = await tempStore();
  for (const bad of ['../escape', 'a/../../escape', '/etc/passwd']) {
    await assert.rejects(() => store.get(bad), storage.StorageError, `should refuse ${bad}`);
  }
});

test('a storage key carries ids only, never the filename', () => {
  const key = storage.buildKey({
    firmId: 'firm-1',
    fiscalPeriodId: 'period-1',
    documentId: 'doc-1',
  });
  assert.equal(key, 'firm-1/period-1/doc-1');
  // Keys reach logs and object listings; a client's name in one is a
  // confidentiality leak.
  assert.ok(!/\.(csv|pdf)$/i.test(key));
});

test('the wrong key length is refused rather than silently padded', () => {
  assert.throws(
    () => storage.createLocalStorage({ root: '/tmp', key: crypto.randomBytes(16) }),
    storage.StorageError,
  );
});

test('identical files are recognised by their content hash', () => {
  const a = Buffer.from('Date,Amount\n16/07/2024,500\n');
  const b = Buffer.from('Date,Amount\n16/07/2024,500\n');
  const c = Buffer.from('Date,Amount\n16/07/2024,501\n');
  assert.equal(storage.contentHash(a), storage.contentHash(b));
  assert.notEqual(storage.contentHash(a), storage.contentHash(c));
});

// ---------------------------------------------------------------------------
// Signed access tokens
// ---------------------------------------------------------------------------

test('a freshly signed token verifies', () => {
  const signer = storage.createSigner('a-signing-secret');
  const { token } = signer.sign('firm/period/doc');
  assert.equal(signer.verify('firm/period/doc', token).valid, true);
});

test('a token for one document does not open another', () => {
  const signer = storage.createSigner('a-signing-secret');
  const { token } = signer.sign('firm/period/doc-a');
  const result = signer.verify('firm/period/doc-b', token);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature');
});

test('an expired token is rejected', () => {
  const signer = storage.createSigner('a-signing-secret');
  const { token } = signer.sign('doc', { ttlSeconds: 60, now: 1_000_000_000_000 });
  // Ten minutes later.
  const result = signer.verify('doc', token, { now: 1_000_000_600_000 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});

test('the expiry cannot be extended by editing the token', () => {
  const signer = storage.createSigner('a-signing-secret');
  const { token, expiresAt } = signer.sign('doc', { ttlSeconds: 60 });
  const [, signature] = token.split('.');
  const forged = `${expiresAt + 86_400}.${signature}`;
  assert.equal(signer.verify('doc', forged).reason, 'signature');
});

test('a token signed with a different secret is rejected', () => {
  const { token } = storage.createSigner('secret-one').sign('doc');
  assert.equal(storage.createSigner('secret-two').verify('doc', token).valid, false);
});

test('malformed tokens are rejected without throwing', () => {
  const signer = storage.createSigner('a-signing-secret');
  for (const bad of ['', 'garbage', '123', 'abc.def', null, undefined, 12345]) {
    const result = signer.verify('doc', bad);
    assert.equal(result.valid, false, `should reject ${JSON.stringify(bad)}`);
  }
});
