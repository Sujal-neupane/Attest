const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBankStatement } = require('../src/services/parsing/bankStatement');
const { buildColumnMap, ColumnMapError } = require('../src/services/parsing/columnMap');
const { DateError } = require('../src/utils/dates');

// A realistically messy export: branding preamble, a misspelt column header
// (Nabil genuinely writes "Withdrawl"), commas inside narrations, a blank line,
// and a trailing total.
const NABIL_STATEMENT = [
  'NABIL BANK LIMITED',
  'Statement of Account',
  'Account No: 0123456789012345',
  '',
  'Date,Narration,Withdrawl,Deposit,Balance',
  '16/07/2024,OPENING BALANCE,,,"1,00,000.00"',
  '17/07/2024,"TRF TO SHARMA TRADERS, LALITPUR","11,300.00",,"88,700.00"',
  '18/07/2024,IPS/FT FROM EVEREST RETAIL,,"22,600.00","1,11,300.00"',
  '20/07/2024,CHQ 004521 PAID TO GURUNG HARDWARE,"5,650.00",,"1,05,650.00"',
  'TOTAL,,"16,950.00","22,600.00",',
].join('\n');

test('imports a messy real-world statement end to end', () => {
  const result = parseBankStatement(NABIL_STATEMENT, { documentId: 'doc-1' });

  // The opening-balance row has no amount, so it is reported, not imported.
  assert.equal(result.transactions.length, 3);
  assert.equal(result.stats.debits, 2);
  assert.equal(result.stats.credits, 1);

  const [payment, receipt] = result.transactions;
  assert.equal(payment.txnDate, '2024-07-17');
  assert.equal(payment.amountPaisa, -1_130_000);
  assert.equal(payment.direction, 'debit');
  assert.equal(receipt.amountPaisa, 2_260_000);
  assert.equal(receipt.direction, 'credit');
});

test('a misspelt bank column is still understood', () => {
  const { map } = buildColumnMap(
    ['Date', 'Narration', 'Withdrawl', 'Deposit', 'Balance'],
    'bank_statement',
  );
  assert.equal(map.debit, 'Withdrawl');
  assert.equal(map.credit, 'Deposit');
});

test('money out is stored negative and money in positive', () => {
  const result = parseBankStatement(NABIL_STATEMENT, {});
  for (const t of result.transactions) {
    if (t.direction === 'debit') assert.ok(t.amountPaisa < 0, 'a debit must be negative');
    else assert.ok(t.amountPaisa > 0, 'a credit must be positive');
  }
});

test('the counterparty is pulled out of the narration', () => {
  const result = parseBankStatement(NABIL_STATEMENT, {});
  assert.equal(result.transactions[0].party, 'SHARMA TRADERS, LALITPUR');
  assert.equal(result.transactions[1].party, 'EVEREST RETAIL');
});

test('every transaction carries provenance back to its row', () => {
  const result = parseBankStatement(NABIL_STATEMENT, { documentId: 'doc-1' });
  for (const t of result.transactions) {
    assert.equal(t.documentId, 'doc-1');
    assert.ok(Number.isInteger(t.sourceRef.row), 'sourceRef must name the row');
    assert.ok(t.sourceRef.raw.date, 'sourceRef must keep the raw text as written');
  }
  // The raw value is kept exactly as the bank wrote it, so a parsing dispute
  // can be settled against the original rather than against our reading of it.
  assert.equal(result.transactions[0].sourceRef.raw.debit, '11,300.00');
});

test("the statement's own running balance verifies the import is complete", () => {
  const result = parseBankStatement(NABIL_STATEMENT, {});
  assert.ok(result.balanceCheck);
  assert.equal(result.balanceCheck.consistent, true);
  assert.equal(result.balanceCheck.closingBalancePaisa, 10_565_000);
  assert.ok(result.notes.some((n) => /import is complete/.test(n)));
});

test('a missing row is caught by the running balance rather than passing silently', () => {
  // The 18/07 receipt has been dropped from the export, exactly as happens when
  // someone filters a spreadsheet before sending it.
  const short = NABIL_STATEMENT.split('\n')
    .filter((l) => !l.includes('EVEREST RETAIL'))
    .join('\n');

  const result = parseBankStatement(short, {});
  assert.equal(result.balanceCheck.consistent, false);
  assert.equal(result.balanceCheck.breaks.length, 1);
  assert.equal(result.balanceCheck.breaks[0].differencePaisa, 2_260_000);
  assert.ok(result.notes.some((n) => /rows are missing/.test(n)));
});

test('a row with both a debit and a credit is reported, not averaged', () => {
  const text = [
    'Date,Narration,Debit,Credit',
    '16/07/2024,IMPOSSIBLE,500,700',
  ].join('\n');
  const result = parseBankStatement(text, {});
  assert.equal(result.transactions.length, 0);
  assert.equal(result.issues[0].severity, 'error');
  assert.match(result.issues[0].reason, /cannot be both/);
});

