/**
 * The parse worker: document in storage → normalized transactions in the ledger.
 *
 * Runs outside any HTTP request. Everything it touches happens inside
 * withFirm() for the job's firm, under the same row-level security as a request
 * — the only cross-firm thing it does is claim a job, through the narrow
 * SECURITY DEFINER function in migration 003.
 *
 * ─── THE RULE THIS WORKER EXISTS TO UPHOLD ──────────────────────────────────
 *
 * A document ends in exactly one of two states: `parsed`, with its transactions
 * written and its issues recorded; or `failed`, with a reason an accountant can
 * read and act on. It is never left in `processing`, and it is never silently
 * dropped. An upload that appears to do nothing is indistinguishable from one
 * that lost the client's data.
 */

const documents = require('../repositories/document.repository');
const audit = require('../repositories/audit.repository');
const queue = require('../services/queue');
const { withFirm } = require('../config/db');
const { parseBankStatement } = require('../services/parsing/bankStatement');
const { parseRegister } = require('../services/parsing/register');
const { parseInvoice, InvoiceError } = require('../services/parsing/invoice');
const aiClient = require('../services/ai/client');
const { CsvError } = require('../services/parsing/csv');
const { ColumnMapError } = require('../services/parsing/columnMap');
const { DateError } = require('../utils/dates');
const { NepaliCalendarError } = require('../utils/nepaliCalendar');
const { MoneyError } = require('../domain/money');

/**
 * Failures that retrying cannot fix.
 *
 * A file with no amount column will not grow one on the third attempt, and a
 * statement whose dates contradict each other will contradict itself just as
 * hard in thirty minutes. Retrying these wastes half an hour of the
 * accountant's time before showing them a message that was available
 * immediately.
 */
const PERMANENT_FAILURES = [
  CsvError,
  ColumnMapError,
  DateError,
  NepaliCalendarError,
  MoneyError,
  // An unreadable scan does not become readable on the third attempt, and no
  // amount of waiting produces an API key.
  InvoiceError,
  aiClient.AiUnavailableError,
];

function isPermanent(error) {
  return PERMANENT_FAILURES.some((Type) => error instanceof Type);
}

/**
 * Process one claimed job.
 *
 * @param {object} job     from queue.claim()
 * @param {object} deps    { store, logger }
 */
async function handleParseDocument(job, { store, logger = console }) {
  const { documentId } = job.payload;
  const { firmId } = job;

  const document = await withFirm(firmId, async (db) => {
    const found = await documents.findById(db, documentId);
    if (found) await documents.markProcessing(db, documentId);
    return found;
  });

  if (!document) {
    // The row is gone. Nothing to retry towards, so this dies rather than
    // failing identically three times.
    throw Object.assign(new Error(`Document ${documentId} no longer exists.`), {
      permanent: true,
    });
  }

  // Re-parsing a document that already produced transactions would double every
  // figure in the period. Refused outright: the safe fix is a new upload, not a
  // second pass over the same file.
  const existing = await withFirm(firmId, (db) =>
    documents.countTransactionsForDocument(db, documentId),
  );
  if (existing > 0) {
    throw Object.assign(
      new Error(
        `Document ${documentId} already produced ${existing} transactions. ` +
          `Parsing it again would double every figure in the period.`,
      ),
      { permanent: true },
    );
  }

  const contents = await store.get(document.storageKey);
  const text = contents.toString('utf8');

  const period = await withFirm(firmId, async (db) => {
    const { rows } = await db.query(
      `SELECT start_date AS "startDate", end_date AS "endDate"
         FROM fiscal_periods WHERE id = $1`,
      [document.fiscalPeriodId],
    );
    return rows[0];
  });

  const result = await parseDocumentByType(document, text, contents, {
    documentId,
    filename: document.filename,
    firmId,
    clientId: document.clientId,
    fiscalPeriodId: document.fiscalPeriodId,
    periodStart: period?.startDate,
    periodEnd: period?.endDate,
  });

  // Everything below lands in ONE transaction: the transactions, the document's
  // new status, the audit entry and the job's completion. A crash between any
  // two of them would otherwise leave a half-imported period, which is worse
  // than an import that plainly failed.
  await withFirm(firmId, async (db) => {
    const toInsert = result.transactions.map((txn) => ({
      firmId,
      clientId: document.clientId,
      fiscalPeriodId: document.fiscalPeriodId,
      documentId,
      source: txn.source,
      kind: txn.kind,
      txnDate: txn.txnDate,
      description: txn.description,
      party: txn.party,
      invoiceNumber: txn.invoiceNumber,
      reference: txn.reference,
      amountPaisa: txn.amountPaisa,
      direction: txn.direction,
      sourceRef: txn.sourceRef,
      reportedNetPaisa: txn.reportedNetPaisa,
      reportedVatPaisa: txn.reportedVatPaisa,
      vatApplicable: txn.vatApplicable,
      partyPan: txn.partyPan,
      bsDateLabel: txn.bsDate,
      tdsCategory: txn.tdsCategory,
      categorySource: txn.categorySource,
    }));

    await documents.insertTransactions(db, toInsert);
    await documents.markParsed(db, documentId);

    await audit.record(db, {
      firmId,
      userId: null, // the system did this, not a person
      action: 'parse_document',
      entityType: 'document',
      entityId: documentId,
      detail: {
        fiscalPeriodId: document.fiscalPeriodId,
        imported: result.transactions.length,
        issues: result.issues.length,
        errors: result.stats.errors,
        notes: result.notes,
        balanceConsistent: result.balanceCheck?.consistent ?? null,
      },
    });

    await queue.succeed(db, job.id);
  });

  logger.info?.(
    { documentId, imported: result.transactions.length, issues: result.issues.length },
    'document parsed',
  );

  return {
    documentId,
    imported: result.transactions.length,
    issues: result.issues,
    notes: result.notes,
    balanceCheck: result.balanceCheck,
  };
}

