/**
 * Money is represented everywhere in this system as an integer number of paisa
 * (1 NPR = 100 paisa). Floating point is never used for a figure that can reach
 * a tax return: 0.1 + 0.2 !== 0.3, and a rounding drift of one paisa across a
 * thousand invoices is a reconciliation difference nobody can explain.
 *
 * This module is framework-free and dependency-free on purpose. It is the
 * lowest layer of the domain and everything financial is built on top of it.
 */

/** Largest value we accept, ~90 trillion NPR. Guards against overflow of Number. */
const MAX_PAISA = Number.MAX_SAFE_INTEGER;

class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Parse a human/spreadsheet-written amount into integer paisa.
 *
 * Accepts: 1234, "1234", "1,234.50", "Rs. 1,234.50", "(1,234.50)" (negative),
 * "-1234.5", "1234.50 Dr". Rejects anything else loudly rather than guessing,
 * because a silently mis-parsed amount is worse than a failed import.
 *
 * @param {string|number} input
 * @returns {number} integer paisa
 */
function parseAmount(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`Not a finite amount: ${input}`);
    return toPaisa(input);
  }
  if (typeof input !== 'string') {
    throw new MoneyError(`Unsupported amount type: ${typeof input}`);
  }

  let s = input.trim();
  if (s === '') throw new MoneyError('Empty amount');

  let negative = false;

  // Accounting parentheses: (1,234.50) means -1234.50
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Trailing Dr/Cr markers used by many Nepali bank exports.
  const drCr = s.match(/\b(dr|cr)\.?$/i);
  if (drCr) {
    if (drCr[1].toLowerCase() === 'dr') negative = true;
    s = s.slice(0, drCr.index).trim();
  }

  // Currency symbols and thousands separators.
  s = s.replace(/^(rs\.?|npr|₨|रु\.?)\s*/i, '').replace(/,/g, '').trim();

  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new MoneyError(`Cannot parse amount: ${JSON.stringify(input)}`);
  }

  const [whole, fraction = ''] = s.split('.');
  // More than 2 decimals is a data-quality signal, not something to round away
  // silently — but sub-paisa precision genuinely occurs in interest lines, so
  // we round half-up to paisa and let the caller flag it if it matters.
  const paisaFraction = roundHalfUp(Number(`0.${fraction || '0'}`) * 100);
  const paisa = Number(whole) * 100 + paisaFraction;

  if (!Number.isSafeInteger(paisa)) throw new MoneyError(`Amount out of range: ${input}`);
  return negative ? -paisa : paisa;
}

/** Convert a rupee float (only ever from trusted, already-validated input) to paisa. */
function toPaisa(rupees) {
  const paisa = roundHalfUp(rupees * 100);
  if (!Number.isSafeInteger(paisa)) throw new MoneyError(`Amount out of range: ${rupees}`);
  return paisa;
}

/** Convert paisa to a float in rupees. Presentation only — never compute with this. */
function toRupees(paisa) {
  assertPaisa(paisa);
  return paisa / 100;
}

/**
 * Round half-up, away from zero on ties, which is the convention Nepali tax
 * practice follows (and what a CA expects when they check by hand).
 * Note: Math.round(-0.5) === -0, which is the wrong tie direction for us.
 */
function roundHalfUp(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Multiply an integer paisa amount by a rate expressed in basis points
 * (1 bp = 0.01%). Rates live as integers so that 13% is exactly 1300 and never
 * 0.13000000000000001.
 *
 * @param {number} paisa
 * @param {number} basisPoints e.g. 1300 for 13%
 * @returns {number} integer paisa, rounded half-up
 */
function applyRate(paisa, basisPoints) {
  assertPaisa(paisa);
  if (!Number.isInteger(basisPoints)) {
    throw new MoneyError(`Rate must be integer basis points, got ${basisPoints}`);
  }
  return roundHalfUp((paisa * basisPoints) / 10000);
}

/**
 * Extract the tax component from a tax-inclusive amount.
 * For 13% VAT: tax = gross * 13/113.
 */
function extractInclusive(grossPaisa, basisPoints) {
  assertPaisa(grossPaisa);
  if (!Number.isInteger(basisPoints)) {
    throw new MoneyError(`Rate must be integer basis points, got ${basisPoints}`);
  }
  return roundHalfUp((grossPaisa * basisPoints) / (10000 + basisPoints));
}

/** Sum a list of paisa amounts with overflow checking. */
function sum(amounts) {
  let total = 0;
  for (const a of amounts) {
    assertPaisa(a);
    total += a;
    if (!Number.isSafeInteger(total)) throw new MoneyError('Sum out of range');
  }
  return total;
}

function abs(paisa) {
  assertPaisa(paisa);
  return Math.abs(paisa);
}

/** Format for display: 1234550 -> "1,234,550.00" grouped in the Nepali style is
 *  lakh/crore, but firms filing VAT read plain international grouping on
 *  screen, so we keep it and expose the choice to the frontend. */
function format(paisa, { withSymbol = false } = {}) {
  assertPaisa(paisa);
  const negative = paisa < 0;
  const v = Math.abs(paisa);
  const whole = Math.floor(v / 100).toString();
  const frac = (v % 100).toString().padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${grouped}.${frac}`;
  return `${negative ? '-' : ''}${withSymbol ? 'Rs. ' : ''}${body}`;
}

function assertPaisa(value) {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Expected integer paisa, got ${JSON.stringify(value)}`);
  }
}

module.exports = {
  MAX_PAISA,
  MoneyError,
  parseAmount,
  toPaisa,
  toRupees,
  roundHalfUp,
  applyRate,
  extractInclusive,
  sum,
  abs,
  format,
  assertPaisa,
};