test('an unreadable row is reported with its line number, never dropped silently', () => {
  const text = [
    'Date,Narration,Debit,Credit',
    '16/07/2024,GOOD,500,',
    'not-a-date,BAD,700,',
  ].join('\n');
  const result = parseBankStatement(text, {});
  assert.equal(result.transactions.length, 1);
  const error = result.issues.find((i) => i.severity === 'error');
  assert.equal(error.rowNumber, 3);
  assert.match(error.raw, /BAD/);
});

test('transactions outside the fiscal period are imported but flagged', () => {
  const text = [
    'Date,Narration,Debit,Credit',
    '16/07/2024,IN PERIOD,500,',
    '16/09/2024,OUT OF PERIOD,700,',
  ].join('\n');
  const result = parseBankStatement(text, {
    periodStart: '2024-07-16',
    periodEnd: '2024-08-16',
  });
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[1].outsidePeriod, true);
  assert.ok(result.issues.some((i) => /outside the period/.test(i.reason)));
});

test('a file with no amount column is refused rather than half-imported', () => {
  const text = 'Date,Narration,Reference\n16/07/2024,PAYMENT,X1\n';
  assert.throws(() => parseBankStatement(text, {}), ColumnMapError);
});

test('a debit column with no matching credit column is treated as a detection failure', () => {
  const text = 'Date,Narration,Withdrawl\n16/07/2024,PAYMENT,500\n';
  assert.throws(() => parseBankStatement(text, {}), ColumnMapError);
});

test('a statement with a single signed amount column works too', () => {
  const text = [
    'Date,Particulars,Amount',
    '16/07/2024,PAYMENT,"(11,300.00)"',
    '17/07/2024,RECEIPT,"22,600.00"',
  ].join('\n');
  const result = parseBankStatement(text, {});
  assert.equal(result.transactions[0].amountPaisa, -1_130_000);
  assert.equal(result.transactions[0].direction, 'debit');
  assert.equal(result.transactions[1].amountPaisa, 2_260_000);
});

test('a file dated in Bikram Sambat is converted to Gregorian', () => {
  const text = [
    'Date,Particulars,Amount',
    '2081/04/01,PAYMENT,500',
    '2081/04/15,RECEIPT,-700',
  ].join('\n');
  const result = parseBankStatement(text, {});

  // Shrawan 1, 2081 is 16 July 2024 — the first day of FY 2081-82.
  assert.equal(result.transactions[0].txnDate, '2024-07-16');
  assert.equal(result.transactions[1].txnDate, '2024-07-30');
  assert.ok(result.notes.some((n) => /Bikram Sambat/.test(n)));
});

test('a converted transaction keeps the Bikram Sambat date the client wrote', () => {
  const text = 'Date,Particulars,Amount\n2081/04/01,PAYMENT,500\n';
  const [txn] = parseBankStatement(text, {}).transactions;
  assert.equal(txn.bsDate, 'Shrawan 1, 2081');
  assert.equal(txn.sourceRef.raw.date, '2081/04/01', 'the original text is kept verbatim');
});

test('a BS date beyond the verified calendar range is refused, not extrapolated', () => {
  const text = 'Date,Particulars,Amount\n2099/04/01,PAYMENT,500\n';
  const result = parseBankStatement(text, {});
  assert.equal(result.transactions.length, 0);
  assert.match(result.issues.find((i) => i.severity === 'error').reason, /outside the range/);
});

test('a Gregorian file gets no Bikram Sambat label', () => {
  const text = 'Date,Particulars,Amount\n16/07/2024,PAYMENT,500\n';
  const [txn] = parseBankStatement(text, {}).transactions;
  assert.equal(txn.bsDate, null);
});

test('a file with contradictory date orders is rejected rather than half-read', () => {
  const text = [
    'Date,Particulars,Amount',
    '16/07/2024,A,500',
    '07/16/2024,B,700',
  ].join('\n');
  assert.throws(() => parseBankStatement(text, {}), DateError);
});

test('ambiguous dates are resolved by the one unambiguous row in the file', () => {
  const text = [
    'Date,Particulars,Amount',
    '05/06/2024,AMBIGUOUS,500',
    '16/07/2024,SETTLES IT,700',
  ].join('\n');
  const result = parseBankStatement(text, {});
  assert.equal(result.transactions[0].txnDate, '2024-06-05');
  assert.ok(result.notes.some((n) => /day\/month\/year/.test(n)));
});

test('zero-amount rows are reported rather than imported as transactions', () => {
  const text = 'Date,Particulars,Amount\n16/07/2024,CANCELLED,0\n';
  const result = parseBankStatement(text, {});
  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].reason, /zero amount/);
});

test('the importer accounts for every row it read', () => {
  const result = parseBankStatement(NABIL_STATEMENT, {});
  const accountedFor = result.transactions.length + result.issues.filter(
    (i) => i.severity === 'error' || /zero amount/.test(i.reason),
  ).length;
  assert.equal(
    accountedFor,
    result.stats.rowsRead,
    'every row must become a transaction or an issue — none may vanish',
  );
});
