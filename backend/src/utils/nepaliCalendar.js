/**
 * Bikram Sambat ↔ Gregorian conversion.
 *
 * BS month lengths are not derivable from a formula — unlike the Gregorian leap
 * rule, each BS month runs 29 to 32 days and the pattern varies year to year.
 * Conversion is therefore table-driven, and the table is the whole story.
 *
 * ─── ABOUT THE TABLE ────────────────────────────────────────────────────────
 *
 * db/data/bs-calendar.json is generated, not hand-written and not required from
 * a package at runtime. The generator consults two independently-written
 * converter implementations for every single day in the range and only emits
 * the table if they agree on all of them, then checks the result three more
 * ways: every year sums to 365 or 366, every month is 29–32 days, and each
 * year's total equals the Gregorian gap between its own Baisakh 1 and the next
 * year's. Finally it checks known Nepali New Year dates that come from neither
 * package, so both agreeing on a wrong answer is still caught.
 *
 * The two implementations turned out to diverge from BS 2087 onward, where the
 * published calendar is provisional and each had extrapolated differently. The
 * table stops at the last year they agree on. That divergence is information,
 * not noise: it marks the point past which nobody actually knows the answer.
 *
 * ─── WHY OUT-OF-RANGE THROWS ────────────────────────────────────────────────
 *
 * A wrong conversion here is invisible. It does not throw, it does not look
 * wrong on screen — it silently moves a transaction into the wrong VAT period,
 * and the client finds out when the assessment arrives. So a date outside the
 * verified range is refused. A refused conversion is a support ticket; an
 * extrapolated one is a misfiled return.
 */

const table = require('../../db/data/bs-calendar.json');

class NepaliCalendarError extends Error {
  constructor(message, { raw } = {}) {
    super(message);
    this.name = 'NepaliCalendarError';
    this.raw = raw;
  }
}

const MS_PER_DAY = 86_400_000;

const FIRST_YEAR = table.firstYear;
const LAST_YEAR = table.lastYear;
const EPOCH_AD = table.epochAd; // Gregorian date of BS FIRST_YEAR-01-01
const EPOCH_MS = Date.parse(`${EPOCH_AD}T00:00:00Z`);

/** Nepali month names, in order, for labelling periods. */
const MONTH_NAMES = Object.freeze([
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
]);

/**
 * Days from the epoch to the first day of each BS year, computed once at load.
 * Conversion is then two lookups and an addition rather than a loop over years.
 */
const YEAR_START_OFFSETS = (() => {
  const offsets = new Map();
  let running = 0;
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    offsets.set(year, running);
    running += monthLengths(year).reduce((a, b) => a + b, 0);
  }
  return offsets;
})();

const TOTAL_DAYS = (() => {
  let total = 0;
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    total += monthLengths(year).reduce((a, b) => a + b, 0);
  }
  return total;
})();

function monthLengths(year) {
  const months = table.monthLengths[String(year)];
  if (!months) {
    throw new NepaliCalendarError(
      `BS ${year} is outside the verified calendar range (BS ${FIRST_YEAR}–${LAST_YEAR}).`,
    );
  }
  return months;
}

/**
 * Bikram Sambat → Gregorian.
 *
 * @param {{year:number, month:number, day:number}} bs  month and day are 1-based
 * @returns {string} ISO date, YYYY-MM-DD
 */
function bsToAd({ year, month, day } = {}) {
  assertInteger(year, 'year');
  assertInteger(month, 'month');
  assertInteger(day, 'day');

  if (year < FIRST_YEAR || year > LAST_YEAR) {
    throw new NepaliCalendarError(
      `BS ${year} is outside the range Attest can convert (BS ${FIRST_YEAR}–${LAST_YEAR}). ` +
        `The calendar table covers only the years two independent sources agree on; ` +
        `beyond that the published calendar is provisional, and converting anyway ` +
        `risks placing a transaction in the wrong VAT period.`,
      { raw: `${year}-${month}-${day}` },
    );
  }

  if (month < 1 || month > 12) {
    throw new NepaliCalendarError(`BS month must be 1–12, got ${month}.`, {
      raw: `${year}-${month}-${day}`,
    });
  }

  const lengths = monthLengths(year);
  const monthLength = lengths[month - 1];
  if (day < 1 || day > monthLength) {
    throw new NepaliCalendarError(
      `${MONTH_NAMES[month - 1]} ${year} has ${monthLength} days, so there is no ` +
        `day ${day}.`,
      { raw: `${year}-${month}-${day}` },
    );
  }

  let offset = YEAR_START_OFFSETS.get(year);
  for (let m = 0; m < month - 1; m++) offset += lengths[m];
  offset += day - 1;

  return isoFromMs(EPOCH_MS + offset * MS_PER_DAY);
}

