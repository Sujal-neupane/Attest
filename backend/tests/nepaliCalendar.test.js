const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../src/utils/nepaliCalendar');
const table = require('../db/data/bs-calendar.json');

test('known Nepali New Year dates convert correctly', () => {
  // These come from outside the generated table — they are the check that
  // catches the generator's two sources agreeing on a wrong answer.
  assert.equal(cal.bsToAd({ year: 2080, month: 1, day: 1 }), '2023-04-14');
  assert.equal(cal.bsToAd({ year: 2081, month: 1, day: 1 }), '2024-04-13');
  assert.equal(cal.bsToAd({ year: 2082, month: 1, day: 1 }), '2025-04-14');
});

test('the reverse direction agrees on those same dates', () => {
  assert.deepEqual(pick(cal.adToBs('2023-04-14')), { year: 2080, month: 1, day: 1 });
  assert.deepEqual(pick(cal.adToBs('2024-04-13')), { year: 2081, month: 1, day: 1 });
  assert.deepEqual(pick(cal.adToBs('2025-04-14')), { year: 2082, month: 1, day: 1 });
});

test('round-trips exactly for every single day in the supported range', () => {
  // The strongest available check: ~6,200 conversions, each one out and back.
  // An off-by-one anywhere in the offset arithmetic fails here immediately.
  let checked = 0;
  for (let year = table.firstYear; year <= table.lastYear; year++) {
    const lengths = table.monthLengths[String(year)];
    for (let month = 1; month <= 12; month++) {
      for (let day = 1; day <= lengths[month - 1]; day++) {
        const ad = cal.bsToAd({ year, month, day });
        const back = cal.adToBs(ad);
        assert.deepEqual(
          pick(back),
          { year, month, day },
          `round trip failed at BS ${year}-${month}-${day} (AD ${ad})`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 6000, `expected thousands of dates, checked ${checked}`);
});

test('consecutive BS days are consecutive Gregorian days across a month boundary', () => {
  // Month boundaries are where a wrong table shows up, and where a misfiled
  // transaction lands in the wrong VAT period.
  const lastOfShrawan = table.monthLengths['2081'][3];
  const endOfMonth = cal.bsToAd({ year: 2081, month: 4, day: lastOfShrawan });
  const startOfNext = cal.bsToAd({ year: 2081, month: 5, day: 1 });
  assert.equal(dayGap(endOfMonth, startOfNext), 1);
});

test('consecutive BS days are consecutive Gregorian days across a year boundary', () => {
  const lastOfChaitra = table.monthLengths['2081'][11];
  const endOfYear = cal.bsToAd({ year: 2081, month: 12, day: lastOfChaitra });
  const newYear = cal.bsToAd({ year: 2082, month: 1, day: 1 });
  assert.equal(dayGap(endOfYear, newYear), 1);
});

test('the fiscal year runs Shrawan 1 to the last day of Ashadh', () => {
  const fy = cal.fiscalYearRange(2081);
  assert.equal(fy.label, 'FY 2081-82');
  assert.equal(fy.startDate, cal.bsToAd({ year: 2081, month: 4, day: 1 }));
  assert.deepEqual(pick(cal.adToBs(fy.startDate)), { year: 2081, month: 4, day: 1 });

  const end = cal.adToBs(fy.endDate);
  assert.equal(end.year, 2082);
  assert.equal(end.month, 3, 'a fiscal year ends in Ashadh');
  assert.equal(end.day, table.monthLengths['2082'][2], 'on the last day of it');

  // And the day after the fiscal year ends is the first day of the next one.
  const nextFy = cal.fiscalYearRange(2082);
  assert.equal(dayGap(fy.endDate, nextFy.startDate), 1);
});

test('a monthly VAT period covers exactly that month and no more', () => {
  const shrawan = cal.monthRange(2081, 4);
  assert.equal(shrawan.label, 'Shrawan 2081');
  const length = table.monthLengths['2081'][3];
  assert.equal(dayGap(shrawan.startDate, shrawan.endDate), length - 1);
  assert.deepEqual(pick(cal.adToBs(shrawan.startDate)), { year: 2081, month: 4, day: 1 });
  assert.deepEqual(pick(cal.adToBs(shrawan.endDate)), { year: 2081, month: 4, day: length });
});

test('a day that does not exist in a BS month is refused', () => {
  const length = table.monthLengths['2081'][3]; // Shrawan
  assert.throws(
    () => cal.bsToAd({ year: 2081, month: 4, day: length + 1 }),
    cal.NepaliCalendarError,
  );
  assert.throws(() => cal.bsToAd({ year: 2081, month: 13, day: 1 }), cal.NepaliCalendarError);
  assert.throws(() => cal.bsToAd({ year: 2081, month: 4, day: 0 }), cal.NepaliCalendarError);
});

test('a year outside the verified range is refused, never extrapolated', () => {
  assert.throws(
    () => cal.bsToAd({ year: table.lastYear + 1, month: 1, day: 1 }),
    (err) =>
      err instanceof cal.NepaliCalendarError && /outside the range/.test(err.message),
  );
  assert.throws(
    () => cal.bsToAd({ year: table.firstYear - 1, month: 1, day: 1 }),
    cal.NepaliCalendarError,
  );
  assert.throws(() => cal.adToBs('1990-01-01'), cal.NepaliCalendarError);
});

test('the shipped table is internally consistent', () => {
  for (let year = table.firstYear; year <= table.lastYear; year++) {
    const months = table.monthLengths[String(year)];
    assert.equal(months.length, 12, `BS ${year} must have 12 months`);
    const total = months.reduce((a, b) => a + b, 0);
    assert.ok(total === 365 || total === 366, `BS ${year} sums to ${total}`);
    for (const [i, len] of months.entries()) {
      assert.ok(len >= 29 && len <= 32, `BS ${year} month ${i + 1} has ${len} days`);
    }
  }
});

test('each year length matches the gap between successive New Year dates', () => {
  // An independent check on the table: this catches a month length that is
  // wrong in one direction and compensated for in another.
  for (let year = table.firstYear; year < table.lastYear; year++) {
    const thisNy = cal.bsToAd({ year, month: 1, day: 1 });
    const nextNy = cal.bsToAd({ year: year + 1, month: 1, day: 1 });
    const total = table.monthLengths[String(year)].reduce((a, b) => a + b, 0);
    assert.equal(dayGap(thisNy, nextNy), total, `BS ${year} length disagrees with its span`);
  }
});

function pick({ year, month, day }) {
  return { year, month, day };
}

function dayGap(from, to) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}
