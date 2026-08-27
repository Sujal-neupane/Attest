const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, detectDateOrder, DateError } = require('../src/utils/dates');

test('reads ISO dates', () => {
  const d = parseDate('2024-07-16');
  assert.equal(d.iso, '2024-07-16');
  assert.equal(d.calendar, 'AD');
  assert.equal(d.ambiguous, false);
});

test('reads unambiguous day-first dates without being told the order', () => {
  assert.equal(parseDate('16/07/2024').iso, '2024-07-16');
  assert.equal(parseDate('16-07-2024').iso, '2024-07-16');
  assert.equal(parseDate('16.07.2024').iso, '2024-07-16');
});

test('reads unambiguous month-first dates', () => {
  assert.equal(parseDate('07/16/2024').iso, '2024-07-16');
});

test('reads named months', () => {
  assert.equal(parseDate('16-Jul-2024').iso, '2024-07-16');
  assert.equal(parseDate('16 July 2024').iso, '2024-07-16');
  assert.equal(parseDate('Jul 16, 2024').iso, '2024-07-16');
});

test('reads compact dates', () => {
  assert.equal(parseDate('20240716').iso, '2024-07-16');
});

test('expands two-digit years', () => {
  assert.equal(parseDate('16/07/24').iso, '2024-07-16');
  assert.equal(parseDate('16/07/99').iso, '1999-07-16');
});

test('an ambiguous date is refused rather than guessed', () => {
  // 05/06/2024 is genuinely either 5 June or 6 May.
  assert.throws(() => parseDate('05/06/2024'), DateError);
});

test('an ambiguous date is resolved once the file settles the order', () => {
  assert.equal(parseDate('05/06/2024', { dayFirst: 'dmy' }).iso, '2024-06-05');
  assert.equal(parseDate('05/06/2024', { dayFirst: 'mdy' }).iso, '2024-05-06');
  assert.equal(parseDate('05/06/2024', { dayFirst: 'dmy' }).ambiguous, true);
});

test('one unambiguous row settles the order for the whole file', () => {
  const order = detectDateOrder(['05/06/2024', '16/07/2024', '01/02/2024']);
  assert.equal(order.order, 'dmy');
  assert.equal(order.evidence, '16/07/2024');
  assert.equal(order.conflict, false);
});

test('a month-first file is detected as month-first', () => {
  const order = detectDateOrder(['05/06/2024', '07/16/2024']);
  assert.equal(order.order, 'mdy');
});

test('a file containing both orders is reported as a conflict, not resolved', () => {
  const order = detectDateOrder(['16/07/2024', '07/16/2024']);
  assert.equal(order.order, null);
  assert.equal(order.conflict, true);
});

test('a file of only ambiguous dates yields no order at all', () => {
  const order = detectDateOrder(['05/06/2024', '01/02/2024']);
  assert.equal(order.order, null);
  assert.equal(order.conflict, false);
});

test('impossible dates are rejected', () => {
  assert.throws(() => parseDate('32/01/2024'), DateError);
  assert.throws(() => parseDate('31/02/2024'), DateError); // no 31 February
  assert.throws(() => parseDate('29/02/2023'), DateError); // 2023 is not a leap year
});

test('29 February is accepted in a leap year', () => {
  assert.equal(parseDate('29/02/2024').iso, '2024-02-29');
});

test('a Bikram Sambat date is identified as BS and not silently converted', () => {
  const d = parseDate('2081/04/01');
  assert.equal(d.calendar, 'BS');
  assert.equal(d.iso, null, 'BS dates must not carry a Gregorian ISO value');
  assert.equal(d.year, 2081);
});

test('a Nepali month name marks the date as Bikram Sambat', () => {
  const d = parseDate('01-Shrawan-2081');
  assert.equal(d.calendar, 'BS');
  assert.equal(d.month, 4);
  assert.equal(d.iso, null);
});

test('unreadable cells are refused', () => {
  for (const bad of ['', 'n/a', 'not a date', '16/07', '2024']) {
    assert.throws(() => parseDate(bad), DateError, `should reject ${JSON.stringify(bad)}`);
  }
});