/**
 * Async because the invoice path calls a model; the CSV paths stay synchronous
 * underneath and are simply awaited.
 */
async function parseDocumentByType(document, text, contents, context) {
  switch (document.type) {
    case 'bank_statement':
      return parseBankStatement(text, context);
    case 'sales_register':
    case 'purchase_register':
      return parseRegister(text, document.type, context);
    case 'invoice':
      // Throws AiUnavailableError with an explanation if no key is configured,
      // which the accountant sees on the document rather than as a crash.
      return parseInvoice(contents, context, aiClient.getClient());
    default:
      throw Object.assign(new Error(`Unknown document type: ${document.type}`), {
        permanent: true,
      });
  }
}

/**
 * Claim and run one job, if there is one.
 *
 * @returns {Promise<object|null>} null when the queue is empty
 */
async function runOnce({ store, logger = console } = {}) {
  const job = await queue.claim([queue.JOB_TYPES.PARSE_DOCUMENT]);
  if (!job) return null;

  try {
    const result = await handleParseDocument(job, { store, logger });
    return { job, result, ok: true };
  } catch (error) {
    const permanent = error.permanent === true || isPermanent(error);

    // The document is marked failed WITH the reason in the same breath as the
    // job. The accountant reads the document's status, not the job table, so a
    // job that failed while the document still says 'processing' is a bug that
    // looks exactly like a stuck upload.
    await withFirm(job.firmId, async (db) => {
      const outcome = await queue.fail(db, job, error, { permanent });
      if (outcome.dead && job.payload.documentId) {
        await documents.markFailed(db, job.payload.documentId, error.message);
        await audit.record(db, {
          firmId: job.firmId,
          userId: null,
          action: 'document_failed',
          entityType: 'document',
          entityId: job.payload.documentId,
          detail: { reason: error.message, attempts: job.attempts, permanent },
        });
      }
    }).catch((nested) => {
      // If even the failure cannot be recorded, say so loudly rather than
      // swallowing it — this is how documents get stranded.
      logger.error?.({ err: nested, jobId: job.id }, 'could not record job failure');
    });

    logger.warn?.({ err: error, jobId: job.id, permanent }, 'job failed');
    return { job, error, ok: false, permanent };
  }
}

module.exports = { runOnce, handleParseDocument, isPermanent, PERMANENT_FAILURES };
