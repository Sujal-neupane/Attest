const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, toRecords, findHeaderRow, CsvError } = require('../src/services/parsing/csv');

test('reads a plain comma-separated file', () => {
  const { rows } = parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
});

test('keeps commas inside quoted fields', () => {
  const { rows } = parseCsv('date,narration,amount\n2024-07-16,"TRF TO SHARMA TRADERS, LALITPUR",500\n');
  assert.equal(rows[1][1], 'TRF TO SHARMA TRADERS, LALITPUR');
  assert.equal(rows[1][2], '500');
});

test('handles doubled quotes inside a quoted field', () => {
  const { rows } = parseCsv('a\n"He said ""paid"" twice"\n');
  assert.equal(rows[1][0], 'He said "paid" twice');
});

test('strips the byte order mark Excel writes', () => {
  const { rows, notes } = parseCsv('﻿date,amount\n2024-07-16,500\n');
  assert.equal(rows[0][0], 'date');
  assert.ok(notes.some((n) => /byte order mark/i.test(n)));
});

test('handles CRLF line endings', () => {
  const { rows } = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('detects a semicolon-delimited export', () => {
  const { rows, delimiter } = parseCsv('date;narration;amount\n2024-07-16;PAYMENT;500\n');
  assert.equal(delimiter, ';');
  assert.equal(rows[1][2], '500');
});

test('a description full of commas does not beat the real delimiter', () => {
  // Raw-count sniffing picks "," here and gets it wrong; consistency does not.
  const text =
    'date;narration;amount\n' +
    '2024-07-16;PAID TO SHARMA, LALITPUR, BAGMATI;500\n' +
    '2024-07-17;PAID TO GURUNG, POKHARA, GANDAKI;700\n';
  const { delimiter, rows } = parseCsv(text);
  assert.equal(delimiter, ';');
  assert.equal(rows[1].length, 3);
});

test('an unclosed quote is reported, not silently truncated', () => {
  assert.throws(() => parseCsv('a,b\n1,"unterminated\n'), CsvError);
});

test('finds the real header under a bank preamble', () => {
  const text = [
    'NABIL BANK LIMITED',
    'Statement of Account',
    'Account: 0123456789012345',
    'Period: 16-Jul-2024 to 16-Aug-2024',
    '',
    'Date,Narration,Debit,Credit,Balance',
    '16/07/2024,OPENING,,,100000',
  ].join('\n');

  const { rows } = parseCsv(text);
  const { headerIndex, header, preamble } = findHeaderRow(rows);
  assert.equal(header[0], 'Date');
  assert.equal(preamble.length, headerIndex);
  assert.ok(headerIndex > 0, 'header should not be row 0');
});

test('toRecords keys rows by header and drops the trailing total line', () => {
  const text = [
    'Date,Narration,Debit,Credit',
    '16/07/2024,PAYMENT,500,',
    '17/07/2024,RECEIPT,,700',
    'TOTAL,,500,700',
  ].join('\n');

  const { records, skipped } = toRecords(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].values.Narration, 'PAYMENT');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /summary/);
});

test('row numbers point at the line a human would count in the file', () => {
  const text = 'Date,Amount\n16/07/2024,500\n17/07/2024,700\n';
  const { records } = toRecords(text);
  assert.equal(records[0].rowNumber, 2);
  assert.equal(records[1].rowNumber, 3);
});

test('a ragged row is recovered but recorded rather than dropped', () => {
  const text = 'Date,Narration,Debit,Credit\n16/07/2024,PAYMENT,500\n';
  const { records, skipped } = toRecords(text);
  assert.equal(records.length, 1, 'the row should still be imported');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /3 columns, header has 4/);
});

test('a file with no header row is refused rather than guessed at', () => {
  assert.throws(() => toRecords('16/07/2024,500\n17/07/2024,700\n'), CsvError);
});

test('an empty file is refused', () => {
  assert.throws(() => parseCsv('\n\n\n'), CsvError);
});
