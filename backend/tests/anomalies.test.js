const test = require('node:test');
const assert = require('node:assert/strict');
const { detectAnomalies, SEVERITY } = require('../src/domain/anomalies');

const txn = (id, over = {}) => ({
  id,
  txnDate: '2025-07-16',
  amountPaisa: -100_000,
  kind: 'purchase',
  ...over,
});

test('the same invoice booked twice for the same amount is high severity', () => {
  const flags = detectAnomalies({
    transactions: [
      txn('t1', { invoiceNumber: 'INV-0042', party: 'Sharma Traders' }),
      txn('t2', { invoiceNumber: 'INV-0042', party: 'Sharma Traders' }),
    ],
  });
  const dup = flags.find((f) => f.type === 'duplicate_invoice');
  assert.ok(dup);
  assert.equal(dup.severity, SEVERITY.HIGH);
  assert.equal(dup.relatedTransactionIds.length, 2);
  assert.equal(dup.evidence.length, 2);
});

test('the same invoice number from different parties is not a duplicate', () => {
  const flags = detectAnomalies({
    transactions: [
      txn('t1', { invoiceNumber: '001', party: 'Sharma Traders' }),
      txn('t2', { invoiceNumber: '001', party: 'Gurung Hardware' }),
    ],
  });
  assert.equal(flags.filter((f) => f.type === 'duplicate_invoice').length, 0);
});

test('an unmatched bank payment is flagged as a missing bill', () => {
  const t = txn('b1', { amountPaisa: -3_000_000, party: 'Everest Supplies' });
  const flags = detectAnomalies({
    transactions: [t],
    reconciliation: { unmatchedBank: [t], unmatchedLedger: [], matches: [] },
  });
  const flag = flags.find((f) => f.type === 'missing_bill');
  assert.ok(flag);
  assert.equal(flag.severity, SEVERITY.HIGH); // above the Rs. 25,000 line
  assert.match(flag.message, /Rs\. 30,000\.00/);
});

test('an unmatched bank receipt is not a missing purchase bill', () => {
  const t = txn('b1', { amountPaisa: 3_000_000 });
  const flags = detectAnomalies({
    transactions: [t],
    reconciliation: { unmatchedBank: [t], unmatchedLedger: [], matches: [] },
  });
  assert.equal(flags.filter((f) => f.type === 'missing_bill').length, 0);
});

test('large round amounts are flagged, small ones are not', () => {
  const flags = detectAnomalies({
    transactions: [
      txn('t1', { amountPaisa: -5_000_000 }), // Rs. 50,000 exactly -> flagged
      txn('t2', { amountPaisa: -50_000 }), // Rs. 500 exactly -> too small to matter
      txn('t3', { amountPaisa: -5_012_300 }), // Rs. 50,123 -> not round
    ],
  });
  const round = flags.filter((f) => f.type === 'round_number');
  assert.equal(round.length, 1);
  assert.equal(round[0].transactionId, 't1');
  assert.equal(round[0].severity, SEVERITY.LOW);
});

test('a break in the sales invoice sequence is flagged with the missing numbers named', () => {
  const flags = detectAnomalies({
    transactions: [
      txn('s1', { kind: 'sale', invoiceNumber: 'INV-001' }),
      txn('s2', { kind: 'sale', invoiceNumber: 'INV-002' }),
      txn('s4', { kind: 'sale', invoiceNumber: 'INV-004' }),
    ],
  });
  const gap = flags.find((f) => f.type === 'invoice_gap');
  assert.ok(gap);
  assert.match(gap.message, /INV-003/);
  assert.equal(gap.severity, SEVERITY.HIGH);
});

test('separate invoice series are never merged into one nonsensical sequence', () => {
  const flags = detectAnomalies({
    transactions: [
      txn('a1', { kind: 'sale', invoiceNumber: 'A-001' }),
      txn('a2', { kind: 'sale', invoiceNumber: 'A-002' }),
      txn('a3', { kind: 'sale', invoiceNumber: 'A-003' }),
      txn('b1', { kind: 'sale', invoiceNumber: 'B-050' }),
      txn('b2', { kind: 'sale', invoiceNumber: 'B-051' }),
      txn('b3', { kind: 'sale', invoiceNumber: 'B-052' }),
    ],
  });
  assert.equal(flags.filter((f) => f.type === 'invoice_gap').length, 0);
});

test('purchase invoices are not checked for sequence gaps — the numbers are the supplier\'s', () => {
  const flags = detectAnomalies({
    transactions: [
      txn('p1', { kind: 'purchase', invoiceNumber: 'X-001' }),
      txn('p2', { kind: 'purchase', invoiceNumber: 'X-002' }),
      txn('p9', { kind: 'purchase', invoiceNumber: 'X-009' }),
    ],
  });
  assert.equal(flags.filter((f) => f.type === 'invoice_gap').length, 0);
});

test('a very large jump is reported as a numbering-policy question, not a missing bill', () => {
  const flags = detectAnomalies({
    transactions: [
      txn('s1', { kind: 'sale', invoiceNumber: 'INV-001' }),
      txn('s2', { kind: 'sale', invoiceNumber: 'INV-002' }),
      txn('s3', { kind: 'sale', invoiceNumber: 'INV-500' }),
    ],
  });
  const gap = flags.find((f) => f.type === 'invoice_gap');
  assert.equal(gap.severity, SEVERITY.MEDIUM);
  assert.match(gap.suggestion, /separate invoice book|series reset/);
});

test('flags come back sorted most severe first, so the reviewer starts where it matters', () => {
  const t = txn('b1', { amountPaisa: -5_000_000, party: 'Everest' });
  const flags = detectAnomalies({
    transactions: [
      t,
      txn('d1', { invoiceNumber: 'INV-1', party: 'P' }),
      txn('d2', { invoiceNumber: 'INV-1', party: 'P' }),
    ],
    reconciliation: { unmatchedBank: [t], unmatchedLedger: [], matches: [] },
  });
  const severities = flags.map((f) => f.severity);
  const rank = { high: 0, medium: 1, low: 2 };
  const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
  assert.deepEqual(severities, sorted);
});

test('clean books produce no flags at all', () => {
  const flags = detectAnomalies({
    transactions: [
      txn('t1', { invoiceNumber: 'INV-001', party: 'A', amountPaisa: -123_456 }),
      txn('t2', { invoiceNumber: 'INV-002', party: 'B', amountPaisa: -234_567 }),
    ],
    reconciliation: { unmatchedBank: [], unmatchedLedger: [], matches: [] },
  });
  assert.deepEqual(flags, []);
});
