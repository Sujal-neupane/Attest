const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile, _internals } = require('../src/domain/reconciliation');

const bank = (id, date, paisa, extra = {}) => ({
  id,
  txnDate: date,
  amountPaisa: paisa,
  ...extra,
});

test('identical amount, date and reference match exactly', () => {
  const result = reconcile(
    [bank('b1', '2025-07-16', -1_130_000, { reference: 'INV-0042', party: 'Sharma Traders' })],
    [bank('l1', '2025-07-16', -1_130_000, { invoiceNumber: 'INV-0042', party: 'Sharma Traders Pvt Ltd' })],
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].method, 'exact');
  assert.equal(result.matches[0].confidence, 1);
  assert.equal(result.matches[0].status, 'matched');
  assert.equal(result.unmatchedBank.length, 0);
});

test('a cheque that clears three days late still matches on amount', () => {
  const result = reconcile(
    [bank('b1', '2025-07-19', -500_000, { party: 'Everest Supplies' })],
    [bank('l1', '2025-07-16', -500_000, { party: 'Everest Supplies' })],
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].method, 'strong');
  assert.equal(result.matches[0].dayDifference, 3);
});

test('a settlement gap beyond the window is left unmatched rather than force-fitted', () => {
  const result = reconcile(
    [bank('b1', '2025-07-30', -500_000, { party: 'Everest Supplies' })],
    [bank('l1', '2025-07-16', -500_000, { party: 'Everest Supplies' })],
  );
  assert.equal(result.matches.length, 0);
  assert.equal(result.unmatchedBank.length, 1);
  assert.equal(result.unmatchedLedger.length, 1);
});

test('a near amount with a similar party name matches fuzzily and flags low confidence', () => {
  const result = reconcile(
    [bank('b1', '2025-07-16', -500_050, { description: 'TRF TO HIMALAYAN TRADERS' })],
    [bank('l1', '2025-07-16', -500_000, { party: 'Himalayan Traders Pvt. Ltd.' })],
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].method, 'fuzzy');
  assert.ok(result.matches[0].confidence < 1);
  assert.equal(result.matches[0].amountDifferencePaisa, -50);
});

test('a payment never reconciles against a receipt', () => {
  const result = reconcile(
    [bank('b1', '2025-07-16', 500_000, { party: 'Himalayan Traders' })],
    [bank('l1', '2025-07-16', -500_000, { party: 'Himalayan Traders' })],
  );
  assert.equal(result.matches.length, 0);
});

test('an ambiguous tie is left for the human instead of guessed', () => {
  const result = reconcile(
    [bank('b1', '2025-07-16', -500_000, { party: 'Everest Supplies' })],
    [
      bank('l1', '2025-07-16', -500_000, { party: 'Everest Supplies' }),
      bank('l2', '2025-07-16', -500_000, { party: 'Everest Supplies' }),
    ],
  );
  assert.equal(result.matches.length, 0, 'two equally good candidates must not be auto-matched');
  assert.equal(result.unmatchedLedger.length, 2);
});

test('the exact pass claims its counterpart before a weaker pass can steal it', () => {
  const result = reconcile(
    [bank('b1', '2025-07-16', -500_000, { reference: 'INV-9', party: 'Alpha' })],
    [
      bank('lFuzzy', '2025-07-15', -500_000, { party: 'Alpha Traders' }),
      bank('lExact', '2025-07-16', -500_000, { invoiceNumber: 'INV-9', party: 'Alpha' }),
    ],
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].ledgerTxnId, 'lExact');
});

test('stats report the shape of the reconciliation honestly', () => {
  const result = reconcile(
    [
      bank('b1', '2025-07-16', -500_000, { reference: 'A1', party: 'X' }),
      bank('b2', '2025-07-17', -900_000, { party: 'Untraceable' }),
    ],
    [
      bank('l1', '2025-07-16', -500_000, { invoiceNumber: 'A1', party: 'X' }),
      bank('l2', '2025-07-20', -700_000, { party: 'Y' }),
    ],
  );
  assert.equal(result.stats.matchedCount, 1);
  assert.equal(result.stats.unmatchedBankCount, 1);
  assert.equal(result.stats.unmatchedLedgerCount, 1);
  assert.equal(result.stats.matchRate, 0.5);
});

test('empty input is not an error', () => {
  const result = reconcile([], []);
  assert.equal(result.matches.length, 0);
  assert.equal(result.stats.matchRate, 1);
});

test('party similarity ignores legal-form noise and word order', () => {
  const { partySimilarity } = _internals;
  assert.ok(partySimilarity({ party: 'Sharma Traders Pvt Ltd' }, { party: 'SHARMA TRADERS' }) > 0.9);
  assert.ok(partySimilarity({ party: 'Sharma Traders' }, { party: 'Gurung Hardware' }) < 0.4);
});
