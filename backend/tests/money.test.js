const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../src/domain/money');

test('parseAmount handles the formats real bank exports actually contain', () => {
  assert.equal(money.parseAmount('1234.50'), 123450);
  assert.equal(money.parseAmount('1,234.50'), 123450);
  assert.equal(money.parseAmount('Rs. 1,234.50'), 123450);
  assert.equal(money.parseAmount('NPR 1,234.50'), 123450);
  assert.equal(money.parseAmount('1234'), 123400);
  assert.equal(money.parseAmount('  1234.5 '), 123450);
  assert.equal(money.parseAmount(1234.5), 123450);
});

test('parseAmount reads accounting negatives', () => {
  assert.equal(money.parseAmount('(1,234.50)'), -123450);
  assert.equal(money.parseAmount('-1234.50'), -123450);
  assert.equal(money.parseAmount('1234.50 Dr'), -123450);
  assert.equal(money.parseAmount('1234.50 Cr'), 123450);
});

test('parseAmount refuses to guess at garbage rather than importing a wrong figure', () => {
  for (const bad of ['', 'n/a', '12.3.4', 'abc', '--5', {}, null, undefined, NaN]) {
    assert.throws(() => money.parseAmount(bad), money.MoneyError, `should reject ${String(bad)}`);
  }
});

test('float arithmetic that would drift is exact in paisa', () => {
  // The canonical failure: 0.1 + 0.2 !== 0.3 in floating point.
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(money.sum([money.parseAmount('0.1'), money.parseAmount('0.2')]), 30);
  assert.equal(money.toRupees(30), 0.3);
});

test('a thousand small amounts sum without drift', () => {
  const amounts = Array.from({ length: 1000 }, () => money.parseAmount('0.07'));
  assert.equal(money.sum(amounts), 7000); // Rs. 70.00 exactly
});

test('applyRate rounds half-up away from zero', () => {
  assert.equal(money.applyRate(100, 1300), 13); // 13% of Rs. 1.00 = 13 paisa
  assert.equal(money.applyRate(50, 100), 1); // 1% of 50 paisa = 0.5 -> 1
  assert.equal(money.applyRate(-50, 100), -1); // ties round away from zero
  assert.equal(money.applyRate(0, 1300), 0);
});

test('extractInclusive is the exact inverse of applyRate at the boundary', () => {
  const net = 100000; // Rs. 1,000.00
  const vat = money.applyRate(net, 1300);
  const gross = net + vat;
  assert.equal(money.extractInclusive(gross, 1300), vat);
});

test('format renders a figure an accountant can read', () => {
  assert.equal(money.format(123450), '1,234.50');
  assert.equal(money.format(-123450), '-1,234.50');
  assert.equal(money.format(5), '0.05');
  assert.equal(money.format(123450, { withSymbol: true }), 'Rs. 1,234.50');
});

test('non-integer paisa is rejected everywhere, not silently rounded', () => {
  assert.throws(() => money.assertPaisa(12.5), money.MoneyError);
  assert.throws(() => money.applyRate(12.5, 1300), money.MoneyError);
  assert.throws(() => money.applyRate(100, 0.13), money.MoneyError);
});
