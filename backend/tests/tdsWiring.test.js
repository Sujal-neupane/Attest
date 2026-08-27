const test = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('../src/services/review.service');

const { attachTds, flagUnconfirmedCategories } = _internals;

/**
 * TDS, as the pipeline actually applies it.
 *
 * domain/tax.js proves the arithmetic. These prove the RULE around it: that a
 * figure is only computed once a person has said what the payment is, and that
 * the Sec. 89 threshold accumulates across a payee's bills rather than being
 * judged one invoice at a time.
 */

const entry = (over = {}) => {
  const txn = {
    id: over.id ?? 'txn-1',
    txnDate: over.txnDate ?? '2024-07-17',
    party: over.party ?? 'Sharma Traders',
    invoiceNumber: over.invoiceNumber ?? 'INV-001',
    tdsCategory: over.tdsCategory ?? null,
    categorySource: over.categorySource ?? null,
    categoryConfirmedBy: over.categoryConfirmedBy ?? null,
    amountPaisa: over.amountPaisa ?? -1_130_000,
    documentId: 'doc-1',
    sourceRef: { row: 2 },
  };
  return { id: txn.id, netPaisa: over.netPaisa ?? 1_000_000, vatPaisa: 130_000, txn, vat: {} };
};

test('TDS is computed once a human has confirmed the classification', () => {
  const [result] = attachTds([
    entry({ tdsCategory: 'rent', categorySource: 'human', categoryConfirmedBy: 'user-1',
            netPaisa: 5_000_000 }),
  ]);

  assert.equal(result.tdsPaisa, 500_000, '10% of Rs. 50,000');
  assert.equal(result.tds.section, 'Sec. 88(1)');
});

test('AN AI SUGGESTION ALONE COMPUTES NOTHING', () => {
  // The heart of it. A category a model proposed is a proposal, and deducting
  // tax on a proposal is exactly what this product exists not to do.
  const [result] = attachTds([
    entry({ tdsCategory: 'rent', categorySource: 'ai', categoryConfirmedBy: null }),
  ]);

  assert.equal(result.tdsPaisa, null);
});

test('an unclassified entry gets null, never zero', () => {
  const [result] = attachTds([entry({ tdsCategory: null })]);

  // null means "nobody has decided"; zero would mean "decided, and none is
  // due". Only one of those is true, and writing the wrong one understates a
  // return without anything looking wrong.
  assert.equal(result.tdsPaisa, null);
  assert.notEqual(result.tdsPaisa, 0);
});

test('a category the engine does not recognise computes nothing rather than throwing', () => {
  const [result] = attachTds([
    entry({ tdsCategory: 'made_up_category', categoryConfirmedBy: 'user-1' }),
  ]);
  assert.equal(result.tdsPaisa, null);
});

test('THE SEC. 89 THRESHOLD ACCUMULATES ACROSS A PAYEE, NOT PER BILL', () => {
  // Two payments of Rs. 30,000 to the same supplier. Judged one at a time both
  // fall under the Rs. 50,000 threshold and no tax is withheld at all — which
  // is precisely the arrangement the cumulative rule exists to catch.
  const results = attachTds([
    entry({ id: 'a', txnDate: '2024-07-17', netPaisa: 3_000_000,
            tdsCategory: 'service_contract', categoryConfirmedBy: 'user-1' }),
    entry({ id: 'b', txnDate: '2024-07-25', netPaisa: 3_000_000,
            tdsCategory: 'service_contract', categoryConfirmedBy: 'user-1' }),
  ]);

  const first = results.find((r) => r.id === 'a');
  const second = results.find((r) => r.id === 'b');

  assert.equal(first.tdsPaisa, 0, 'the first bill is genuinely below the threshold');
  assert.equal(second.tdsPaisa, 45_000, '1.5% of Rs. 30,000 once the total crosses Rs. 50,000');
});

test('the threshold is applied in date order, not the order rows arrive', () => {
  // Rows come back from the database in whatever order a query returns them.
  // Accumulating in that order would attribute the threshold crossing to the
  // wrong bill.
  const results = attachTds([
    entry({ id: 'later', txnDate: '2024-07-25', netPaisa: 3_000_000,
            tdsCategory: 'service_contract', categoryConfirmedBy: 'u' }),
    entry({ id: 'earlier', txnDate: '2024-07-17', netPaisa: 3_000_000,
            tdsCategory: 'service_contract', categoryConfirmedBy: 'u' }),
  ]);

  assert.equal(results.find((r) => r.id === 'earlier').tdsPaisa, 0);
  assert.equal(results.find((r) => r.id === 'later').tdsPaisa, 45_000);
});

