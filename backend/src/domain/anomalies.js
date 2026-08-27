/**
 * Rule-based anomaly detection.
 *
 * Every rule here is objective and deterministic: given the same transactions
 * it raises the same flags, and each flag states in plain language what was
 * observed. The AI layer may later *draft an explanation* for a flag, but it
 * never creates one, because a flag the accountant cannot reproduce by hand is
 * a flag they will learn to ignore.
 *
 * Severity is deliberately conservative. A false "high" trains the reviewer to
 * dismiss everything, which is the failure mode that kills tools like this.
 */

const { abs } = require('./money');

const SEVERITY = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });

/**
 * Run every rule over a period's transactions and reconciliation result.
 *
 * @param {object} input
 * @param {Array} input.transactions  normalized transactions for the period
 * @param {object} [input.reconciliation] output of domain/reconciliation
 * @param {object} [options]
 * @returns {Array} flags, sorted most severe first
 */
function detectAnomalies({ transactions = [], reconciliation = null }, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const flags = [
    ...duplicateInvoices(transactions),
    ...missingSupportingBill(transactions, reconciliation),
    ...roundNumberEntries(transactions, opts),
    ...invoiceNumberGaps(transactions, opts),
  ];

  const order = { high: 0, medium: 1, low: 2 };
  return flags.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.type.localeCompare(b.type),
  );
}

const DEFAULT_OPTIONS = Object.freeze({
  /** An amount is "suspiciously round" at or above this size only — a Rs. 500
   *  taxi fare being round means nothing. */
  roundNumberMinPaisa: 10_000_00,
  /** Round to this many rupees to count as round. 1000 -> Rs. 1,000 steps. */
  roundNumberStepRupees: 1000,
  /** Report a numbering gap only up to this run length; a jump of 400 is a
   *  different book, not a missing bill, and saying so is more useful. */
  maxReportableGap: 25,
});

/**
 * Rule 1 — the same invoice number booked more than once.
 * High severity: this is either double-claimed input VAT or double-counted
 * revenue, and both are things a tax officer looks for first.
 */
