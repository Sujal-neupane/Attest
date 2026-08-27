/**
 * Display formatting for money.
 *
 * The backend sends integer paisa and nothing here ever does arithmetic on it —
 * these functions format and nothing more. Any figure the user sees is one the
 * deterministic engine produced; the frontend's job is to render it, not to
 * derive it. A total computed in the browser would be a second, unverified
 * source of truth for the same number.
 */

/** 1234550 -> "12,345.50" */
export function formatPaisa(paisa, { withSymbol = false, signed = false } = {}) {
  if (paisa === null || paisa === undefined) return '—';

  const negative = paisa < 0;
  const value = Math.abs(paisa);
  const whole = Math.floor(value / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (value % 100).toString().padStart(2, '0');

  const sign = negative ? '-' : signed ? '+' : '';
  return `${sign}${withSymbol ? 'Rs. ' : ''}${whole}.${fraction}`;
}

/** A date the way an accountant reads one, with the BS label when we have it. */
export function formatDate(iso, bsLabel) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const gregorian = `${Number(d)} ${months[Number(m) - 1]} ${y}`;
  return bsLabel ? `${gregorian} · ${bsLabel}` : gregorian;
}

export function pluralise(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
