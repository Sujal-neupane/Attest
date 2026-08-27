const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRegister } = require('../src/services/parsing/register');
const { ColumnMapError } = require('../src/services/parsing/columnMap');

const SALES = [
  'Date,Invoice No,Party Name,PAN,Taxable Amount,VAT,Total',
  '17/07/2024,INV-001,Sharma Traders,123456789,"10,000.00","1,300.00","11,300.00"',
  '18/07/2024,INV-002,Everest Retail,987654321,"20,000.00","2,600.00","22,600.00"',
  '20/07/2024,INV-003,Gurung Hardware,456789123,"5,000.00","650.00","5,650.00"',
].join('\n');

const PURCHASES = [
  'Bill Date,Bill No,Supplier,Taxable Value,VAT Amount',
  '17/07/2024,SUP-771,Kathmandu Papers,"8,000.00","1,040.00"',
  '19/07/2024,SUP-772,Pokhara Print,"3,000.00","390.00"',
].join('\n');

test('a sales register imports as ledger transactions', () => {
  const result = parseRegister(SALES, 'sales_register', { documentId: 'doc-1' });

  assert.equal(result.transactions.length, 3);
  assert.equal(result.stats.kind, 'sale');

  const [first] = result.transactions;
  assert.equal(first.source, 'ledger');
  assert.equal(first.kind, 'sale');
  assert.equal(first.txnDate, '2024-07-17');
  assert.equal(first.party, 'Sharma Traders');
  assert.equal(first.invoiceNumber, 'INV-001');
  assert.equal(first.partyPan, '123456789');
});

test('a sale is positive and a purchase negative, matching the bank convention', () => {
  const sales = parseRegister(SALES, 'sales_register', {});
  const purchases = parseRegister(PURCHASES, 'purchase_register', {});

  for (const t of sales.transactions) {
    assert.ok(t.amountPaisa > 0, 'a sale brings money in');
    assert.equal(t.direction, 'credit');
  }
  for (const t of purchases.transactions) {
    assert.ok(t.amountPaisa < 0, 'a purchase sends money out');
    assert.equal(t.direction, 'debit');
  }
});

test('the gross amount is what reconciles against the bank', () => {
  const [first] = parseRegister(SALES, 'sales_register', {}).transactions;
  // The bank sees Rs. 11,300 move, not the Rs. 10,000 taxable value.
  assert.equal(first.amountPaisa, 1_130_000);
  assert.equal(first.reportedNetPaisa, 1_000_000);
  assert.equal(first.reportedVatPaisa, 130_000);
});

test("the register's own VAT figures are kept as reported, not recomputed", () => {
  // A register that states VAT wrongly must keep its wrong figure here, so the
  // tax engine can compare and the difference becomes a finding. Silently
  // correcting it would hide exactly what the accountant is looking for.
  const wrong = [
    'Date,Invoice No,Party Name,Taxable Amount,VAT',
    '17/07/2024,INV-009,Sharma Traders,"10,000.00","1,000.00"',
  ].join('\n');

  const [txn] = parseRegister(wrong, 'sales_register', {}).transactions;
  assert.equal(txn.reportedVatPaisa, 100_000, 'the wrong figure must survive to be checked');
  assert.equal(txn.reportedNetPaisa, 1_000_000);
});

test('a register with a gross total and VAT derives the net', () => {
  const text = [
    'Date,Bill No,Supplier,Total Amount,VAT',
    '17/07/2024,SUP-1,Kathmandu Papers,"11,300.00","1,300.00"',
  ].join('\n');
  const [txn] = parseRegister(text, 'purchase_register', {}).transactions;
  assert.equal(txn.reportedNetPaisa, 1_000_000);
  assert.equal(txn.reportedVatPaisa, 130_000);
  assert.equal(txn.amountPaisa, -1_130_000);
});

test('a register with only a total leaves VAT for the tax engine to split', () => {
  const text = [
    'Date,Invoice No,Party,Amount',
    '17/07/2024,INV-1,Sharma Traders,"11,300.00"',
  ].join('\n');
  const result = parseRegister(text, 'sales_register', {});
  const [txn] = result.transactions;

  assert.equal(txn.amountPaisa, 1_130_000);
  assert.equal(txn.reportedNetPaisa, null, 'parsing must not compute the split');
  assert.equal(txn.reportedVatPaisa, null);
  assert.ok(result.notes.some((n) => /VAT-inclusive/.test(n)));
});

test('the amount shape is decided once for the file, not per row', () => {
  const result = parseRegister(SALES, 'sales_register', {});
  const shapes = new Set(result.transactions.map((t) => t.sourceRef.amountShape));
  assert.equal(shapes.size, 1, 'one file must be read one way throughout');
  assert.equal([...shapes][0], 'net_plus_vat');
});

test('VAT larger than the gross total is reported, not accepted', () => {
  const text = [
    'Date,Invoice No,Party,Total Amount,VAT',
    '17/07/2024,INV-1,Sharma Traders,"1,000.00","1,300.00"',
  ].join('\n');
  const result = parseRegister(text, 'sales_register', {});
  assert.equal(result.transactions.length, 0);
  assert.match(result.issues[0].reason, /larger than its gross total/);
});

test('a sales row with no invoice number is flagged but still imported', () => {
  const text = [
    'Date,Invoice No,Party,Taxable Amount,VAT',
    '17/07/2024,,Sharma Traders,"10,000.00","1,300.00"',
  ].join('\n');
  const result = parseRegister(text, 'sales_register', {});
  assert.equal(result.transactions.length, 1, 'the entry is still real money');
  assert.match(result.issues[0].reason, /no invoice number/);
});

test('every transaction carries provenance back to its row', () => {
  const result = parseRegister(SALES, 'sales_register', { documentId: 'doc-1' });
  for (const t of result.transactions) {
    assert.equal(t.documentId, 'doc-1');
    assert.ok(Number.isInteger(t.sourceRef.row));
    assert.ok(t.sourceRef.raw.date, 'the original text is kept verbatim');
  }
  assert.equal(result.transactions[0].sourceRef.raw.taxableAmount, '10,000.00');
});

test('a register dated in Bikram Sambat is converted and keeps the BS label', () => {
  const text = [
    'Date,Invoice No,Party,Taxable Amount,VAT',
    '2081/04/01,INV-1,Sharma Traders,"10,000.00","1,300.00"',
  ].join('\n');
  const [txn] = parseRegister(text, 'sales_register', {}).transactions;
  assert.equal(txn.txnDate, '2024-07-16');
  assert.equal(txn.bsDate, 'Shrawan 1, 2081');
});

test('entries outside the period are imported but flagged', () => {
  const result = parseRegister(SALES, 'sales_register', {
    periodStart: '2024-07-16',
    periodEnd: '2024-07-18',
  });
  const outside = result.transactions.filter((t) => t.outsidePeriod);
  assert.equal(outside.length, 1, 'the 20 July entry falls outside');
  assert.ok(result.issues.some((i) => /outside the period/.test(i.reason)));
});

test('a register with no amount column at all is refused', () => {
  const text = 'Date,Invoice No,Party\n17/07/2024,INV-1,Sharma Traders\n';
  assert.throws(() => parseRegister(text, 'sales_register', {}), ColumnMapError);
});

test('the importer accounts for every row it read', () => {
  const result = parseRegister(SALES, 'sales_register', {});
  assert.equal(result.transactions.length, result.stats.rowsRead);
});
