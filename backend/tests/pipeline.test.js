/**
 * The upload pipeline, end to end.
 *
 * Upload → encrypted storage → queued job → worker → normalized transactions,
 * against a real database and a real (temporary) encrypted store. This is the
 * test that would catch a break anywhere along the seam between the pieces that
 * are individually well tested.
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
const fixture = available ? testDb.setup('attest_pipeline_test', 'attest_test_pipeline') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('pipeline tests skipped — no database reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

const STATEMENT = [
  'NABIL BANK LIMITED',
  'Statement of Account',
  '',
  'Date,Narration,Withdrawl,Deposit,Balance',
  '16/07/2024,OPENING BALANCE,,,"1,00,000.00"',
  '17/07/2024,"TRF TO SHARMA TRADERS, LALITPUR","11,300.00",,"88,700.00"',
  '18/07/2024,IPS/FT FROM EVEREST RETAIL,,"22,600.00","1,11,300.00"',
  '20/07/2024,CHQ 004521 PAID TO GURUNG HARDWARE,"5,650.00",,"1,05,650.00"',
].join('\n');

let db;
let store;
let storeRoot;
let service;
let worker;
let queue;
let user;
let periodId;
let signer;

before(async () => {
  db = require('../src/config/db');
  queue = require('../src/services/queue');
  const storage = require('../src/services/storage');
  const { createDocumentService } = require('../src/services/document.service');
  worker = require('../src/workers/parseDocument');

  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-pipeline-'));
  store = storage.createLocalStorage({ root: storeRoot, key: crypto.randomBytes(32) });
  signer = storage.createSigner('pipeline-test-signing-secret');
  service = createDocumentService({ store });

  // A firm, an admin, a client and a period — the state a real upload needs.
  const firmId = crypto.randomUUID();
  const client = await db.pool.connect();
  await client.query('SELECT set_config($1, $2, false)', ['app.current_firm_id', firmId]);
  await client.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [firmId, 'Pipeline Firm']);
  const { rows: userRows } = await client.query(
    `INSERT INTO users (firm_id, email, full_name, role)
     VALUES ($1, 'pipeline@example.com', 'Pipeline User', 'admin') RETURNING id`,
    [firmId],
  );
  const { rows: clientRows } = await client.query(
    `INSERT INTO clients (firm_id, name) VALUES ($1, 'Himalayan Traders') RETURNING id`,
    [firmId],
  );
  const { rows: periodRows } = await client.query(
    `INSERT INTO fiscal_periods (firm_id, client_id, label, bs_year, bs_month, start_date, end_date)
     VALUES ($1, $2, 'Shrawan 2081', 2081, 4, '2024-07-16', '2024-08-16') RETURNING id`,
    [firmId, clientRows[0].id],
  );
  client.release();

  user = { id: userRows[0].id, firmId, role: 'admin' };
  periodId = periodRows[0].id;
});

after(async () => {
  await db?.close().catch(() => {});
  if (storeRoot) fs.rmSync(storeRoot, { recursive: true, force: true });
});

const upload = (contents, overrides = {}) =>
  service.upload(user, periodId, {
    type: 'bank_statement',
    filename: 'nabil-shrawan.csv',
    contents: Buffer.from(contents),
    ...overrides,
  });

run('uploading stores the file encrypted and queues exactly one parse job', async () => {
  const document = await upload(STATEMENT);

  assert.equal(document.status, 'uploaded');
  assert.ok(document.jobId, 'a parse job must be queued alongside the document row');

  // The bytes on disk must not be the client's statement.
  const onDisk = fs.readFileSync(path.join(storeRoot, document.storageKey));
  assert.ok(!onDisk.includes(Buffer.from('SHARMA TRADERS')), 'stored file must be encrypted');

  // And it must decrypt back to exactly what was uploaded.
  assert.equal((await store.get(document.storageKey)).toString('utf8'), STATEMENT);
});

run('the worker parses the queued document into normalized transactions', async () => {
  const outcome = await worker.runOnce({ store, logger: {} });

  assert.ok(outcome, 'there should have been a job to claim');
  assert.equal(outcome.ok, true, outcome.error?.message);
  assert.equal(outcome.result.imported, 3, 'the opening-balance row carries no amount');

  const rows = await db.withFirm(user.firmId, (c) =>
    require('../src/repositories/document.repository').listTransactionsForPeriod(c, periodId),
  );
  assert.equal(rows.length, 3);

  const payment = rows.find((r) => r.party?.startsWith('SHARMA'));
  assert.equal(payment.amountPaisa, -1_130_000, 'money out is stored negative');
  assert.equal(payment.direction, 'debit');
  assert.equal(payment.txnDate, '2024-07-17');

  const receipt = rows.find((r) => r.party === 'EVEREST RETAIL');
  assert.equal(receipt.amountPaisa, 2_260_000);
  assert.equal(receipt.direction, 'credit');
});

run('every stored transaction can be traced back to its source row', async () => {
  const rows = await db.withFirm(user.firmId, (c) =>
    require('../src/repositories/document.repository').listTransactionsForPeriod(c, periodId),
  );
  for (const row of rows) {
    assert.ok(Number.isInteger(row.sourceRef.row), 'sourceRef must name the line it came from');
    assert.ok(row.sourceRef.raw?.date, 'and keep the original text verbatim');
    assert.equal(row.documentFilename, 'nabil-shrawan.csv');
  }
});

run('the document ends as parsed, and the queue as succeeded', async () => {
  const documents = require('../src/repositories/document.repository');
  const [document] = await service.listForPeriod(user, periodId);
  assert.equal(document.status, 'parsed');
  assert.ok(document.parsedAt);
  assert.equal(document.failureReason, null);

  const stats = await db.withFirm(user.firmId, (c) => queue.stats(c));
  assert.equal(stats.succeeded, 1);
  assert.ok(!stats.queued && !stats.running, 'nothing should be left in flight');

  const count = await db.withFirm(user.firmId, (c) =>
    documents.countTransactionsForDocument(c, document.id),
  );
  assert.equal(count, 3, 'the document should own exactly the rows it produced');
});

run('the parse was written to the immutable audit trail', async () => {
  const rows = fixture.psql(['-tA', '-c',
    `SELECT action FROM audit_log ORDER BY created_at`]);
  const actions = rows.trim().split('\n');
  assert.ok(actions.includes('upload_document'), 'the upload must be audited');
  assert.ok(actions.includes('parse_document'), 'so must the parse');
});

run('an empty queue leaves the worker with nothing to do', async () => {
  assert.equal(await worker.runOnce({ store, logger: {} }), null);
});

run('re-uploading the identical file is refused rather than doubling the period', async () => {
  await assert.rejects(
    () => upload(STATEMENT),
    (err) => err.status === 409 && /already been uploaded/.test(err.message),
  );
});

run('a genuinely different statement is accepted alongside the first', async () => {
  const other = STATEMENT.replace('5,650.00', '5,651.00').replace('1,05,650.00', '1,05,649.00');
  const document = await upload(other, { filename: 'nabil-bhadra.csv' });
  assert.equal(document.status, 'uploaded');

  const outcome = await worker.runOnce({ store, logger: {} });
  assert.equal(outcome.ok, true, outcome.error?.message);
});

run('an unparseable file marks the document failed with a reason, never stuck', async () => {
  // No column that reads as an amount: a permanent failure, not a retry.
  const document = await upload('Date,Narration,Reference\n16/07/2024,PAYMENT,X1\n', {
    filename: 'no-amount-column.csv',
  });

  const outcome = await worker.runOnce({ store, logger: {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.permanent, true, 'a missing column will not fix itself on retry');

  const stored = await service.get(user, document.id);
  assert.equal(stored.status, 'failed', 'a document must never be left in processing');
  assert.match(stored.failureReason, /no column that reads as amount/);

  const job = await db.withFirm(user.firmId, (c) => queue.findById(c, document.jobId));
  assert.equal(job.status, 'dead');
  assert.equal(job.attempts, 1, 'a permanent failure should not burn three attempts');
});

run('an empty file is rejected at the door', async () => {
  await assert.rejects(() => upload(''), (err) => err.status === 400);
});

run('an unsupported document type is rejected with the accepted list', async () => {
  await assert.rejects(
    () => upload(STATEMENT, { type: 'tax_return' }),
    (err) => err.status === 400 && /bank_statement/.test(err.detail),
  );
});

run('a document cannot be uploaded to another firm\'s period', async () => {
  const stranger = { id: crypto.randomUUID(), firmId: crypto.randomUUID(), role: 'admin' };
  const client = await db.pool.connect();
  await client.query('SELECT set_config($1, $2, false)', ['app.current_firm_id', stranger.firmId]);
  await client.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [stranger.firmId, 'Stranger']);
  client.release();

  await assert.rejects(
    () => service.upload(stranger, periodId, {
      type: 'bank_statement',
      filename: 'x.csv',
      contents: Buffer.from(STATEMENT),
    }),
    (err) => err.status === 404,
    'row-level security must make another firm\'s period invisible',
  );
});

run('a signed link opens the document, and only that document', async () => {
  const [document] = await service.listForPeriod(user, periodId);
  const { url } = await service.signedUrl(user, document.id, { signer });
  const token = new URL(url, 'http://x').searchParams.get('token');

  const { contents } = await service.contents(user, document.id, token, { signer });
  assert.ok(contents.toString('utf8').includes('Date,'));

  // The same token against a different document must not work.
  const others = await service.listForPeriod(user, periodId);
  const other = others.find((d) => d.id !== document.id);
  if (other) {
    await assert.rejects(
      () => service.contents(user, other.id, token, { signer }),
      (err) => err.status === 403,
    );
  }
});