function duplicateInvoices(transactions) {
  const byKey = new Map();
  for (const txn of transactions) {
    if (!txn.invoiceNumber) continue;
    const key = `${normalise(txn.invoiceNumber)}::${normalise(txn.party || '')}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(txn);
  }

  const flags = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;

    const sameAmount = group.every((t) => t.amountPaisa === group[0].amountPaisa);
    flags.push({
      type: 'duplicate_invoice',
      severity: sameAmount ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      transactionId: group[0].id,
      relatedTransactionIds: group.map((t) => t.id),
      message: sameAmount
        ? `Invoice ${group[0].invoiceNumber} from ${group[0].party || 'unknown party'} appears ${group.length} times for the same amount.`
        : `Invoice ${group[0].invoiceNumber} from ${group[0].party || 'unknown party'} appears ${group.length} times with differing amounts.`,
      suggestion: sameAmount
        ? 'Confirm whether this is a genuine duplicate entry and remove the copy, or confirm it is a separately numbered bill.'
        : 'Check which entry carries the correct amount; one of these was likely keyed twice with a correction.',
      evidence: group.map((t) => ({
        transactionId: t.id,
        date: t.txnDate,
        amountPaisa: t.amountPaisa,
        documentId: t.documentId,
        sourceRef: t.sourceRef,
      })),
    });
  }
  return flags;
}

/**
 * Rule 2 — money left the bank but no ledger entry / supporting bill exists.
 * Without the bill there is no input VAT credit and no deductible expense, so
 * this is the rule that most directly saves the client money.
 */
function missingSupportingBill(transactions, reconciliation) {
  if (!reconciliation) return [];
  const byId = new Map(transactions.map((t) => [t.id, t]));

  return reconciliation.unmatchedBank
    .map((stub) => byId.get(stub.id) || stub)
    .filter((txn) => txn.amountPaisa < 0) // payments only; unexplained receipts are a different rule
    .map((txn) => ({
      type: 'missing_bill',
      severity: abs(txn.amountPaisa) >= 25_000_00 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      transactionId: txn.id,
      relatedTransactionIds: [],
      message: `Bank payment of ${formatPlain(txn.amountPaisa)} on ${txn.txnDate}${
        txn.party ? ` to ${txn.party}` : ''
      } has no matching ledger entry or supporting bill.`,
      suggestion:
        'Obtain the purchase bill from the client. Without it this expense is not deductible and no input VAT can be claimed.',
      evidence: [
        {
          transactionId: txn.id,
          date: txn.txnDate,
          amountPaisa: txn.amountPaisa,
          documentId: txn.documentId,
          sourceRef: txn.sourceRef,
        },
      ],
    }));
}

/**
 * Rule 3 — large, perfectly round amounts.
 * Low severity by design: round numbers are common and usually innocent
 * (rent, retainers). This rule exists to surface estimates that were never
 * replaced with the real figure, so the message says exactly that.
 */
function roundNumberEntries(transactions, opts) {
  const stepPaisa = opts.roundNumberStepRupees * 100;

  return transactions
    .filter((t) => abs(t.amountPaisa) >= opts.roundNumberMinPaisa)
    .filter((t) => abs(t.amountPaisa) % stepPaisa === 0)
    .map((txn) => ({
      type: 'round_number',
      severity: SEVERITY.LOW,
      transactionId: txn.id,
      relatedTransactionIds: [],
      message: `${formatPlain(txn.amountPaisa)} on ${txn.txnDate}${
        txn.party ? ` (${txn.party})` : ''
      } is an exact multiple of Rs. ${opts.roundNumberStepRupees.toLocaleString('en-US')}.`,
      suggestion:
        'Verify against the source bill. Round figures of this size are sometimes provisional entries that were never updated to the actual amount.',
      evidence: [
        {
          transactionId: txn.id,
          date: txn.txnDate,
          amountPaisa: txn.amountPaisa,
          documentId: txn.documentId,
          sourceRef: txn.sourceRef,
        },
      ],
    }));
}

/**
 * Rule 4 — breaks in a sales invoice sequence.
 * A missing number in the firm's own outward invoice series means either an
 * unrecorded sale or a cancelled bill that was never marked cancelled. Both
 * have to be explained to the IRD, so the flag asks for the explanation now.
 */
function invoiceNumberGaps(transactions, opts) {
  const series = new Map();

  for (const txn of transactions) {
    if (txn.kind !== 'sale' || !txn.invoiceNumber) continue;
    const parsed = splitInvoiceNumber(txn.invoiceNumber);
    if (!parsed) continue;
    if (!series.has(parsed.prefix)) series.set(parsed.prefix, []);
    series.get(parsed.prefix).push({ ...parsed, txn });
  }

  const flags = [];
  for (const [prefix, entries] of series) {
    if (entries.length < 3) continue; // too short to call a sequence
    entries.sort((a, b) => a.number - b.number);

    for (let i = 1; i < entries.length; i++) {
      const gap = entries[i].number - entries[i - 1].number;
      if (gap <= 1) continue;

      const missing = gap - 1;
      // Re-render missing numbers in the same zero-padded width the client's
      // own book uses, so the accountant can read the flag and go straight to
      // the physical invoice without mentally reformatting anything.
      const width = Math.max(entries[i - 1].width, entries[i].width);
      const label = (n) => `${prefix}${String(n).padStart(width, '0')}`;
      const from = label(entries[i - 1].number + 1);
      const to = label(entries[i].number - 1);
      const listed =
        missing <= opts.maxReportableGap
          ? `${from}${missing > 1 ? ` to ${to}` : ''}`
          : `${missing} numbers between ${from} and ${to}`;

      flags.push({
        type: 'invoice_gap',
        severity: missing > opts.maxReportableGap ? SEVERITY.MEDIUM : SEVERITY.HIGH,
        transactionId: entries[i].txn.id,
        relatedTransactionIds: [entries[i - 1].txn.id],
        message: `Sales invoice sequence "${prefix || 'unprefixed'}" skips ${listed}.`,
        suggestion:
          missing > opts.maxReportableGap
            ? 'A jump this large usually means a separate invoice book or a series reset. Confirm the numbering policy with the client.'
            : 'Obtain the missing invoices, or written confirmation that they were cancelled, and record the cancellation.',
        evidence: [entries[i - 1], entries[i]].map((e) => ({
          transactionId: e.txn.id,
          date: e.txn.txnDate,
          amountPaisa: e.txn.amountPaisa,
          invoiceNumber: e.txn.invoiceNumber,
          documentId: e.txn.documentId,
          sourceRef: e.txn.sourceRef,
        })),
      });
    }
  }
  return flags;
}

/**
 * Split "INV-2081-0042" into { prefix: "INV-2081-", number: 42, width: 4 } so
 * that separate series are compared separately and not merged into one
 * nonsensical sequence.
 */
function splitInvoiceNumber(raw) {
  const match = String(raw).trim().match(/^(.*?)(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], number: Number(match[2]), width: match[2].length };
}

function normalise(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Local, dependency-free formatting for message text only. */
function formatPlain(paisa) {
  const v = Math.abs(paisa);
  const whole = Math.floor(v / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `Rs. ${whole}.${(v % 100).toString().padStart(2, '0')}`;
}

module.exports = {
  SEVERITY,
  DEFAULT_OPTIONS,
  detectAnomalies,
  duplicateInvoices,
  missingSupportingBill,
  roundNumberEntries,
  invoiceNumberGaps,
  _internals: { splitInvoiceNumber },
};
