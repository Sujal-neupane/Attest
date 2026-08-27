/**
 * A PDF invoice, all the way through.
 *
 * Upload → encrypted storage → queued job → worker → PDF text extraction →
 * the real Anthropic SDK (against a local server) → grounding → deterministic
 * parsing → transactions in the ledger.
 *
 * Every layer is the real one except the model itself, which is the only part
 * that cannot be made deterministic. That is the right seam: the model's
 * OUTPUT is the input to everything this test cares about, and the interesting
 * cases are the ones where that output is wrong.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Anthropic = require('@anthropic-ai/sdk');
const { betaZodTool, betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');

const testDb = require('./helpers/testDatabase');
const { makePdf } = require('./helpers/makePdf');
const { createMockAnthropic, structured, toolUse } = require('./helpers/mockAnthropic');

const available = testDb.isAvailable();
const fixture = available ? testDb.setup('attest_invoice_test', 'attest_test_invoice') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('invoice pipeline tests skipped — no database reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

const INVOICE_LINES = [
  'SHARMA TRADERS PVT LTD',
  'Lalitpur, Nepal    PAN: 301234567',
  'TAX INVOICE',
  'Invoice No: INV-2081-0042',
  'Date: 17/07/2024',
  'Office paper, A4 ream   20   500.00   10,000.00',
  'Taxable Amount 10,000.00',
  'VAT @ 13% 1,300.00',
  'Grand Total 11,300.00',
];

const field = (value, quote) => ({ value, quote });

const HONEST = {
  documentKind: 'purchase_invoice',
  invoiceNumber: field('INV-2081-0042', 'Invoice No: INV-2081-0042'),
  invoiceDate: field('17/07/2024', 'Date: 17/07/2024'),
  party: field('SHARMA TRADERS PVT LTD', 'SHARMA TRADERS PVT LTD'),
  partyPan: field('301234567', 'PAN: 301234567'),
  taxableAmount: field('10,000.00', 'Taxable Amount 10,000.00'),
  vatAmount: field('1,300.00', 'VAT @ 13% 1,300.00'),
  grossAmount: field('11,300.00', 'Grand Total 11,300.00'),
  suggestedTdsCategory: 'service_contract',
  notes: null,
};

let db;
let store;
let storeRoot;
let service;
let worker;
let aiClient;
let documents;
let user;
let periodId;
let mock;

before(async () => {
  db = require('../src/config/db');
  const storage = require('../src/services/storage');
  const storageConfig = require('../src/config/storage');
  worker = require('../src/workers/parseDocument');
  aiClient = require('../src/services/ai/client');
  documents = require('../src/repositories/document.repository');
  const { createDocumentService } = require('../src/services/document.service');

  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-invoice-'));
  store = storage.createLocalStorage({ root: storeRoot, key: crypto.randomBytes(32) });
  storageConfig.override({ store, signer: storage.createSigner('invoice-test'), root: storeRoot });
  service = createDocumentService({ store });

  const firmId = crypto.randomUUID();
  const client = await db.pool.connect();
  await client.query('SELECT set_config($1, $2, false)', ['app.current_firm_id', firmId]);
  await client.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [firmId, 'Invoice Firm']);
  const { rows: users } = await client.query(
    `INSERT INTO users (firm_id, email, full_name, role)
     VALUES ($1, 'invoice@example.com', 'Invoice User', 'admin') RETURNING id`,
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
  await mock?.close().catch(() => {});
  await db?.close().catch(() => {});
  if (storeRoot) fs.rmSync(storeRoot, { recursive: true, force: true });
});

/** Point the worker's AI client at a local server scripted for this test. */
async function useModel(script) {
  await mock?.close().catch(() => {});
  mock = createMockAnthropic(script);
  const baseURL = await mock.listen();
  aiClient.override({
    client: new Anthropic({ apiKey: 'not-a-real-key', baseURL, maxRetries: 0 }),
    betaZodTool,
    betaZodOutputFormat,
  });
  return mock;
}

/**
 * Each upload gets a unique reference line.
 *
 * Not a workaround — the duplicate guard is doing its job. Two byte-identical
 * PDFs ARE the same document, and re-importing one would double every figure
 * in the period. Real invoices differ; these fixtures have to as well.
 */
let uploadCount = 0;
const uploadPdf = (lines, filename = 'invoice.pdf') =>
  service.upload(user, periodId, {
    type: 'invoice',
    filename,
    contents: makePdf([...lines, `Ref: UPLOAD-${++uploadCount}`]),
  });

const transactionsIn = () =>
  db.withFirm(user.firmId, (c) => documents.listTransactionsForPeriod(c, periodId));

