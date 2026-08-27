/**
 * Reading a single invoice — the AI path.
 *
 * ─── WHERE THIS JOINS THE REST OF THE SYSTEM ────────────────────────────────
 *
 * A CSV register arrives as columns; an invoice arrives as a picture of a page.
 * The AI's whole job is to close that gap — to turn a page into fields. From
 * the moment it has, this file does exactly what the CSV importer does:
 *
 *   parse the text with domain/money.js and utils/dates.js
 *   refuse anything ambiguous rather than guessing
 *   emit a transaction with provenance back to the source
 *
 * The model does not compute, and it does not parse. It locates. Every figure
 * still becomes a number through the same code that reads a bank statement,
 * which is why an AI-read invoice and a hand-typed register are equally
 * trustworthy downstream — or equally distrusted, which is the same thing.
 */

const { parseAmount, MoneyError } = require('../../domain/money');
const { parseDate, looksBikramSambat, DateError } = require('../../utils/dates');
const { bsToAd, adToBs } = require('../../utils/nepaliCalendar');
const { extractInvoice, toTransactionDraft } = require('../ai/extract');

class InvoiceError extends Error {
  constructor(message, { permanent = true, details } = {}) {
    super(message);
    this.name = 'InvoiceError';
    // Almost every invoice failure is permanent — an unreadable scan does not
    // become readable on the third attempt.
    this.permanent = permanent;
    this.details = details;
  }
}

/**
 * Pull the text layer out of a PDF.
 *
 * A PDF produced by accounting software has real text and this works perfectly.
 * A photographed or scanned bill has no text layer at all, and this returns
 * almost nothing — which is detected and reported rather than handed to the
 * model as an empty page. That case needs OCR, which is not built yet, and
 * saying so is better than a confident extraction of nothing.
 */
async function extractPdfText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return { text: result.text ?? '', pages: result.pages?.length ?? result.total ?? null };
  } catch (err) {
    throw new InvoiceError(
      `This PDF could not be read: ${err.message}. If it is password-protected, ` +
        `remove the password and upload it again.`,
      { permanent: true },
    );
  } finally {
    await parser.destroy?.();
  }
}

/** Enough characters to be a document rather than a scan with no text layer. */
const MIN_TEXT_LENGTH = 40;

async function readDocumentText(contents, filename) {
  const isPdf =
    contents.subarray(0, 5).toString('latin1') === '%PDF-' ||
    /\.pdf$/i.test(filename ?? '');

  if (!isPdf) return { text: contents.toString('utf8'), pages: null };

  const { text, pages } = await extractPdfText(contents);

  if (text.trim().length < MIN_TEXT_LENGTH) {
    throw new InvoiceError(
      'This PDF has no readable text — it is a scan or a photograph rather than ' +
        'a generated document. Attest cannot read it yet: OCR is not built. ' +
        'Enter this bill through a purchase register for now.',
      { permanent: true },
    );
  }

  return { text, pages };
}

/**
 * Read one invoice into a transaction.
 *
 * @param {Buffer} contents
 * @param {object} context  { documentId, filename, firmId, clientId, fiscalPeriodId,
 *                            periodStart, periodEnd }
 * @param {object} deps     { client, betaZodTool, betaZodOutputFormat }
 */
async function parseInvoice(contents, context, deps) {
  const { text, pages } = await readDocumentText(contents, context.filename);

  const result = await extractInvoice(
    { documentText: text, context },
    deps,
  );

  // Everything the model can get wrong arrives here as a status, not an
  // exception — so each one can be reported to the accountant in its own words.
  if (result.status !== 'extracted') {
    throw new InvoiceError(explainFailure(result), {
      permanent: true,
      details: { status: result.status, ungrounded: result.ungrounded },
    });
  }

  const draft = toTransactionDraft(result.extraction, {
    documentId: context.documentId,
    sourceRef: { pages, toolCalls: result.toolCalls.map((c) => c.name) },
  });

  const transaction = toTransaction(draft, context);

  return {
    transactions: [transaction],
    issues: [],
    notes: [
      `Read by ${draft.sourceRef.extractedBy}. Every value was checked back ` +
        `against the document text before being accepted.`,
      ...(result.extraction.notes ? [`Model note: ${result.extraction.notes}`] : []),
      ...(result.toolCalls.length
        ? [`The model looked things up ${result.toolCalls.length} time(s) while reading.`]
        : []),
    ],
    stats: {
      rowsRead: 1,
      imported: 1,
      errors: 0,
      warnings: 0,
      kind: draft.kind,
      usage: result.usage ?? null,
    },
  };
}

