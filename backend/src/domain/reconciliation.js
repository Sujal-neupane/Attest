/**
 * Deterministic reconciliation of bank transactions against ledger entries.
 *
 * Pure, framework-free, and fully testable. No AI. A match here is an assertion
 * that two records are the same real-world event, and the accountant needs to
 * be able to re-derive every one of them by hand.
 *
 * Strategy: three passes, strongest evidence first, each pass consuming only
 * records still unmatched. Passing in strict order means a weak fuzzy match can
 * never steal a counterpart that an exact match would have claimed.
 *
 *   Pass 1  exact  — same signed amount, same date, same invoice/cheque ref
 *   Pass 2  strong — same signed amount within a small date window
 *   Pass 3  fuzzy  — near amount within window + similar party name
 *
 * Anything left over is reported as unmatched, never quietly force-fitted.
 */

const { abs } = require('./money');

const DEFAULT_OPTIONS = Object.freeze({
  /** How many days apart a bank line and its ledger entry may sit. Cheques
   *  clear late; 3 days covers ordinary settlement without inviting noise. */
  dateWindowDays: 3,
  /** Fuzzy pass only: absolute paisa tolerance (bank charges, rounding). */
  amountTolerancePaisa: 100,
  /** Fuzzy pass only: minimum party-name similarity, 0..1. */
  minPartySimilarity: 0.62,
  /** Below this confidence a match is proposed but marked for human review. */
  reviewThreshold: 0.9,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} Txn
 * @property {string} id
 * @property {string} txnDate       ISO date, YYYY-MM-DD
 * @property {number} amountPaisa   signed: negative = money out
 * @property {string} [party]
 * @property {string} [invoiceNumber]
 * @property {string} [reference]   cheque number, transfer ref
 * @property {string} [description]
 */

/**
 * @param {Txn[]} bankTxns
 * @param {Txn[]} ledgerTxns
 * @param {object} [options]
 * @returns {{matches:Array, unmatchedBank:Txn[], unmatchedLedger:Txn[], stats:object}}
 */
function reconcile(bankTxns, ledgerTxns, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const bankPool = new Map(bankTxns.map((t) => [t.id, t]));
  const ledgerPool = new Map(ledgerTxns.map((t) => [t.id, t]));
  const matches = [];

  const passes = [
    { name: 'exact', fn: exactCandidate, confidence: 1 },
    { name: 'strong', fn: strongCandidate, confidence: 0.95 },
    { name: 'fuzzy', fn: fuzzyCandidate, confidence: null }, // scored per pair
  ];

  for (const pass of passes) {
    for (const bank of [...bankPool.values()]) {
      const scored = [];
      for (const ledger of ledgerPool.values()) {
        const result = pass.fn(bank, ledger, opts);
        if (result) scored.push({ ledger, ...result });
      }
      if (scored.length === 0) continue;

      // Ambiguity is a finding, not a coin flip: if two ledger entries tie for
      // best, we refuse to pick and leave both for the human.
      scored.sort((a, b) => b.confidence - a.confidence);
      if (scored.length > 1 && scored[0].confidence === scored[1].confidence) {
        continue;
      }

      const best = scored[0];
      const confidence = pass.confidence ?? best.confidence;
      matches.push({
        bankTxnId: bank.id,
        ledgerTxnId: best.ledger.id,
        method: pass.name,
        confidence,
        reasons: best.reasons,
        status: confidence >= opts.reviewThreshold ? 'matched' : 'matched_low_confidence',
        amountDifferencePaisa: bank.amountPaisa - best.ledger.amountPaisa,
        dayDifference: dayDiff(bank.txnDate, best.ledger.txnDate),
      });
      bankPool.delete(bank.id);
      ledgerPool.delete(best.ledger.id);
    }
  }

  const unmatchedBank = [...bankPool.values()];
  const unmatchedLedger = [...ledgerPool.values()];

  return {
    matches,
    unmatchedBank,
    unmatchedLedger,
    stats: {
      bankCount: bankTxns.length,
      ledgerCount: ledgerTxns.length,
      matchedCount: matches.length,
      lowConfidenceCount: matches.filter((m) => m.status === 'matched_low_confidence').length,
      unmatchedBankCount: unmatchedBank.length,
      unmatchedLedgerCount: unmatchedLedger.length,
      matchRate: bankTxns.length === 0 ? 1 : matches.length / bankTxns.length,
    },
  };
}

function exactCandidate(bank, ledger) {
  if (bank.amountPaisa !== ledger.amountPaisa) return null;
  if (bank.txnDate !== ledger.txnDate) return null;
  const ref = sharedReference(bank, ledger);
  if (!ref) return null;
  return { confidence: 1, reasons: [`amount, date and reference ${ref} all match exactly`] };
}

function strongCandidate(bank, ledger, opts) {
  if (bank.amountPaisa !== ledger.amountPaisa) return null;
  const days = dayDiff(bank.txnDate, ledger.txnDate);
  if (days === null || Math.abs(days) > opts.dateWindowDays) return null;
  const reasons = [`exact amount match`];
  if (days === 0) reasons.push('same date');
  else reasons.push(`${Math.abs(days)} day settlement gap`);
  return { confidence: 0.95, reasons };
}

function fuzzyCandidate(bank, ledger, opts) {
  const delta = Math.abs(bank.amountPaisa - ledger.amountPaisa);
  if (delta > opts.amountTolerancePaisa) return null;
  const days = dayDiff(bank.txnDate, ledger.txnDate);
  if (days === null || Math.abs(days) > opts.dateWindowDays) return null;
  // Direction must agree; a receipt never reconciles to a payment.
  if (Math.sign(bank.amountPaisa) !== Math.sign(ledger.amountPaisa)) return null;

  const similarity = partySimilarity(bank, ledger);
  if (similarity < opts.minPartySimilarity) return null;

  // Confidence degrades with amount drift, date drift and name distance.
  const amountScore = 1 - delta / (opts.amountTolerancePaisa + 1);
  const dateScore = 1 - Math.abs(days) / (opts.dateWindowDays + 1);
  const confidence = round2(0.5 * similarity + 0.3 * amountScore + 0.2 * dateScore);

  const reasons = [`party names ${Math.round(similarity * 100)}% similar`];
  if (delta > 0) reasons.push(`amount differs by ${abs(delta)} paisa`);
  if (days !== 0) reasons.push(`${Math.abs(days)} day gap`);

  return { confidence, reasons };
}

function sharedReference(a, b) {
  const aRefs = [a.invoiceNumber, a.reference].filter(Boolean).map(normaliseRef);
  const bRefs = [b.invoiceNumber, b.reference].filter(Boolean).map(normaliseRef);
  return aRefs.find((r) => bRefs.includes(r)) || null;
}

function normaliseRef(ref) {
  return String(ref).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function partySimilarity(a, b) {
  const left = normaliseName(a.party || a.description || '');
  const right = normaliseName(b.party || b.description || '');
  if (!left || !right) return 0;
  return diceCoefficient(left, right);
}

function normaliseName(value) {
  return String(value)
    .toLowerCase()
    // Legal-form noise that carries no identifying information.
    .replace(/\b(pvt|private|ltd|limited|company|co|and|&|suppliers?|traders?|enterprises?)\b/g, ' ')
    // Unicode property escapes rather than an explicit Devanagari range: a
    // range spanning that block includes combining matras, and a character
    // class over those can split a grapheme. \p{L} covers Latin and Devanagari
    // alike, which is what a party name in a Nepali ledger actually contains.
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sørensen–Dice over character bigrams. Chosen over Levenshtein because it is
 * robust to word reordering ("Sharma Traders" vs "Traders, Sharma") which is
 * exactly how bank narrations differ from ledger party names.
 */
function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const count = bigrams.get(g) || 0;
    if (count > 0) {
      bigrams.set(g, count - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

function dayDiff(aDate, bDate) {
  const a = Date.parse(`${aDate}T00:00:00Z`);
  const b = Date.parse(`${bDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / DAY_MS);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  DEFAULT_OPTIONS,
  reconcile,
  // exported for unit testing the pieces independently
  _internals: { diceCoefficient, normaliseName, dayDiff, partySimilarity },
};
