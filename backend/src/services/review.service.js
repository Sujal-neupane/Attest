/**
 * The review engine: reconcile, compute, flag.
 *
 * This is where the deterministic domain modules — which have no idea a
 * database exists — are handed the period's data and their verdict is
 * persisted. The domain does the thinking; this does the plumbing, and the
 * split is what keeps the thinking testable without any of the plumbing.
 *
 * Nothing here computes a figure itself. Every number written to a transaction
 * comes from domain/tax.js, every match from domain/reconciliation.js, every
 * flag from domain/anomalies.js or from the one comparison this file DOES make:
 * what the client's register reported against what the engine computed.
 */

const { withFirm } = require('../config/db');
const documents = require('../repositories/document.repository');
const review = require('../repositories/review.repository');
const audit = require('../repositories/audit.repository');
const clients = require('../repositories/client.repository');
const { reconcile } = require('../domain/reconciliation');
const { detectAnomalies, SEVERITY } = require('../domain/anomalies');
const { computeVat, summarisePeriod } = require('../domain/tax');
const { format } = require('../domain/money');
const { ApiError } = require('../middleware/errorHandler');

/**
 * A reported VAT figure may differ from the computed one by this much before it
 * becomes a flag.
 *
 * Not zero: registers are kept by hand and rounding each line separately
 * legitimately drifts a paisa or two from rounding the total. Flagging that
 * would bury the real errors under noise, which is the failure mode that
 * teaches reviewers to dismiss everything.
 */
const VAT_TOLERANCE_PAISA = 2;

/**
 * The most transactions this engine will process in one period.
 *
 * Reconciliation is O(bank x ledger) and everything is held in memory, so there
 * has to be a ceiling somewhere. What matters is that exceeding it REFUSES
 * rather than truncates: a query with a LIMIT that silently returns the first
 * few thousand rows would reconcile part of a period and report a VAT figure
 * that looks complete and is not. Nobody would notice until an assessment.
 */
const MAX_PERIOD_TRANSACTIONS = 20_000;

/**
 * Load a period's transactions, or refuse if there are more than we can handle.
 *
 * Never returns a partial set.
 */
async function loadAllTransactions(db, fiscalPeriodId) {
  const total = await documents.countTransactionsForPeriod(db, fiscalPeriodId);
  if (total > MAX_PERIOD_TRANSACTIONS) {
    throw new ApiError(
      413,
      `This period holds ${total.toLocaleString('en-US')} transactions, more than ` +
        `the ${MAX_PERIOD_TRANSACTIONS.toLocaleString('en-US')} Attest reconciles at ` +
        `once. Split it into shorter periods — a monthly VAT period rather than a ` +
        `full year — so every figure is computed from a complete set rather than ` +
        `from part of one.`,
      { code: 'period_too_large' },
    );
  }
  return documents.listTransactionsForPeriod(db, fiscalPeriodId, { limit: total });
}

/**
 * Run the whole engine over a period.
 *
 * Everything lands in ONE transaction. A crash halfway would otherwise leave
 * transactions carrying computed VAT while their flags were never written — a
 * period that looks reviewed and is not.
 */
