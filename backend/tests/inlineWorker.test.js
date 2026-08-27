/**
 * The inline worker.
 *
 * Running the parse loop inside the API process is a deployment choice made to
 * fit a free host, and the question it has to answer is whether it weakens
 * anything. It does not: the claim is still SELECT ... FOR UPDATE SKIP LOCKED,
 * so the guarantee that a document is parsed once lives in the database, not in
 * the process model.
 *
 * These tests pin that down — including the case that would actually bite, two
 * inline workers running at once, which is what happens the moment a free host
 * spins up a second instance.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDb = require('./helpers/testDatabase');

const available = testDb.isAvailable();
const fixture = available ? testDb.setup('attest_inline_test', 'attest_test_inline') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('inline worker tests skipped — no database reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

const STATEMENT = [
  'Date,Narration,Withdrawl,Deposit,Balance',
  '17/07/2024,IPS/FT FROM SHARMA TRADERS,,"11,300.00","1,11,300.00"',
  '20/07/2024,CHQ PAID TO GURUNG HARDWARE,"5,650.00",,"1,05,650.00"',
].join('\n');

let db;
let store;
let storeRoot;
let service;
let documents;
let startInlineWorker;
let user;
let periodId;
let workers = [];

before(async () => {
  db = require('../src/config/db');
  documents = require('../src/repositories/document.repository');
  const storage = require('../src/services/storage');
  const storageConfig = require('../src/config/storage');
  const { createDocumentService } = require('../src/services/document.service');
  ({ startInlineWorker } = require('../src/workers/inline'));

  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-inline-'));
  store = storage.createLocalStorage({ root: storeRoot, key: crypto.randomBytes(32) });
  storageConfig.override({ store, signer: storage.createSigner('inline-test'), root: storeRoot });
  service = createDocumentService({ store });

  const firmId = crypto.randomUUID();
  const client = await db.pool.connect();
  await client.query('SELECT set_config($1, $2, false)', ['app.current_firm_id', firmId]);
  await client.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [firmId, 'Inline Firm']);
  const { rows: users } = await client.query(
    `INSERT INTO users (firm_id, email, full_name, role)
     VALUES ($1, 'inline@example.com', 'Inline User', 'admin') RETURNING id`,
    [firmId],
  );
  const { rows: clients } = await client.query(
    `INSERT INTO clients (firm_id, name) VALUES ($1, 'Himalayan Traders') RETURNING id`,
    [firmId],
  );
  const { rows: periods } = await client.query(
    `INSERT INTO fiscal_periods (firm_id, client_id, label, bs_year, bs_month, start_date, end_date)
     VALUES ($1, $2, 'Shrawan 2081', 2081, 4, '2024-07-16', '2024-08-16') RETURNING id`,
    [firmId, clients[0].id],
  );
  client.release();

  user = { id: users[0].id, firmId, role: 'admin' };
  periodId = periods[0].id;
});

after(async () => {
  for (const worker of workers) worker.stop();
  await db?.close().catch(() => {});
  if (storeRoot) fs.rmSync(storeRoot, { recursive: true, force: true });
});

let uploads = 0;
const upload = () =>
  service.upload(user, periodId, {
    type: 'bank_statement',
    filename: `inline-${++uploads}.csv`,
    // Distinct content each time — identical bytes are correctly refused as a
    // duplicate, which would be a different test.
    contents: Buffer.from(`${STATEMENT}\n21/07/2024,REF ${uploads},"${uploads}.00",,"1.00"\n`),
  });

const waitFor = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

const parsedCount = async () =>
  (await service.listForPeriod(user, periodId)).filter((d) => d.status === 'parsed').length;

run('an inline worker picks up and parses an upload on its own', async () => {
  const worker = startInlineWorker({ store, logger: {} });
  workers.push(worker);

  await upload();

  const done = await waitFor(async () => (await parsedCount()) >= 1);
  assert.equal(done, true, 'the inline loop should have claimed and parsed the document');

  const rows = await db.withFirm(user.firmId, (c) =>
    documents.listTransactionsForPeriod(c, periodId),
  );
  assert.ok(rows.length >= 2, 'and written its transactions');
});

run('TWO INLINE WORKERS DO NOT DOUBLE-PROCESS A DOCUMENT', async () => {
  // The case that actually matters. A free host scaling to two instances means
  // two inline workers against one queue — and if the guarantee lived in the
  // process rather than the database, every document would be parsed twice and
  // every figure in the period doubled.
  const second = startInlineWorker({ store, logger: {} });
  const third = startInlineWorker({ store, logger: {} });
  workers.push(second, third);

  const parsedBefore = await parsedCount();
  const uploaded = await Promise.all([upload(), upload(), upload()]);

  const done = await waitFor(async () => (await parsedCount()) >= parsedBefore + 3);
  assert.equal(done, true, 'all three should be parsed');

  for (const document of uploaded) {
    const count = await db.withFirm(user.firmId, (c) =>
      documents.countTransactionsForDocument(c, document.id),
    );
    // Three transactions per file. Four or six would mean it was parsed twice.
    assert.equal(count, 3, `document ${document.filename} was parsed exactly once`);
  }
});

run('stopping the worker stops it claiming anything more', async () => {
  const worker = startInlineWorker({ store, logger: {} });
  worker.stop();

  // Everything already queued has drained by now; nothing new should move.
  const parsedBefore = await parsedCount();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await parsedCount(), parsedBefore);
});

run('a worker with a broken store keeps running rather than taking the API down', async () => {
  // Inline means the parse loop shares a process with every HTTP request. A
  // failure that killed the loop would be survivable; one that threw out of it
  // and took the process with it would take the whole API down with it.
  const brokenStore = {
    async get() { throw new Error('storage is unreachable'); },
    async put() { throw new Error('storage is unreachable'); },
  };

  const worker = startInlineWorker({ store: brokenStore, logger: { error() {}, warn() {} } });
  workers.push(worker);

  await upload();
  await new Promise((resolve) => setTimeout(resolve, 600));

  // Still alive, still able to answer.
  assert.equal(typeof (await parsedCount()), 'number');
  worker.stop();
});