/**
 * Gregorian → Bikram Sambat.
 *
 * @param {string|Date} input ISO date string or Date
 * @returns {{year:number, month:number, day:number, label:string}}
 */
function adToBs(input) {
  const ms = typeof input === 'string'
    ? Date.parse(`${input.slice(0, 10)}T00:00:00Z`)
    : Date.UTC(input.getFullYear(), input.getMonth(), input.getDate());

  if (Number.isNaN(ms)) {
    throw new NepaliCalendarError(`Cannot read "${input}" as a date.`, { raw: String(input) });
  }

  const offset = Math.round((ms - EPOCH_MS) / MS_PER_DAY);
  if (offset < 0 || offset >= TOTAL_DAYS) {
    throw new NepaliCalendarError(
      `${isoFromMs(ms)} is outside the range Attest can convert ` +
        `(${EPOCH_AD} to ${isoFromMs(EPOCH_MS + (TOTAL_DAYS - 1) * MS_PER_DAY)}).`,
      { raw: String(input) },
    );
  }

  let year = FIRST_YEAR;
  while (year < LAST_YEAR && YEAR_START_OFFSETS.get(year + 1) <= offset) year++;

  let remaining = offset - YEAR_START_OFFSETS.get(year);
  const lengths = monthLengths(year);
  let month = 1;
  while (remaining >= lengths[month - 1]) {
    remaining -= lengths[month - 1];
    month++;
  }

  const day = remaining + 1;
  return { year, month, day, label: `${MONTH_NAMES[month - 1]} ${day}, ${year}` };
}

/**
 * The Gregorian span of a Nepali fiscal year, which runs Shrawan 1 to the last
 * day of Ashadh — months 4 through 3 of the following year.
 *
 * Firms speak in fiscal years ("FY 2081-82") and the engine computes in
 * Gregorian, so this is the translation that lets a period be created from a
 * label the accountant actually uses.
 *
 * @param {number} startBsYear e.g. 2081 for FY 2081-82
 */
function fiscalYearRange(startBsYear) {
  const start = bsToAd({ year: startBsYear, month: 4, day: 1 });
  const endYear = startBsYear + 1;
  const endMonthLength = monthLengths(endYear)[2]; // Ashadh
  const end = bsToAd({ year: endYear, month: 3, day: endMonthLength });
  return { label: `FY ${startBsYear}-${String(endYear).slice(-2)}`, startDate: start, endDate: end };
}

/** The Gregorian span of one BS month, for monthly VAT periods. */
function monthRange(year, month) {
  const lengths = monthLengths(year);
  if (month < 1 || month > 12) {
    throw new NepaliCalendarError(`BS month must be 1–12, got ${month}.`);
  }
  return {
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    startDate: bsToAd({ year, month, day: 1 }),
    endDate: bsToAd({ year, month, day: lengths[month - 1] }),
  };
}

function isoFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function assertInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new NepaliCalendarError(`BS ${name} must be a whole number, got ${JSON.stringify(value)}.`);
  }
}

function isImplemented() {
  return true;
}

/** Which BS years this build can convert. Surfaced so the UI can say so. */
const SUPPORTED_RANGE = Object.freeze({ firstYear: FIRST_YEAR, lastYear: LAST_YEAR });

module.exports = {
  NepaliCalendarError,
  MONTH_NAMES,
  SUPPORTED_RANGE,
  bsToAd,
  adToBs,
  fiscalYearRange,
  monthRange,
  isImplemented,
};
