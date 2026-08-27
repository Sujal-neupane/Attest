/**
 * Date parsing for imported documents.
 *
 * Two problems live here. The first is that there is no agreed date format in
 * Nepali bank exports: 16/07/2024, 2024-07-16, 16-Jul-24, 07/16/2024 all occur.
 * The second is that some documents are dated in Bikram Sambat (2081/04/01)
 * rather than Gregorian, and the two are not distinguishable by shape alone —
 * only by range.
 *
 * The rule throughout: an ambiguous date is never resolved by preference. It is
 * either resolved by evidence from the rest of the file, or it is refused.
 * 05/06/2024 is genuinely either 5 June or 6 May, and a parser that silently
 * picks one will misfile a transaction into the wrong VAT period without ever
 * looking wrong on screen.
 */

class DateError extends Error {
  constructor(message, { raw } = {}) {
    super(message);
    this.name = 'DateError';
    this.raw = raw;
  }
}

/**
 * Bikram Sambat runs roughly 56.7 years ahead of the Gregorian calendar, so a
 * four-digit year at or above this is BS and below it is AD. There is no
 * overlap to worry about for another five centuries.
 */
const BS_YEAR_FLOOR = 2050;

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  // Bikram Sambat month names, as written in registers kept in Nepali.
  baisakh: 1, baishakh: 1, jestha: 2, jeth: 2, ashadh: 3, asar: 3, ashad: 3,
  shrawan: 4, sawan: 4, bhadra: 5, bhadau: 5, ashwin: 6, asoj: 6,
  kartik: 7, mangsir: 8, poush: 9, push: 9, magh: 10, falgun: 11, fagun: 11,
  chaitra: 12, chait: 12,
};

const BS_MONTH_NAMES = new Set([
  'baisakh', 'baishakh', 'jestha', 'jeth', 'ashadh', 'asar', 'ashad', 'shrawan',
  'sawan', 'bhadra', 'bhadau', 'ashwin', 'asoj', 'kartik', 'mangsir', 'poush',
  'push', 'magh', 'falgun', 'fagun', 'chaitra', 'chait',
]);

/**
 * Parse one date cell.
 *
 * @param {string} raw
 * @param {object} [options]
 * @param {'dmy'|'mdy'} [options.dayFirst] resolution for ambiguous d/m vs m/d,
 *        normally supplied by detectDateOrder() after looking at the whole file
 * @returns {{iso:string|null, calendar:'AD'|'BS', year:number, month:number,
 *            day:number, raw:string, ambiguous:boolean}}
 */
function parseDate(raw, options = {}) {
  if (raw == null) throw new DateError('Empty date', { raw });
  const s = String(raw).trim();
  if (s === '') throw new DateError('Empty date', { raw });

  const parts = extractParts(s);
  if (!parts) {
    throw new DateError(`Cannot read "${s}" as a date`, { raw: s });
  }

  const { year, month, day, ambiguous, calendarHint } = resolveParts(parts, s, options);

  const calendar = calendarHint || (year >= BS_YEAR_FLOOR ? 'BS' : 'AD');

  if (calendar === 'AD') {
    if (!isValidGregorian(year, month, day)) {
      throw new DateError(
        `"${s}" is not a real date — there is no ${day}/${month}/${year}`,
        { raw: s },
      );
    }
    return {
      iso: `${pad4(year)}-${pad2(month)}-${pad2(day)}`,
      calendar: 'AD',
      year, month, day, raw: s, ambiguous,
    };
  }

  // Bikram Sambat. Deliberately NOT converted here — see nepaliCalendar.js for
  // why converting without a verified calendar table is worse than refusing.
  if (month < 1 || month > 12 || day < 1 || day > 32) {
    throw new DateError(`"${s}" is not a valid Bikram Sambat date`, { raw: s });
  }
  return { iso: null, calendar: 'BS', year, month, day, raw: s, ambiguous };
}

/** Pull three numbers (and possibly a month name) out of a date-shaped string. */
function extractParts(s) {
  // 16-Jul-2024, 16 July 2024, Shrawan 1, 2081
  const named = s.match(/^(\d{1,4})[\s\-/.]+([a-z]+)[\s\-/.]+(\d{1,4})$/i);
  if (named) {
    const name = named[2].toLowerCase();
    if (MONTH_NAMES[name]) {
      return {
        a: Number(named[1]),
        month: MONTH_NAMES[name],
        c: Number(named[3]),
        namedMonth: name,
        shape: 'named',
      };
    }
  }
  const namedFirst = s.match(/^([a-z]+)[\s\-/.]+(\d{1,2})[,\s\-/.]+(\d{1,4})$/i);
  if (namedFirst) {
    const name = namedFirst[1].toLowerCase();
    if (MONTH_NAMES[name]) {
      return {
        a: Number(namedFirst[2]),
        month: MONTH_NAMES[name],
        c: Number(namedFirst[3]),
        namedMonth: name,
        shape: 'named',
      };
    }
  }

  const numeric = s.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (numeric) {
    return {
      a: Number(numeric[1]),
      b: Number(numeric[2]),
      c: Number(numeric[3]),
      shape: 'numeric',
    };
  }

  // 20240716 / 20810401
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return {
      a: Number(compact[1]),
      b: Number(compact[2]),
      c: Number(compact[3]),
      shape: 'compact',
    };
  }

  return null;
}