/**
 * Turn the verified strings into a transaction.
 *
 * THIS is where text becomes money, and it is the same code path a CSV row
 * takes. If the invoice's date is ambiguous it is refused here exactly as it
 * would be in a register — the model's involvement does not lower the bar.
 */
function toTransaction(draft, context) {
  if (!draft.rawGrossAmount && !draft.rawTaxableAmount) {
    throw new InvoiceError(
      'No amount could be found on this invoice. Check that the total is legible ' +
        'and upload it again, or enter it through a register.',
    );
  }

  let txnDate;
  let bsLabel = null;
  try {
    const parsed = parseDate(draft.rawDate);
    if (parsed.calendar === 'BS') {
      txnDate = bsToAd(parsed);
      bsLabel = adToBs(txnDate).label;
    } else {
      txnDate = parsed.iso;
      if (looksBikramSambat(draft.rawDate)) bsLabel = adToBs(txnDate).label;
    }
  } catch (err) {
    if (err instanceof DateError) {
      throw new InvoiceError(
        `The date on this invoice ("${draft.rawDate}") could not be read: ${err.message}`,
      );
    }
    throw err;
  }

  const money = (raw) => {
    if (!raw) return null;
    try {
      return Math.abs(parseAmount(raw));
    } catch (err) {
      throw new InvoiceError(
        `The amount "${raw}" on this invoice could not be read: ` +
          `${err instanceof MoneyError ? err.message : err.message}`,
      );
    }
  };

  const taxable = money(draft.rawTaxableAmount);
  const vat = money(draft.rawVatAmount);
  const gross = money(draft.rawGrossAmount) ?? (taxable ?? 0) + (vat ?? 0);

  const isSale = draft.kind === 'sale';
  const signed = isSale ? gross : -gross;

  return {
    documentId: draft.documentId,
    source: 'ledger',
    kind: draft.kind,
    txnDate,
    bsDate: bsLabel,
    description: draft.notes ? `Invoice — ${draft.notes}` : 'Invoice',
    party: draft.party,
    partyPan: draft.partyPan,
    invoiceNumber: draft.invoiceNumber,
    reference: null,

    amountPaisa: signed,
    direction: signed < 0 ? 'debit' : 'credit',

    // The model's proposal, recorded AS a proposal. TDS is not computed from it
    // until an accountant confirms the classification.
    tdsCategory: draft.suggestedTdsCategory,
    categorySource: draft.suggestedTdsCategory ? 'ai' : null,

    // Reported by the document, exactly as a register's figures are. The tax
    // engine computes its own and flags any difference — an invoice that
    // misstates its own VAT is as much a finding as a register that does.
    reportedNetPaisa: taxable,
    reportedVatPaisa: vat,
    vatApplicable: vat === null ? true : vat > 0,

    outsidePeriod:
      context.periodStart && context.periodEnd
        ? txnDate < context.periodStart || txnDate > context.periodEnd
        : false,

    sourceRef: draft.sourceRef,
  };
}

function explainFailure(result) {
  switch (result.status) {
    case 'ungrounded':
      return (
        `${result.reason} The values that could not be verified were: ` +
        `${result.ungrounded.map((u) => u.field).join(', ')}. ` +
        `Attest refuses an extraction it cannot check against the document, ` +
        `because a figure that was not read is a figure that was invented.`
      );
    case 'refused':
      return `The model declined to read this document: ${result.reason}`;
    case 'incomplete':
      return `${result.reason} Try a clearer scan, or enter this bill through a register.`;
    case 'unparseable':
      return result.reason;
    default:
      return `Extraction failed: ${result.status}`;
  }
}

module.exports = {
  InvoiceError,
  parseInvoice,
  readDocumentText,
  extractPdfText,
  _internals: { toTransaction, explainFailure, MIN_TEXT_LENGTH },
};
