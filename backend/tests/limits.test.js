/**
 * Volume limits.
 *
 * A year of a busy retailer's bank statement is thousands of rows. Every batch
 * insert in this codebase builds one statement with a placeholder per column
 * per row, and Postgres refuses more than 65,535 parameters in a single
 * statement — so "it works on the fixtures" says nothing about whether it works
 * on a real client's books.
 *
 * These tests exist because that ceiling is invisible until the day someone
 * uploads a big enough file, and the failure would land on the accountant as a
 * document stuck in 'failed' the week a return is due.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const testDb = require('./helpers/testDatabase');

const available = testDb.isAvailable();
const fixture = available ? testDb.setup('attest_limits_test', 'attest_test_limits') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('limit tests skipped — no database reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

let db;
let documents;
let reviewRepo;
let firmId;
let clientId;
let periodId;
let documentId;

before(async () => {
  db = require('../src/config/db');
  documents = require('../src/repositories/document.repository');
  reviewRepo = require('../src/repositories/review.repository');

  firmId = crypto.randomUUID();
  const c = await db.pool.connect();
  await c.query('SELECT set_config($1, $2, false)', ['app.current_firm_id', firmId]);
  await c.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [firmId, 'Limits Firm']);
  const { rows: users } = await c.query(
    `INSERT INTO users (firm_id, email, full_name, role)
     VALUES ($1, 'limits@example.com', 'Limits User', 'admin') RETURNING id`,
    [firmId],
  );
  const { rows: cl } = await c.query(
    `INSERT INTO clients (firm_id, name) VALUES ($1, 'Busy Retailer') RETURNING id`,
    [firmId],
  );
  clientId = cl[0].id;
  const { rows: pd } = await c.query(
    `INSERT INTO fiscal_periods (firm_id, client_id, label, bs_year, start_date, end_date)
     VALUES ($1, $2, 'FY 2081-82', 2081, '2024-07-16', '2025-07-16') RETURNING id`,
    [firmId, clientId],
  );
  periodId = pd[0].id;
  const { rows: doc } = await c.query(
    `INSERT INTO documents (firm_id, client_id, fiscal_period_id, type, filename, storage_key, uploaded_by)
     VALUES ($1, $2, $3, 'bank_statement', 'big.csv', 'k/big', $4) RETURNING id`,
    [firmId, clientId, periodId, users[0].id],
  );
  documentId = doc[0].id;
  c.release();
});

after(async () => {
  await db?.close().catch(() => {});
});

const makeTransactions = (count) =>
  Array.from({ length: count }, (_, i) => ({
    firmId,
    clientId,
    fiscalPeriodId: periodId,
    documentId,
    source: 'bank',
    kind: 'payment',
    txnDate: '2024-08-01',
    description: `PAYMENT ${i}`,
    party: `Supplier ${i % 50}`,
    invoiceNumber: null,
    reference: `REF${i}`,
    amountPaisa: -(1000 + i),
    direction: 'debit',
    sourceRef: { row: i + 2, raw: { date: '01/08/2024' } },
  }));

run('a statement far larger than the parameter ceiling inserts correctly', async () => {
  // 19 columns x 5,000 rows = 95,000 placeholders. A single INSERT would be
  // refused by Postgres outright.
  const rows = makeTransactions(5000);

  const inserted = await db.withFirm(firmId, (c) => documents.insertTransactions(c, rows));
  assert.equal(inserted.length, 5000, 'every row must be inserted');

  const count = await db.withFirm(firmId, (c) =>
    documents.countTransactionsForDocument(c, documentId),
  );
  assert.equal(count, 5000, 'and every row must actually be in the table');
});

run('the amounts survive batching without drift or reordering', async () => {
  const stored = await db.withFirm(firmId, (c) =>
    c.query(
      `SELECT sum(amount_paisa)::bigint AS total, count(*)::int AS n,
              min(amount_paisa)::bigint AS smallest
         FROM transactions WHERE document_id = $1`,
      [documentId],
    ),
  );
  const { total, n, smallest } = stored.rows[0];

  // -(1000 + i) for i in 0..4999
  const expected = -Array.from({ length: 5000 }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0);
  assert.equal(n, 5000);
  assert.equal(total, expected, 'a batching bug would show up as a wrong total');
  assert.equal(smallest, -(1000 + 4999));
});

run('a large batch of flags also inserts', async () => {
  const flags = Array.from({ length: 4000 }, (_, i) => ({
    firmId,
    fiscalPeriodId: periodId,
    transactionId: null,
    relatedTransactionIds: [],
    type: 'round_number',
    severity: 'low',
    message: `Flag ${i}`,
    suggestion: 'Check it.',
    evidence: [],
  }));

  const inserted = await db.withFirm(firmId, (c) => reviewRepo.insertFlags(c, flags));
  assert.equal(inserted.length, 4000);
});

run('an empty batch is a no-op, not an error', async () => {
  assert.deepEqual(await db.withFirm(firmId, (c) => documents.insertTransactions(c, [])), []);
  assert.deepEqual(await db.withFirm(firmId, (c) => reviewRepo.insertFlags(c, [])), []);
});
