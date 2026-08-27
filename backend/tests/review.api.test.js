/**
 * The review sheet, end to end over HTTP.
 *
 * Upload a bank statement AND the client's sales register, parse both,
 * reconcile them, and work the resulting flags the way an accountant would.
 * This is the journey the product exists for, so it is tested as a journey
 * rather than as a set of endpoints.
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
const fixture = available ? testDb.setup('attest_review_test', 'attest_test_review') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('review API tests skipped — no database reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

/**
 * Deliberately constructed so the engine has something real to find:
 *  - INV-001 and INV-002 are paid, and appear in the bank.
 *  - INV-003 is unpaid: a ledger entry with no bank movement.
 *  - INV-005 skips INV-004: a gap in the sales sequence.
 *  - INV-005 states VAT of 1,000 on 10,000 taxable — wrong by 300.
 *  - The bank shows a 5,650 payment to a supplier with no purchase bill.
 */
const BANK = [
  'Date,Narration,Withdrawl,Deposit,Balance',
  '16/07/2024,OPENING BALANCE,,,"1,00,000.00"',
  '17/07/2024,IPS/FT FROM SHARMA TRADERS,,"11,300.00","1,11,300.00"',
  '18/07/2024,IPS/FT FROM EVEREST RETAIL,,"22,600.00","1,33,900.00"',
  '20/07/2024,CHQ 004521 PAID TO GURUNG HARDWARE,"5,650.00",,"1,28,250.00"',
].join('\n');

const SALES = [
  'Date,Invoice No,Party Name,Taxable Amount,VAT',
  '17/07/2024,INV-001,Sharma Traders,"10,000.00","1,300.00"',
  '18/07/2024,INV-002,Everest Retail,"20,000.00","2,600.00"',
  '19/07/2024,INV-003,Lalitpur Stores,"15,000.00","1,950.00"',
  '22/07/2024,INV-005,Bhaktapur Supply,"10,000.00","1,000.00"',
].join('\n');

let server;
let base;
let db;
let storeRoot;
let store;
let worker;
let token;
let periodId;

before(async () => {
  db = require('../src/config/db');
  const storage = require('../src/services/storage');
  const storageConfig = require('../src/config/storage');
  worker = require('../src/workers/parseDocument');

  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-review-'));
  store = storage.createLocalStorage({ root: storeRoot, key: crypto.randomBytes(32) });
  storageConfig.override({ store, signer: storage.createSigner('review-test-secret'), root: storeRoot });

  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;

  const registered = await json('POST', '/auth/register', {
    body: {
      firmName: 'Review Test Firm',
      fullName: 'Sujal Neupane',
      email: 'review@example.com',
      password: 'a-sufficiently-long-password',
    },
  });
  token = registered.body.accessToken;

  const client = await json('POST', '/clients', {
    token,
    body: { name: 'Himalayan Traders Pvt Ltd', pan: '123456789' },
  });
  const period = await json('POST', `/clients/${client.body.id}/periods`, {
    token,
    body: { bsYear: 2081, bsMonth: 4 },
  });
  periodId = period.body.id;

  await upload(BANK, 'bank.csv', 'bank_statement');
  await upload(SALES, 'sales.csv', 'sales_register');
  await drainQueue();
});

after(async () => {
  server?.close();
  await db?.close().catch(() => {});
  if (storeRoot) fs.rmSync(storeRoot, { recursive: true, force: true });
});