run('a PDF invoice is read end to end into a transaction', async () => {
  await useModel([toolUse('get_document_text', {}), structured(HONEST)]);

  const document = await uploadPdf(INVOICE_LINES);
  assert.equal(document.status, 'uploaded');

  const outcome = await worker.runOnce({ store, logger: {} });
  assert.equal(outcome.ok, true, outcome.error?.message);
  assert.equal(outcome.result.imported, 1);

  const [txn] = await transactionsIn();
  assert.equal(txn.source, 'ledger');
  assert.equal(txn.kind, 'purchase');
  assert.equal(txn.invoiceNumber, 'INV-2081-0042');
  assert.equal(txn.party, 'SHARMA TRADERS PVT LTD');
  assert.equal(txn.partyPan, '301234567');
  assert.equal(txn.txnDate, '2024-07-17');

  // A purchase sends money out, exactly as it would from a CSV register.
  assert.equal(txn.amountPaisa, -1_130_000);
  assert.equal(txn.direction, 'debit');

  // Reported by the document, not computed — the tax engine still runs.
  assert.equal(txn.reportedNetPaisa, 1_000_000);
  assert.equal(txn.reportedVatPaisa, 130_000);
  assert.equal(txn.vatPaisa, null, 'nothing is computed at import time');
});

run('the quotes the model pointed at survive as provenance', async () => {
  const [txn] = await transactionsIn();
  assert.equal(txn.sourceRef.extractedBy, 'claude-opus-5');
  assert.equal(txn.sourceRef.quotes.grossAmount, 'Grand Total 11,300.00');
  // A reviewer must be able to check the same characters the grounding check
  // did, not a paraphrase of them.
  assert.ok(txn.sourceRef.toolCalls.includes('get_document_text'));
});

run('the document ends parsed, and the model is recorded in the audit trail', async () => {
  const [document] = await service.listForPeriod(user, periodId);
  assert.equal(document.status, 'parsed');

  const actions = fixture
    .psql(['-tA', '-c', "SELECT action FROM audit_log WHERE action = 'parse_document'"])
    .trim();
  assert.ok(actions.length > 0, 'an AI-read document is audited like any other');
});

run('AN INVENTED TOTAL FAILS THE DOCUMENT — it never becomes a transaction', async () => {
  await useModel([
    structured({ ...HONEST, grossAmount: field('13,100.00', 'Grand Total 11,300.00') }),
  ]);

  const document = await uploadPdf(INVOICE_LINES, 'transposed.pdf');
  const countBefore = (await transactionsIn()).length;

  const outcome = await worker.runOnce({ store, logger: {} });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.permanent, true, 'a hallucination will not fix itself on retry');
  assert.equal((await transactionsIn()).length, countBefore, 'nothing may be written');

  const stored = await service.get(user, document.id);
  assert.equal(stored.status, 'failed');
  // The accountant is told which value could not be verified, and why.
  assert.match(stored.failureReason, /grossAmount/);
  assert.match(stored.failureReason, /a figure that was not read is a figure that was invented/);
});

run('a scan with no text layer is refused before any model is called', async () => {
  // A photographed bill has no text to extract. Sending an empty page to a
  // model and trusting what comes back is exactly how a confident extraction
  // of nothing happens.
  const mockServer = await useModel([structured(HONEST)]);

  const document = await uploadPdf(['x'], 'photo.pdf');
  const outcome = await worker.runOnce({ store, logger: {} });

  assert.equal(outcome.ok, false);
  assert.equal(mockServer.requests.length, 0, 'no request should have been made');

  const stored = await service.get(user, document.id);
  assert.match(stored.failureReason, /no readable text/);
  assert.match(stored.failureReason, /OCR is not built/);
});

run('an invoice whose own total is wrong is imported, with the discrepancy preserved', async () => {
  const lines = INVOICE_LINES.map((l) =>
    l === 'Grand Total 11,300.00' ? 'Grand Total 11,500.00' : l,
  );
  await useModel([
    structured({
      ...HONEST,
      grossAmount: field('11,500.00', 'Grand Total 11,500.00'),
      notes: 'The printed total does not equal taxable plus VAT.',
    }),
  ]);

  await uploadPdf(lines, 'wrong-total.pdf');
  const outcome = await worker.runOnce({ store, logger: {} });
  assert.equal(outcome.ok, true, outcome.error?.message);

  const txn = (await transactionsIn()).find((t) => t.description?.includes('does not equal'));
  assert.ok(txn, 'the invoice is imported — the discrepancy is a finding, not a rejection');
  // 10,000 + 1,300 is 11,300. This invoice says 11,500, and that is what is
  // stored. Correcting it would erase the reason the accountant is being paid.
  assert.equal(txn.amountPaisa, -1_150_000);
  assert.equal(txn.reportedNetPaisa, 1_000_000);
  assert.equal(txn.reportedVatPaisa, 130_000);
});

run('with no API key configured, the failure says so plainly', async () => {
  aiClient.override(null);
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const document = await uploadPdf(INVOICE_LINES, 'no-key.pdf');
    const outcome = await worker.runOnce({ store, logger: {} });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.permanent, true, 'no amount of retrying produces an API key');

    const stored = await service.get(user, document.id);
    assert.match(stored.failureReason, /not configured on this deployment/);
    // And it points at the path that still works without a model.
    assert.match(stored.failureReason, /register as CSV instead/);
  } finally {
    if (previous) process.env.ANTHROPIC_API_KEY = previous;
  }
});
