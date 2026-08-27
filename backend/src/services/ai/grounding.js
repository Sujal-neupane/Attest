/**
 * Grounding: proving every extracted value was actually READ, not invented.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * "The AI never does the math" is the product's central rule, and the tax engine
 * enforces it for arithmetic. But extraction is a second, quieter way for a
 * model to put a wrong number into a return: it does not need to calculate
 * anything to report a total of Rs. 11,300 from an invoice that says Rs. 13,100.
 * A transposition like that is exactly the kind of error a language model makes,
 * it is completely plausible, and nothing downstream would question it — the
 * arithmetic on top of it would be perfect.
 *
 * So every value the model claims to have read is checked back against the
 * source text. If the characters are not there, the value is not accepted. That
 * turns extraction from "trust the model" into "the model points at the
 * document, and we look".
 *
 * The model's job becomes locating a value. Reading it is ours.
 *
 * This module is pure — no network, no model, no database — so the rule can be
 * tested exhaustively without an API key, and so it cannot quietly acquire a
 * dependency on the thing it is meant to police.
 */

const { parseAmount, MoneyError } = require('../../domain/money');

/**
 * Characters that differ between how a document is written and how a model
 * quotes it back, without changing the value: non-breaking spaces, the various
 * unicode dashes, and the curly quotes editors insert.
 */
function normaliseForComparison(text) {
  return String(text)
    // Explicit escapes, not literal characters: a non-breaking space is
    // invisible in an editor, so the next person to read this line would have
    // no way to see what the class actually contains.
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Is `quoted` genuinely present in `source`?
 *
 * Whitespace-insensitive because a PDF text layer breaks lines wherever the
 * column ended, so a party name really can arrive as "SHARMA\n TRADERS". Not
 * case-sensitive, for the same reason. Everything else must match exactly.
 */
function appearsIn(source, quoted) {
  if (!quoted) return false;
  return normaliseForComparison(source).includes(normaliseForComparison(quoted));
}

/**
 * Verify one extracted field.
 *
 * A field carries the value the model read AND the exact snippet it claims to
 * have read it from. Both are checked: the snippet must appear in the document,
 * and the value must appear in the snippet. Requiring both is what stops a
 * model quoting a real line from the document and then reporting a number that
 * is not in it.
 *
 * @param {string} documentText
 * @param {{value: any, quote: string}} field
 * @param {object} [options]
 * @param {boolean} [options.isAmount] parse and compare numerically, so
 *        "Rs. 11,300.00" grounds against "11300.00" and vice versa
 */
function verifyField(documentText, field, { isAmount = false } = {}) {
  if (!field || field.value === null || field.value === undefined) {
    return { grounded: true, reason: 'absent', value: null };
  }

  const value = String(field.value);
  const quote = field.quote ? String(field.quote) : null;

  if (!quote) {
    return {
      grounded: false,
      reason: 'no_quote',
      value,
      detail: 'The model reported a value without saying where in the document it came from.',
    };
  }

  if (!appearsIn(documentText, quote)) {
    return {
      grounded: false,
      reason: 'quote_not_in_document',
      value,
      quote,
      detail:
        `The model quoted "${truncate(quote)}" as its source, but that text does ` +
        `not appear in the document.`,
    };
  }

  // For money, compare numerically rather than by characters: a document may
  // write "Rs. 11,300.00" where the model reports "11300.00", and those are the
  // same figure. Only a genuine difference in VALUE should fail.
  if (isAmount) {
    let claimed;
    let inQuote;
    try {
      claimed = parseAmount(value);
    } catch (err) {
      return {
        grounded: false,
        reason: 'unparseable_amount',
        value,
        detail: err instanceof MoneyError ? err.message : String(err),
      };
    }

    inQuote = amountsIn(quote);
    if (!inQuote.includes(claimed)) {
      return {
        grounded: false,
        reason: 'amount_not_in_quote',
        value,
        quote,
        detail:
          `The model reported ${value}, but the text it quoted — "${truncate(quote)}" — ` +
          `does not contain that figure. This is what a transposed or invented ` +
          `amount looks like.`,
      };
    }
    return { grounded: true, reason: 'amount_matched', value, quote, paisa: claimed };
  }

  if (!appearsIn(quote, value)) {
    return {
      grounded: false,
      reason: 'value_not_in_quote',
      value,
      quote,
      detail:
        `The model reported "${truncate(value)}", but the text it quoted — ` +
        `"${truncate(quote)}" — does not contain it.`,
    };
  }

  return { grounded: true, reason: 'matched', value, quote };
}

/** Every amount-shaped token in a snippet, as paisa. */
function amountsIn(text) {
  const matches = String(text).match(/-?(?:rs\.?\s*)?[\d,]+(?:\.\d{1,2})?/gi) || [];
  const found = [];
  for (const raw of matches) {
    try {
      found.push(parseAmount(raw));
      // A document writing "11,300" for a figure the model reports as
      // "11300.00" is the same money; parseAmount handles that. But a bare
      // integer may also be a quantity or an invoice number, which is why the
      // quote has to be narrow enough to be meaningful.
    } catch {
      // Not actually an amount — an invoice number, a date fragment. Skipped.
    }
  }
  return found;
}

/**
 * Verify a whole extraction.
 *
 * Returns the fields that grounded, the ones that did not, and a verdict. The
 * caller does NOT get a half-trusted object: an extraction with any ungrounded
 * field is `rejected`, and rejected extractions become a flag for a human
 * rather than transactions.
 *
 * @param {string} documentText
 * @param {object} extraction    the model's structured output
 * @param {object} [spec]        which fields are amounts
 */
function verifyExtraction(documentText, extraction, { amountFields = [] } = {}) {
  const results = {};
  const ungrounded = [];

  for (const [name, field] of Object.entries(extraction ?? {})) {
    // Non-field metadata (confidence, notes) is not a claim about the document.
    if (!field || typeof field !== 'object' || !('value' in field)) continue;

    const result = verifyField(documentText, field, {
      isAmount: amountFields.includes(name),
    });
    results[name] = result;
    if (!result.grounded) ungrounded.push({ field: name, ...result });
  }

  return {
    verdict: ungrounded.length === 0 ? 'grounded' : 'rejected',
    fields: results,
    ungrounded,
    checked: Object.keys(results).length,
  };
}

function truncate(text, max = 60) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

module.exports = {
  verifyExtraction,
  verifyField,
  appearsIn,
  normaliseForComparison,
  _internals: { amountsIn, truncate },
};