async function json(method, url, { body, token: bearer } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function upload(contents, filename, type) {
  const form = new FormData();
  form.append('file', new Blob([contents], { type: 'text/csv' }), filename);
  form.append('type', type);
  const res = await fetch(`${base}/periods/${periodId}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(res.status, 202, await res.text());
}

async function drainQueue(limit = 20) {
  for (let i = 0; i < limit; i++) {
    const outcome = await worker.runOnce({ store, logger: {} });
    if (outcome === null) return;
    assert.equal(outcome.ok, true, outcome.error?.message);
  }
  throw new Error('queue never drained');
}

const flags = async () => (await json('GET', `/periods/${periodId}/flags`, { token })).body;

run('both documents parsed into bank and ledger transactions', async () => {
  const { body } = await json('GET', `/periods/${periodId}/transactions`, { token });
  assert.equal(body.filter((t) => t.source === 'bank').length, 3);
  assert.equal(body.filter((t) => t.source === 'ledger').length, 4);
});

run('reconciliation matches the paid invoices against the bank', async () => {
  const { status, body } = await json('POST', `/periods/${periodId}/reconcile`, { token });
  assert.equal(status, 200, JSON.stringify(body));

  assert.equal(body.reconciliation.matchedCount, 2, 'INV-001 and INV-002 were paid');
  assert.equal(body.transactionsComputed, 4, 'every ledger entry gets computed VAT');
  assert.ok(body.flagsRaised > 0);
});

run('VAT is computed only on ledger entries, never on bank movements', async () => {
  const { body } = await json('GET', `/periods/${periodId}/transactions`, { token });
  for (const txn of body) {
    if (txn.source === 'bank') {
      assert.equal(txn.vatPaisa, null, 'a bank line is money moving, not a supply');
    } else {
      assert.ok(Number.isInteger(txn.vatPaisa), 'a ledger entry must carry computed VAT');
    }
  }
});

run('a register that misstates VAT is flagged with both figures', async () => {
  const discrepancy = (await flags()).find((f) => /reports VAT of/.test(f.message));
  assert.ok(discrepancy, 'the wrong VAT on INV-005 should be found');
  assert.match(discrepancy.message, /Rs\. 1,000\.00/, 'what the client wrote');
  assert.match(discrepancy.message, /Rs\. 1,300\.00/, 'what the law says');
  assert.match(discrepancy.message, /understated by Rs\. 300\.00/);
});

run('a gap in the sales invoice sequence is found', async () => {
  const gap = (await flags()).find((f) => f.type === 'invoice_gap');
  assert.ok(gap, 'INV-004 is missing from the sequence');
  assert.match(gap.message, /INV-004/);
  assert.equal(gap.severity, 'high');
});

run('a bank payment with no purchase bill is found', async () => {
  const missing = (await flags()).find(
    (f) => f.type === 'missing_bill' && /GURUNG HARDWARE/i.test(f.message),
  );
  assert.ok(missing, 'money left the account with nothing to show for it');
  assert.match(missing.suggestion, /input VAT/);
});

run('an unpaid invoice is found, and rated below a missing bill', async () => {
  const unpaid = (await flags()).find((f) => /INV-003/.test(f.message));
  assert.ok(unpaid);
  assert.equal(unpaid.severity, 'medium', 'an unpaid invoice is normal; it is not an error');
  assert.match(unpaid.suggestion, /receivable/);
});

run('flags arrive sorted so the reviewer lands on what matters', async () => {
  const rank = { high: 0, medium: 1, low: 2 };
  const open = (await flags()).filter((f) => f.status === 'open');
  const severities = open.map((f) => rank[f.severity]);
  assert.deepEqual(severities, [...severities].sort((a, b) => a - b));
});

run('a flag shows the date in the calendar the client actually used', async () => {
  // The register in this fixture is Gregorian, so the label is null — but the
  // FIELD must be present, because the card reads it and a missing key renders
  // as nothing at all rather than as an error anyone would notice.
  for (const flag of await flags()) {
    if (!flag.transactionId) continue;
    assert.ok('bsDateLabel' in flag, 'the flags payload must carry bsDateLabel');
  }
});

run('every flag carries provenance back to a source document', async () => {
  for (const flag of await flags()) {
    if (!flag.transactionId) continue;
    assert.ok(flag.sourceRef, 'a flag must be traceable to the line it came from');
    assert.ok(flag.documentFilename);
  }
});

run('accepting a flag records who decided and when', async () => {
  const target = (await flags()).find((f) => f.status === 'open' && f.severity !== 'high');
  const { status, body } = await json('PATCH', `/flags/${target.id}`, {
    token,
    body: { status: 'accepted', note: 'Confirmed with the client.' },
  });

  assert.equal(status, 200);
  assert.equal(body.status, 'accepted');
  assert.ok(body.resolvedBy, 'anonymous sign-off is worse than none');
  assert.ok(body.resolvedAt);
  assert.equal(body.resolvedNote, 'Confirmed with the client.');
});

run('a high-severity flag cannot be dismissed without a written reason', async () => {
  const high = (await flags()).find((f) => f.status === 'open' && f.severity === 'high');
  assert.ok(high, 'the fixture should produce at least one high-severity flag');

  const bare = await json('PATCH', `/flags/${high.id}`, { token, body: { status: 'dismissed' } });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.error.code, 'reason_required');

  const token10 = await json('PATCH', `/flags/${high.id}`, {
    token,
    body: { status: 'dismissed', note: 'too short' },
  });
  assert.equal(token10.status, 400, 'a token gesture is not a reason');

  const proper = await json('PATCH', `/flags/${high.id}`, {
    token,
    body: {
      status: 'dismissed',
      note: 'Confirmed with client: INV-004 was cancelled and the copy retained.',
    },
  });
  assert.equal(proper.status, 200);
  assert.equal(proper.body.status, 'dismissed');
});

run('the same flag cannot be resolved twice', async () => {
  const resolved = (await flags()).find((f) => f.status === 'accepted');
  const { status, body } = await json('PATCH', `/flags/${resolved.id}`, {
    token,
    body: { status: 'dismissed', note: 'changing my mind about this one' },
  });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'already_resolved');
  // A real date, not "Thu Aug 27" — the message is read by an accountant.
  assert.match(body.error.message, /already accepted on \d{4}-\d{2}-\d{2}\./);
});

run("re-running reconciliation does not re-ask a question already answered", async () => {
  const priorFlags = await flags();
  const decided = priorFlags.filter((f) => f.status === 'accepted' || f.status === 'dismissed');
  assert.ok(decided.length >= 2, 'the fixture should have resolved some flags by now');

  const { body } = await json('POST', `/periods/${periodId}/reconcile`, { token });
  assert.ok(body.flagsSkipped >= decided.length, 'resolved findings must not be raised again');

  const laterFlags = await flags();
  for (const d of decided) {
    const still = laterFlags.find((f) => f.id === d.id);
    assert.ok(still, "a human's decision must survive a re-run");
    assert.equal(still.status, d.status);
    assert.equal(still.resolvedNote, d.resolvedNote);
  }
});

run('re-running does not duplicate the open flags either', async () => {
  const openBefore = (await flags()).filter((f) => f.status === 'open');
  await json('POST', `/periods/${periodId}/reconcile`, { token });
  const openAfter = (await flags()).filter((f) => f.status === 'open');
  assert.equal(openAfter.length, openBefore.length, 'reconciling twice must not double the sheet');
});

run('the VAT summary nets output against input and refuses to look final', async () => {
  const { body } = await json('GET', `/periods/${periodId}/vat-summary`, { token });

  // Four sales: 10,000 + 20,000 + 15,000 + 10,000 taxable.
  assert.equal(body.taxableSalesPaisa, 5_500_000);
  assert.equal(body.outputVatPaisa, 715_000, '13% of 55,000');
  assert.equal(body.inputVatPaisa, 0, 'no purchase register was uploaded');
  assert.equal(body.netVatPaisa, 715_000);
  assert.equal(body.position, 'payable');

  assert.equal(body.uncomputedCount, 0);
  assert.ok(body.openFlagCount > 0);
  assert.equal(body.status, 'pending_review', 'open flags mean it is not ready');
  assert.match(body.disclaimer, /not final until an accountant/);
});

run('every review action was written to the audit trail', async () => {
  const rows = fixture.psql(['-tA', '-c', 'SELECT action FROM audit_log ORDER BY created_at']);
  const actions = rows.trim().split('\n');
  for (const action of ['reconcile', 'accept_flag', 'dismiss_flag']) {
    assert.ok(actions.includes(action), `${action} must be audited`);
  }
});

run("another firm cannot see or resolve this firm's flags", async () => {
  const stranger = await json('POST', '/auth/register', {
    body: {
      firmName: 'Rival Accountants',
      fullName: 'Someone Else',
      email: 'rival-review@example.com',
      password: 'another-sufficiently-long-pw',
    },
  });
  const theirToken = stranger.body.accessToken;

  const seen = await json('GET', `/periods/${periodId}/flags`, { token: theirToken });
  assert.deepEqual(seen.body, []);

  const mine = (await flags()).find((f) => f.status === 'open');
  const attempt = await json('PATCH', `/flags/${mine.id}`, {
    token: theirToken,
    body: { status: 'accepted', note: 'not mine to accept' },
  });
  assert.equal(attempt.status, 404, "another firm's flag must be invisible, not merely forbidden");
});

// ---------------------------------------------------------------------------
// TDS: propose, confirm, compute
// ---------------------------------------------------------------------------

run('the TDS categories are offered with their legal basis', async () => {
  const { status, body } = await json('GET', '/tds-categories', { token });
  assert.equal(status, 200);

  const rent = body.find((c) => c.category === 'rent');
  assert.equal(rent.label, 'Rent');
  // The section is offered so the review report can cite the legal basis next
  // to a deduction. Accountants check that.
  assert.equal(rent.section, 'Sec. 88(1)');

  // Rates are deliberately NOT exposed here either — the engine owns them.
  assert.equal(rent.bp, undefined);
});

run('no TDS is computed until a person classifies the payment', async () => {
  const { body } = await json('GET', `/periods/${periodId}/transactions`, { token });
  for (const txn of body.filter((t) => t.source === 'ledger')) {
    assert.equal(txn.tdsPaisa, null, 'nothing classified means nothing withheld');
  }
});

run('confirming a classification records who decided it', async () => {
  const { body: txns } = await json('GET', `/periods/${periodId}/transactions`, { token });
  const target = txns.find((t) => t.source === 'ledger');

  const { status, body } = await json('PATCH', `/transactions/${target.id}/category`, {
    token,
    body: { category: 'professional_fee' },
  });

  assert.equal(status, 200);
  assert.equal(body.tdsCategory, 'professional_fee');
  assert.equal(body.categorySource, 'human');
  assert.ok(body.categoryConfirmedBy, 'anonymous classification is worse than none');
  // Confirming does not itself compute anything, and says so rather than
  // leaving the reviewer to wonder why no figure appeared.
  assert.match(body.note, /Run reconciliation again/);
});

run('once confirmed, reconciliation computes the TDS deterministically', async () => {
  const { body: result } = await json('POST', `/periods/${periodId}/reconcile`, { token });
  assert.ok(result.tdsComputed >= 1, 'a confirmed classification must produce a figure');

  const { body: txns } = await json('GET', `/periods/${periodId}/transactions`, { token });
  const classified = txns.find((t) => t.tdsCategory === 'professional_fee');

  assert.ok(Number.isInteger(classified.tdsPaisa), 'TDS is now a real figure');
  // 15% under Sec. 88(1) — computed by domain/tax.js, never by the API layer.
  assert.equal(classified.tdsPaisa, Math.round(classified.netPaisa * 0.15));
});

run('a service contract below the annual threshold correctly withholds nothing', async () => {
  // Worth asserting explicitly, because zero here is a RESULT, not a gap. A
  // single Rs. 15,000 bill is under the Rs. 50,000 Sec. 89 threshold, and
  // withholding on it would be wrong. My first version of the test above
  // assumed 1.5% always applies and failed — the code was right.
  const { body: txns } = await json('GET', `/periods/${periodId}/transactions`, { token });
  const target = txns.find((t) => t.source === 'ledger' && !t.tdsCategory);

  await json('PATCH', `/transactions/${target.id}/category`, {
    token,
    body: { category: 'service_contract' },
  });
  await json('POST', `/periods/${periodId}/reconcile`, { token });

  const { body: recomputed } = await json('GET', `/periods/${periodId}/transactions`, { token });
  const contract = recomputed.find((t) => t.id === target.id);

  assert.equal(contract.tdsPaisa, 0, 'below the threshold means nothing is due');
  assert.notEqual(contract.tdsPaisa, null, 'but it HAS been computed — that is the difference');
});

run('an unknown category is refused with the valid ones listed', async () => {
  const { body: txns } = await json('GET', `/periods/${periodId}/transactions`, { token });
  const target = txns.find((t) => t.source === 'ledger');

  const { status, body } = await json('PATCH', `/transactions/${target.id}/category`, {
    token,
    body: { category: 'creative_accounting' },
  });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'unknown_category');
  assert.match(body.error.message, /rent, professional_fee/);
});

run("another firm cannot classify this firm's transaction", async () => {
  const stranger = await json('POST', '/auth/register', {
    body: {
      firmName: 'Rival Classifiers',
      fullName: 'Someone Else',
      email: 'rival-tds@example.com',
      password: 'another-sufficiently-long-pw',
    },
  });
  const { body: txns } = await json('GET', `/periods/${periodId}/transactions`, { token });

  const { status } = await json('PATCH', `/transactions/${txns[0].id}/category`, {
    token: stranger.body.accessToken,
    body: { category: 'rent' },
  });
  assert.equal(status, 404, "another firm's transaction must be invisible");
});

run('classification decisions are written to the audit trail', async () => {
  const rows = fixture.psql(['-tA', '-c',
    "SELECT action FROM audit_log WHERE action = 'confirm_category'"]);
  assert.ok(rows.trim().length > 0, 'who classified a payment must be recoverable');
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

async function download(kind) {
  const res = await fetch(`${base}/periods/${periodId}/export/${kind}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { res, text: await res.text() };
}

run('the VAT summary exports as a spreadsheet the accountant can open', async () => {
  const { res, text } = await download('vat-summary');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="attest-vat-summary/);
  assert.match(res.headers.get('cache-control'), /no-store/);

  // A UTF-8 BOM, or Excel renders every Devanagari party name as mojibake.
  //
  // Checked as raw BYTES, not via res.text(): the Fetch spec strips a leading
  // BOM when decoding, so asserting on the decoded string tests the decoder
  // rather than what actually goes down the wire to the accountant's Excel.
  const bytes = new Uint8Array(
    await (await fetch(`${base}/periods/${periodId}/export/vat-summary`, {
      headers: { authorization: `Bearer ${token}` },
    })).arrayBuffer(),
  );
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf]);
  // 715,000 paisa = Rs. 7,150.00. The export writes rupees as a bare number so
  // the column sums in a spreadsheet without anyone stripping symbols first.
  assert.match(text, /Output VAT,7150\.00/);
  assert.match(text, /Net VAT payable,7150\.00/);
  assert.match(text, /Taxable sales,55000\.00/);
});