test('different payees do not pool towards one threshold', () => {
  const results = attachTds([
    entry({ id: 'a', party: 'Sharma Traders', netPaisa: 3_000_000,
            tdsCategory: 'service_contract', categoryConfirmedBy: 'u' }),
    entry({ id: 'b', party: 'Gurung Hardware', netPaisa: 3_000_000,
            tdsCategory: 'service_contract', categoryConfirmedBy: 'u' }),
  ]);

  // Two separate suppliers at Rs. 30,000 each are both genuinely under the
  // threshold. Pooling them would withhold tax that is not due.
  for (const result of results) assert.equal(result.tdsPaisa, 0);
});

test('the same payee written differently is still the same payee', () => {
  const results = attachTds([
    entry({ id: 'a', party: 'Sharma Traders', netPaisa: 3_000_000,
            tdsCategory: 'service_contract', categoryConfirmedBy: 'u' }),
    entry({ id: 'b', party: '  SHARMA TRADERS ', txnDate: '2024-07-25', netPaisa: 3_000_000,
            tdsCategory: 'service_contract', categoryConfirmedBy: 'u' }),
  ]);

  assert.equal(results.find((r) => r.id === 'b').tdsPaisa, 45_000, 'casing must not reset it');
});

test('rent has no threshold, so the first rupee is withheld on', () => {
  const [result] = attachTds([
    entry({ netPaisa: 1_000_000, tdsCategory: 'rent', categoryConfirmedBy: 'u' }),
  ]);
  assert.equal(result.tdsPaisa, 100_000, '10% from the start');
});

// ---------------------------------------------------------------------------
// The flag that asks the human
// ---------------------------------------------------------------------------

test('an unconfirmed classification raises a flag naming who proposed it', () => {
  const [flag] = flagUnconfirmedCategories([
    { id: 't1', txnDate: '2024-07-17', party: 'Sharma Traders', invoiceNumber: 'INV-001',
      tdsCategory: 'rent', categorySource: 'ai', categoryConfirmedBy: null,
      amountPaisa: -1_130_000, sourceRef: {} },
  ]);

  assert.ok(flag);
  assert.equal(flag.severity, 'medium');
  assert.match(flag.message, /classified as "Rent" by AI/);
  assert.match(flag.message, /nobody has confirmed it/);
  assert.match(flag.message, /No TDS has been computed/);
  // The evidence records what was proposed, so accepting it is one decision
  // rather than a lookup.
  assert.equal(flag.evidence[0].proposedCategory, 'rent');
  assert.equal(flag.evidence[0].proposedBy, 'ai');
});

test('a confirmed classification raises no flag', () => {
  const flags = flagUnconfirmedCategories([
    { id: 't1', txnDate: '2024-07-17', tdsCategory: 'rent',
      categorySource: 'human', categoryConfirmedBy: 'user-1', sourceRef: {} },
  ]);
  assert.deepEqual(flags, []);
});

test('an entry with no classification at all raises no category flag', () => {
  // Not every payment attracts TDS. Asking about all of them would bury the
  // ones that genuinely need a decision.
  const flags = flagUnconfirmedCategories([
    { id: 't1', txnDate: '2024-07-17', tdsCategory: null, sourceRef: {} },
  ]);
  assert.deepEqual(flags, []);
});

test('the flag says why the decision matters, not just that one is needed', () => {
  const [flag] = flagUnconfirmedCategories([
    { id: 't1', txnDate: '2024-07-17', tdsCategory: 'professional_fee',
      categorySource: 'ai', categoryConfirmedBy: null, sourceRef: {} },
  ]);
  assert.match(flag.suggestion, /a deduction made on a\s+suggestion is not one anybody can defend/);
});

// ---------------------------------------------------------------------------
// OCR-derived figures
// ---------------------------------------------------------------------------

const { flagOcrDerivedFigures } = _internals;

test('a figure read by OCR is flagged for a second look', () => {
  const [flag] = flagOcrDerivedFigures([
    { id: 't1', txnDate: '2024-07-17', invoiceNumber: 'INV-9', amountPaisa: -1_130_000,
      sourceRef: { readMethod: 'ocr' } },
  ]);

  assert.ok(flag);
  // Low, not high: most OCR is correct, and crying wolf on every scan trains
  // the reviewer to skip the ones that matter.
  assert.equal(flag.severity, 'low');
  assert.match(flag.message, /read by OCR from a scan/);
  assert.match(flag.suggestion, /a 3 read as an 8 looks exactly as correct as a 3/);
});

test('a figure read from a real text layer is not flagged', () => {
  const flags = flagOcrDerivedFigures([
    { id: 't1', txnDate: '2024-07-17', sourceRef: { readMethod: 'text_layer' } },
    { id: 't2', txnDate: '2024-07-18', sourceRef: {} },
  ]);
  assert.deepEqual(flags, []);
});
