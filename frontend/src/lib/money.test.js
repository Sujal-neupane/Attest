import { describe, it, expect } from 'vitest';
import { formatPaisa, formatDate, pluralise } from './money.js';

/**
 * The frontend never computes money — but it does decide how every figure in
 * the product is READ, and a formatting bug is indistinguishable from a
 * calculation bug to the person looking at the screen.
 */

describe('formatPaisa', () => {
  it('renders paisa as rupees with two decimal places', () => {
    expect(formatPaisa(123450)).toBe('1,234.50');
    expect(formatPaisa(100)).toBe('1.00');
    expect(formatPaisa(5)).toBe('0.05');
    expect(formatPaisa(0)).toBe('0.00');
  });

  it('groups thousands so magnitudes are comparable at a glance', () => {
    expect(formatPaisa(100000000)).toBe('1,000,000.00');
    expect(formatPaisa(1130000)).toBe('11,300.00');
  });

  it('shows negatives as negative, never as parentheses in the UI', () => {
    // The parser ACCEPTS accounting parentheses on input; the interface emits a
    // minus sign, because "(1,234.50)" is a convention half the people reading
    // this screen will not have been taught.
    expect(formatPaisa(-123450)).toBe('-1,234.50');
  });

  it('distinguishes "no value" from zero', () => {
    // A transaction whose tax has not been computed shows an em dash. Rendering
    // null as "0.00" would claim a figure was computed and came to nothing —
    // which is a different, and false, statement.
    expect(formatPaisa(null)).toBe('—');
    expect(formatPaisa(undefined)).toBe('—');
    expect(formatPaisa(0)).toBe('0.00');
  });

  it('adds the currency symbol only when asked, after the sign', () => {
    expect(formatPaisa(123450, { withSymbol: true })).toBe('Rs. 1,234.50');
    // "-Rs. 1,234.50", not "Rs. -1,234.50": the minus qualifies the whole
    // figure, and a sign buried after the symbol is easy to miss in a column.
    expect(formatPaisa(-123450, { withSymbol: true })).toBe('-Rs. 1,234.50');
  });

  it('never loses a paisa to floating point', () => {
    // The whole reason the backend works in integers. If this ever renders
    // "0.30000000000000004" the integer contract has been broken upstream.
    expect(formatPaisa(30)).toBe('0.30');
    expect(formatPaisa(10 + 20)).toBe('0.30');
    expect(formatPaisa(7000)).toBe('70.00');
  });
});

describe('formatDate', () => {
  it('renders an ISO date the way an accountant reads one', () => {
    expect(formatDate('2024-07-16')).toBe('16 Jul 2024');
    expect(formatDate('2024-01-01')).toBe('1 Jan 2024');
  });

  it('shows the Bikram Sambat date alongside when the client used one', () => {
    expect(formatDate('2024-07-16', 'Shrawan 1, 2081')).toBe('16 Jul 2024 · Shrawan 1, 2081');
  });

  it('handles a missing date without rendering "Invalid Date"', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });
});

describe('pluralise', () => {
  it('agrees with its count', () => {
    expect(pluralise(1, 'open finding')).toBe('1 open finding');
    expect(pluralise(2, 'open finding')).toBe('2 open findings');
    expect(pluralise(0, 'open finding')).toBe('0 open findings');
  });
});