function resolveParts(parts, s, options) {
  const calendarHint = parts.namedMonth
    ? BS_MONTH_NAMES.has(parts.namedMonth)
      ? 'BS'
      : 'AD'
    : null;

  if (parts.shape === 'named') {
    return {
      year: expandYear(parts.c),
      month: parts.month,
      day: parts.a,
      ambiguous: false,
      calendarHint,
    };
  }

  if (parts.shape === 'compact') {
    return { year: parts.a, month: parts.b, day: parts.c, ambiguous: false, calendarHint: null };
  }

  const { a, b, c } = parts;

  // Year first: 2024-07-16 or 2081/04/01. Unambiguous.
  if (a > 31) {
    return { year: a, month: b, day: c, ambiguous: false, calendarHint: null };
  }

  // Year last. Which of a and b is the day is the ambiguous case.
  const year = expandYear(c);

  if (a > 12) return { year, month: b, day: a, ambiguous: false, calendarHint: null };
  if (b > 12) return { year, month: a, day: b, ambiguous: false, calendarHint: null };

  // Both are 12 or under: genuinely ambiguous without outside evidence.
  if (options.dayFirst === 'mdy') {
    return { year, month: a, day: b, ambiguous: true, calendarHint: null };
  }
  if (options.dayFirst === 'dmy') {
    return { year, month: b, day: a, ambiguous: true, calendarHint: null };
  }

  throw new DateError(
    `"${s}" is ambiguous: it could be ${a}/${b} or ${b}/${a}. ` +
      `Nothing else in the file settles the day/month order, so it has not been ` +
      `guessed — a date filed into the wrong month moves a transaction into the ` +
      `wrong VAT period without ever looking wrong on screen.`,
    { raw: s },
  );
}

/**
 * Decide day-first vs month-first for a whole file by looking for a single
 * unambiguous date anywhere in it.
 *
 * One row reading 16/07/2024 settles the order for every other row, including
 * the ones that are ambiguous on their own. This is the evidence that makes
 * refusing to guess practical rather than merely principled.
 *
 * @param {string[]} rawDates
 * @returns {{order:'dmy'|'mdy'|null, evidence:string|null, conflict:boolean}}
 */
function detectDateOrder(rawDates) {
  let dmyEvidence = null;
  let mdyEvidence = null;

  for (const raw of rawDates) {
    let parts;
    try {
      parts = extractParts(String(raw).trim());
    } catch {
      continue;
    }
    if (!parts || parts.shape !== 'numeric') continue;
    const { a, b } = parts;
    if (a > 31) continue; // year-first, tells us nothing about d/m order
    if (a > 12 && b <= 12) dmyEvidence ??= String(raw);
    else if (b > 12 && a <= 12) mdyEvidence ??= String(raw);
  }

  // A file containing both 16/07 and 07/16 is internally inconsistent. That is
  // a finding about the document, not a puzzle to solve.
  if (dmyEvidence && mdyEvidence) {
    return { order: null, evidence: null, conflict: true, dmyEvidence, mdyEvidence };
  }
  if (dmyEvidence) return { order: 'dmy', evidence: dmyEvidence, conflict: false };
  if (mdyEvidence) return { order: 'mdy', evidence: mdyEvidence, conflict: false };
  return { order: null, evidence: null, conflict: false };
}

/**
 * Is this cell dated in Bikram Sambat? Answers without throwing, so a whole
 * file can be probed before any of it is imported.
 *
 * Worth checking up front: if the export is in BS then *every* row will fail
 * for the same reason, and one file-level explanation is far more useful to
 * the accountant than five hundred identical row errors.
 */
function looksBikramSambat(raw) {
  let parts;
  try {
    parts = extractParts(String(raw ?? '').trim());
  } catch {
    return false;
  }
  if (!parts) return false;
  if (parts.namedMonth) return BS_MONTH_NAMES.has(parts.namedMonth);

  const year = parts.a > 31 ? parts.a : expandYear(parts.c);
  return year >= BS_YEAR_FLOOR;
}

function expandYear(y) {
  if (y >= 100) return y;
  // Two-digit years: 24 -> 2024, 99 -> 1999. Bank exports from this decade are
  // the only realistic source, so the pivot sits well past them.
  return y <= 69 ? 2000 + y : 1900 + y;
}

function isValidGregorian(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function pad4(n) {
  return String(n).padStart(4, '0');
}

/** Is an ISO date inside a fiscal period, inclusive of both ends? */
function isWithin(iso, startDate, endDate) {
  return iso >= startDate && iso <= endDate;
}

module.exports = {
  DateError,
  BS_YEAR_FLOOR,
  parseDate,
  detectDateOrder,
  looksBikramSambat,
  isWithin,
  _internals: { extractParts, expandYear, isValidGregorian },
};