run('the exported summary refuses to look final', async () => {
  const { text } = await download('vat-summary');
  assert.match(text, /not filed/i);
  assert.match(text, /not final until an accountant/);
  // Open findings are stated in the export, not just on screen.
  assert.match(text, /Open findings,/);
});

run('the review report records every finding and every human decision', async () => {
  const { res, text } = await download('review-report');
  assert.equal(res.status, 200);

  assert.match(text, /Severity,Type,Status,Finding/);
  assert.match(text, /Decided by,Decided on,Reason given/);
  // The reason an accountant wrote must survive into the artefact that answers
  // "why is this figure what it is" months later.
  assert.match(text, /INV-004 was cancelled/);
  assert.match(text, /remain open|Every finding has been reviewed/);
});

run('a party name that looks like a formula cannot execute in Excel', async () => {
  // CSV injection: a cell starting with = + - or @ is run as a formula by
  // Excel and LibreOffice. A client controls party names, so this is reachable.
  const { _internals } = require('../src/services/export.service');
  for (const hostile of ['=cmd|calc', '+1+1', '-2+3', '@SUM(A1)']) {
    assert.ok(
      _internals.csvField(hostile).startsWith("'"),
      `${hostile} must be neutralised before it reaches a spreadsheet`,
    );
  }
  // But a negative AMOUNT is not a formula, and must stay a number.
  // Escaping it turns the column into text and the accountant's total silently
  // stops summing — the guard breaking the one thing they opened the file for.
  assert.equal(_internals.csvField('-5650.00'), '-5650.00');
  assert.equal(_internals.csvField('-1'), '-1');
  assert.equal(_internals.csvField('1234.56'), '1234.56');
  // A value that only starts like a number is still neutralised.
  assert.ok(_internals.csvField('-1+cmd').startsWith("'"));

  // A legitimate value is left exactly as written.
  assert.equal(_internals.csvField('Sharma Traders'), 'Sharma Traders');
  assert.equal(_internals.csvField('Sharma "Traders", Lalitpur'), '"Sharma ""Traders"", Lalitpur"');
});