async function runReconciliation(user, fiscalPeriodId, context = {}) {
  return withFirm(user.firmId, async (db) => {
    const period = await clients.findPeriodById(db, fiscalPeriodId);
    if (!period) {
      throw new ApiError(404, 'That fiscal period was not found.', { code: 'not_found' });
    }
    if (period.isLocked) {
      throw new ApiError(409, `"${period.label}" is locked and cannot be re-run.`, {
        code: 'period_locked',
      });
    }

    const all = await loadAllTransactions(db, fiscalPeriodId);
    if (all.length === 0) {
      throw new ApiError(
        409,
        'There is nothing to reconcile yet — no documents in this period have been parsed.',
        { code: 'no_transactions' },
      );
    }

    const bank = all.filter((t) => t.source === 'bank');
    const ledger = all.filter((t) => t.source === 'ledger');

    // ---- Reconcile ------------------------------------------------------
    const matching = reconcile(bank, ledger);

    // ---- Compute --------------------------------------------------------
    // Only ledger entries carry VAT: a bank line is money moving, not a supply.
    // Computing VAT on both would double the entire return.
    const computed = ledger.map((txn) => {
      // `amountPaisa` is ALWAYS the gross — it is what moved, and therefore what
      // reconciles against the bank. So the basis for VAT depends on what the
      // register actually told us:
      //
      //   register gave a taxable value  → compute 13% ON THAT NET
      //   register gave only a total     → extract 13/113 FROM THE GROSS
      //
      // Passing the gross as though it were exclusive computes 13% on a figure
      // that already contains 13%, which inflates every line — Rs. 11,300 became
      // Rs. 1,469 of VAT instead of Rs. 1,300, and every one of them looked like
      // a client error rather than ours.
      const hasReportedNet = txn.reportedNetPaisa !== null && txn.reportedNetPaisa !== undefined;
      const vat = computeVat({
        amountPaisa: hasReportedNet ? txn.reportedNetPaisa : Math.abs(txn.amountPaisa),
        vatInclusive: !hasReportedNet,
        vatApplicable: txn.vatApplicable !== false,
      });
      return {
        id: txn.id,
        netPaisa: vat.netPaisa,
        vatPaisa: vat.vatPaisa,
        // TDS needs a confirmed category, which nothing supplies yet. Left null
        // rather than defaulted to zero: null means "not computed", zero would
        // mean "computed, and none is due", and only one of those is true.
        tdsPaisa: null,
        txn,
        vat,
      };
    });

    await review.updateComputedTax(db, computed);

    // ---- Flag -----------------------------------------------------------
    const withComputed = all.map((txn) => {
      const c = computed.find((x) => x.id === txn.id);
      return c ? { ...txn, netPaisa: c.netPaisa, vatPaisa: c.vatPaisa } : txn;
    });

    const ruleFlags = detectAnomalies({
      transactions: withComputed,
      reconciliation: matching,
    });

    const vatFlags = flagVatDiscrepancies(computed);
    const unmatchedLedgerFlags = flagUnmatchedLedger(matching, ledger);

    const { supersededFlags } = await review.clearDerivedResults(db, fiscalPeriodId);

    // A question the accountant has already answered must not be asked again.
    // Re-raising a resolved finding on every run is how a review tool trains
    // its users to click through without reading.
    const alreadyDecided = await review.resolvedFlagKeys(db, fiscalPeriodId);
    const fresh = [...ruleFlags, ...vatFlags, ...unmatchedLedgerFlags].filter(
      (f) => !alreadyDecided.has(`${f.type}::${f.transactionId ?? ''}`),
    );

    await review.insertFlags(
      db,
      fresh.map((f) => ({ ...f, firmId: user.firmId, fiscalPeriodId })),
    );

    await review.insertReconciliations(
      db,
      matching.matches.map((m) => ({
        firmId: user.firmId,
        fiscalPeriodId,
        bankTxnId: m.bankTxnId,
        ledgerTxnId: m.ledgerTxnId,
        status: m.status,
        method: m.method,
        confidence: m.confidence,
        reasons: m.reasons,
        amountDifferencePaisa: m.amountDifferencePaisa,
        dayDifference: m.dayDifference,
      })),
    );

    await audit.record(db, {
      firmId: user.firmId,
      userId: user.id,
      action: 'reconcile',
      entityType: 'fiscal_period',
      entityId: fiscalPeriodId,
      detail: {
        bankCount: bank.length,
        ledgerCount: ledger.length,
        matched: matching.stats.matchedCount,
        flagsRaised: fresh.length,
        flagsSuperseded: supersededFlags,
        flagsSkippedAsAlreadyDecided: alreadyDecided.size,
      },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return {
      reconciliation: matching.stats,
      flagsRaised: fresh.length,
      flagsSuperseded: supersededFlags,
      flagsSkipped: alreadyDecided.size,
      transactionsComputed: computed.length,
      unmatchedBank: matching.unmatchedBank.length,
      unmatchedLedger: matching.unmatchedLedger.length,
    };
  });
}

/**
 * Compare what the client's register reported against what the engine computed.
 *
 * This is the single comparison this file makes on its own, and it is the whole
 * reason reported_* and net/vat_* are separate columns. A register that states
 * Rs. 1,000 of VAT on a Rs. 10,000 taxable sale is wrong by Rs. 300, and that
 * difference is exactly what an accountant is paid to find.
 */
function flagVatDiscrepancies(computed) {
  const flags = [];

  for (const { txn, vat } of computed) {
    if (txn.reportedVatPaisa === null || txn.reportedVatPaisa === undefined) continue;

    const difference = vat.vatPaisa - txn.reportedVatPaisa;
    if (Math.abs(difference) <= VAT_TOLERANCE_PAISA) continue;

    const understated = difference > 0;
    flags.push({
      type: 'anomaly',
      severity: Math.abs(difference) >= 10_000 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      transactionId: txn.id,
      relatedTransactionIds: [],
      message:
        `${txn.invoiceNumber ? `Invoice ${txn.invoiceNumber}` : 'An entry'} on ` +
        `${txn.txnDate}${txn.party ? ` (${txn.party})` : ''} reports VAT of ` +
        `Rs. ${format(txn.reportedVatPaisa)}, but 13% of its taxable value is ` +
        `Rs. ${format(vat.vatPaisa)} — ${understated ? 'understated' : 'overstated'} ` +
        `by Rs. ${format(Math.abs(difference))}.`,
      suggestion: understated
        ? 'Check the bill. If the register is wrong, the client has under-collected ' +
          'output VAT and owes the difference.'
        : 'Check the bill. Over-reported VAT means the client has paid more than ' +
          'was due and may be able to claim it back.',
      evidence: [
        {
          transactionId: txn.id,
          date: txn.txnDate,
          reportedVatPaisa: txn.reportedVatPaisa,
          computedVatPaisa: vat.vatPaisa,
          documentId: txn.documentId,
          sourceRef: txn.sourceRef,
        },
      ],
    });
  }

  return flags;
}

/**
 * A ledger entry with no bank movement behind it.
 *
 * The mirror of the missing-bill rule: there, money left the account with no
 * bill; here, a bill exists with no money. Usually an unpaid invoice, which is
 * fine and normal — hence medium at most — but it can also be revenue recorded
 * that was never actually received.
 */
function flagUnmatchedLedger(matching, ledger) {
  const byId = new Map(ledger.map((t) => [t.id, t]));

  return matching.unmatchedLedger
    .map((stub) => byId.get(stub.id) || stub)
    .map((txn) => ({
      type: 'missing_bill',
      severity: SEVERITY.MEDIUM,
      transactionId: txn.id,
      relatedTransactionIds: [],
      message:
        `${txn.kind === 'sale' ? 'Sales invoice' : 'Purchase bill'} ` +
        `${txn.invoiceNumber || ''} for Rs. ${format(Math.abs(txn.amountPaisa))} on ` +
        `${txn.txnDate}${txn.party ? ` (${txn.party})` : ''} has no matching bank ` +
        `movement in this period.`,
      suggestion:
        txn.kind === 'sale'
          ? 'Usually an unpaid invoice. Confirm it is a receivable and not revenue ' +
            'recorded for a sale that never completed.'
          : 'Usually an unpaid bill. Confirm it is a payable and that the expense ' +
            'belongs to this period.',
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

// ---------------------------------------------------------------------------
// Reading the review sheet
// ---------------------------------------------------------------------------

async function listFlags(user, fiscalPeriodId, options) {
  return withFirm(user.firmId, (db) => review.listFlags(db, fiscalPeriodId, options));
}

async function listReconciliations(user, fiscalPeriodId) {
  return withFirm(user.firmId, (db) => review.listReconciliations(db, fiscalPeriodId));
}

/**
 * Accept or dismiss a flag.
 *
 * The human-in-the-loop gate. The database independently requires a written
 * reason to dismiss a high-severity finding — that check is repeated here only
 * so the accountant gets a sentence rather than a constraint violation.
 */
async function resolveFlag(user, flagId, { status, note }, context = {}) {
  if (!['accepted', 'dismissed'].includes(status)) {
    throw new ApiError(400, 'A flag can be accepted or dismissed.', { code: 'invalid_status' });
  }

  return withFirm(user.firmId, async (db) => {
    const flag = await review.findFlagById(db, flagId);
    if (!flag) throw new ApiError(404, 'That flag was not found.', { code: 'not_found' });

    if (flag.status !== 'open') {
      // resolved_at is a timestamptz, which node-pg gives back as a Date.
      // String(date) renders "Thu Aug 27 2026 ..." — slicing that produced
      // "already dismissed on Thu Aug 27", which reads like a bug to anyone
      // seeing it. Formatted as a real date instead.
      const on = flag.resolvedAt
        ? ` on ${new Date(flag.resolvedAt).toISOString().slice(0, 10)}`
        : '';
      throw new ApiError(409, `That flag was already ${flag.status}${on}.`, {
        code: 'already_resolved',
      });
    }

    if (status === 'dismissed' && flag.severity === 'high') {
      if (!note || note.trim().length < 10) {
        throw new ApiError(
          400,
          'Dismissing a high-severity finding needs a written reason of at least ' +
            '10 characters. This is what makes the review sheet a defensible ' +
            'record rather than a list of clicks.',
          { code: 'reason_required' },
        );
      }
    }

    const updated = await review.resolveFlag(db, {
      id: flagId,
      status,
      userId: user.id,
      note: note?.trim() || null,
    });

    await audit.record(db, {
      firmId: user.firmId,
      userId: user.id,
      action: status === 'accepted' ? 'accept_flag' : 'dismiss_flag',
      entityType: 'flag',
      entityId: flagId,
      detail: {
        fiscalPeriodId: flag.fiscalPeriodId,
        type: flag.type,
        severity: flag.severity,
        note: note?.trim() || null,
      },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return updated;
  });
}

/**
 * The VAT summary.
 *
 * Built from the COMPUTED figures only. A transaction whose tax has not been
 * computed yet is excluded and counted, so a half-processed period reports as
 * half-processed rather than quietly reporting a smaller number as if it were
 * final.
 */
async function vatSummary(user, fiscalPeriodId) {
  return withFirm(user.firmId, async (db) => {
    const period = await clients.findPeriodById(db, fiscalPeriodId);
    if (!period) {
      throw new ApiError(404, 'That fiscal period was not found.', { code: 'not_found' });
    }

    const all = await loadAllTransactions(db, fiscalPeriodId);
    const ledger = all.filter((t) => t.source === 'ledger');
    const uncomputed = ledger.filter((t) => t.vatPaisa === null);

    const summary = summarisePeriod(
      ledger
        .filter((t) => t.vatPaisa !== null)
        .map((t) => ({
          kind: t.kind,
          netPaisa: t.netPaisa,
          vatPaisa: t.vatPaisa,
          tdsPaisa: t.tdsPaisa,
          vatApplicable: t.vatApplicable,
        })),
    );

    const openFlags = await review.listFlags(db, fiscalPeriodId, { status: 'open' });

    return {
      period: {
        id: period.id,
        label: period.label,
        startDate: period.startDate,
        endDate: period.endDate,
        isLocked: period.isLocked,
      },
      ...summary,
      uncomputedCount: uncomputed.length,
      openFlagCount: openFlags.length,
      highSeverityOpen: openFlags.filter((f) => f.severity === 'high').length,
      // Stated rather than implied. The software prepares; it does not certify,
      // and a summary that looked final would be the one place this product
      // could mislead the person relying on it.
      status:
        uncomputed.length > 0
          ? 'incomplete'
          : openFlags.length > 0
            ? 'pending_review'
            : 'ready_for_review',
      disclaimer:
        'Prepared by Attest for review. These figures are not final until an ' +
        'accountant has cleared every open flag and signed off.',
    };
  });
}

module.exports = {
  VAT_TOLERANCE_PAISA,
  MAX_PERIOD_TRANSACTIONS,
  runReconciliation,
  listFlags,
  listReconciliations,
  resolveFlag,
  vatSummary,
  _internals: { flagVatDiscrepancies, flagUnmatchedLedger },
};
