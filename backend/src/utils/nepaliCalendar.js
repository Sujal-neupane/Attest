/**
 * Bikram Sambat ↔ Gregorian conversion.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  STATUS: NOT IMPLEMENTED. Calls to convert a BS date throw.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This file is deliberately a refusal rather than an implementation, and the
 * reasoning is worth writing down because the temptation to just ship something
 * here is strong.
 *
 * Bikram Sambat month lengths are not derivable from a formula. Unlike the
 * Gregorian leap rule, each BS month is between 29 and 32 days and the pattern
 * varies year to year; conversion requires a transcribed lookup table published
 * by the Nepali calendar authority. A table that is *nearly* right produces
 * dates that are off by one or two days — which is invisible in the middle of a
 * month and catastrophic at a month boundary, because it silently moves a
 * transaction into the wrong VAT period. The return still balances. Nothing
 * looks wrong on screen. The client finds out when the assessment arrives.
 *
 * So the options were: transcribe the table from memory and hope, or refuse and
 * make the gap visible. A wrong figure that looks right is the exact failure
 * mode this entire product exists to prevent, and shipping one in the date
 * layer to save an afternoon would make the rest of it dishonest.
 *
 * TO IMPLEMENT:
 *   1. Obtain the official BS calendar table (days per month, per year) for the
 *      range the product supports — realistically BS 2070–2100.
 *   2. Put it in db/data/bs-calendar.json as { "2081": [31,31,32,...], ... }.
 *   3. Implement convert() by day-counting from a fixed anchor.
 *   4. Cross-validate: the month lengths for each year must sum to exactly the
 *      number of Gregorian days between that year's Baisakh 1 and the next
 *      year's. Two independently-sourced facts agreeing is what makes the table
 *      trustworthy; a table checked only against itself proves nothing.
 *   5. Anchor tests against known Nepali New Year dates, at minimum:
 *        BS 2080-01-01 = 2023-04-14
 *        BS 2081-01-01 = 2024-04-13
 *        BS 2082-01-01 = 2025-04-14
 *      and against both boundaries of a Shrawan–Ashad fiscal year.
 *
 * UNTIL THEN: documents dated in Bikram Sambat are rejected at import with a
 * message telling the accountant exactly why, rather than being converted
 * approximately. fiscal_periods stores both the BS label and explicit Gregorian
 * start/end dates, so periods themselves are unaffected — the firm enters the
 * range once, and every transaction is compared against it in Gregorian.
 */

class NepaliCalendarError extends Error {
  constructor(message, { raw } = {}) {
    super(message);
    this.name = 'NepaliCalendarError';
    this.raw = raw;
  }
}

/** Nepali New Year (Baisakh 1) in Gregorian, for the years we can anchor. */
const NEW_YEAR_ANCHORS = Object.freeze({
  2080: '2023-04-14',
  2081: '2024-04-13',
  2082: '2025-04-14',
});

const IS_IMPLEMENTED = false;

/**
 * @param {{year:number, month:number, day:number}} bs
 * @returns {string} ISO Gregorian date
 * @throws {NepaliCalendarError} always, until the calendar table is in place
 */
function bsToAd({ year, month, day } = {}) {
  throw new NepaliCalendarError(
    `This document is dated in Bikram Sambat (${year}-${month}-${day}), and ` +
      `Attest does not yet convert BS dates. Converting without the official ` +
      `calendar table risks placing a transaction in the wrong VAT period, ` +
      `which is a mistake nobody would notice until an assessment. Re-export ` +
      `the file with Gregorian (AD) dates, or enter these transactions ` +
      `manually against the period's date range.`,
    { raw: `${year}-${month}-${day}` },
  );
}

function adToBs() {
  throw new NepaliCalendarError(
    'Gregorian to Bikram Sambat conversion is not implemented yet. BS labels ' +
      'are entered by the firm when a fiscal period is created.',
  );
}

/** Callers can check this to fail early with a better message. */
function isImplemented() {
  return IS_IMPLEMENTED;
}

module.exports = {
  NepaliCalendarError,
  NEW_YEAR_ANCHORS,
  bsToAd,
  adToBs,
  isImplemented,
};