run('the transaction export puts reported and computed figures side by side', async () => {
  const { text } = await download('transactions');
  assert.match(text, /Reported net,Reported VAT,Computed net,Computed VAT/);
  // The whole point of storing them separately is that someone can compare
  // them, so the export must not collapse the two into one column.
  assert.match(text, /INV-005/);
});

run('every export is written to the audit trail', async () => {
  const rows = fixture.psql(['-tA', '-c',
    "SELECT detail->>'kind' FROM audit_log WHERE action = 'export' ORDER BY created_at"]);
  const kinds = rows.trim().split('\n');
  for (const kind of ['vat_summary', 'review_report', 'transactions']) {
    assert.ok(kinds.includes(kind), `${kind} export must be audited`);
  }
});

run('another firm cannot export this period', async () => {
  const stranger = await json('POST', '/auth/register', {
    body: {
      firmName: 'Rival Exporters',
      fullName: 'Someone Else',
      email: 'rival-export@example.com',
      password: 'another-sufficiently-long-pw',
    },
  });
  const res = await fetch(`${base}/periods/${periodId}/export/vat-summary`, {
    headers: { authorization: `Bearer ${stranger.body.accessToken}` },
  });
  assert.equal(res.status, 404);
});

run('reconciling a period with nothing parsed says so plainly', async () => {
  const client = await json('POST', '/clients', { token, body: { name: 'Empty Client' } });
  const period = await json('POST', `/clients/${client.body.id}/periods`, {
    token,
    body: { bsYear: 2081, bsMonth: 5 },
  });

  const { status, body } = await json('POST', `/periods/${period.body.id}/reconcile`, { token });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'no_transactions');
});
