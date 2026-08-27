/**
 * Exports: the VAT summary, the transaction listing, and the review report.
 *
 * CSV rather than PDF, deliberately. An accountant's next step with these
 * figures is to key them into the IRD portal or check them in Excel, and a PDF
 * is worse at both. A PDF looks more finished, which is the argument against
 * it here — this output is working paper, not a certificate, and it should not
 * dress itself up as one.
 *
 * The review report is the artefact that matters. It records what was found,
 * what the human decided, who they were and what they wrote — which is what
 * makes the review defensible months later when somebody asks why a figure is
 * what it is.
 */

const { withFirm } = require('../config/db');
const documents = require('../repositories/document.repository');
const review = require('../repositories/review.repository');
const clients = require('../repositories/client.repository');
const audit = require('../repositories/audit.repository');
const { vatSummary } = require('./review.service');
const { ApiError } = require('../middleware/errorHandler');

/**
 * Quote a CSV field.
 *
 * The leading-character guard is not decoration: Excel and LibreOffice execute
 * a cell beginning with =, +, - or @ as a formula, so a party name a client
 * typed can become a command on the accountant's machine when they open the
 * export. Prefixing with an apostrophe neutralises it while leaving the value
 * readable. This is CSV injection, and an accounting product is exactly the
 * place it lands.
 */
function csvField(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);

  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvField).join(',');
}

function toCsv(rows) {
  // CRLF and a UTF-8 BOM: Excel opens a plain UTF-8 CSV as mojibake, which
  // makes every Devanagari party name unreadable for the person who most needs
  // to read it.
  // \uFEFF as an escape, not a literal BOM character: an invisible byte at the
  // start of a template literal is the kind of thing that gets "cleaned up" by
  // a future editor and silently breaks Excel again.
  return `\uFEFF${rows.map(csvRow).join('\r\n')}\r\n`;
}

/** Rupees as a bare number, for a column that will be summed in a spreadsheet. */
function amount(paisa) {
  if (paisa === null || paisa === undefined) return '';
  return (paisa / 100).toFixed(2);
}

async function exportVatSummary(user, fiscalPeriodId, context = {}) {
  const summary = await vatSummary(user, fiscalPeriodId);

  const rows = [
    ['Attest — VAT summary (prepared for review, not filed)'],
    ['Period', summary.period.label],
    ['From', summary.period.startDate],
    ['To', summary.period.endDate],
    [],
    ['Figure', 'Amount (NPR)'],
    ['Taxable sales', amount(summary.taxableSalesPaisa)],
    ['Exempt / zero-rated sales', amount(summary.exemptSalesPaisa)],
    ['Taxable purchases', amount(summary.taxablePurchasesPaisa)],
    ['Output VAT', amount(summary.outputVatPaisa)],
    ['Input VAT', amount(summary.inputVatPaisa)],
    [summary.position === 'creditable' ? 'Net VAT creditable' : 'Net VAT payable',
      amount(Math.abs(summary.netVatPaisa))],
    [],
    ['Status', summary.status],
    ['Open findings', String(summary.openFlagCount)],
    ['High severity open', String(summary.highSeverityOpen)],
    ['Entries with no computed figure', String(summary.uncomputedCount)],
    [],
    [summary.disclaimer],
  ];

  await recordExport(user, fiscalPeriodId, 'vat_summary', context);

  return {
    filename: `attest-vat-summary-${slug(summary.period.label)}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: toCsv(rows),
  };
}

/**
 * The review report.
 *
 * Every finding, its disposition, who decided and what they wrote. This is the
 * document that answers "why is this figure what it is" long after everyone has
 * forgotten, so open findings are listed as openly as resolved ones — an export
 * that quietly omitted what was still outstanding would be worse than no export.
 */
async function exportReviewReport(user, fiscalPeriodId, context = {}) {
  return withFirm(user.firmId, async (db) => {
    const period = await clients.findPeriodById(db, fiscalPeriodId);
    if (!period) {
      throw new ApiError(404, 'That fiscal period was not found.', { code: 'not_found' });
    }

    const flags = await review.listFlags(db, fiscalPeriodId);
    const open = flags.filter((f) => f.status === 'open');

    const rows = [
      ['Attest — review report'],
      ['Period', period.label, `${period.startDate} to ${period.endDate}`],
      ['Findings', String(flags.length), `${open.length} still open`],
      [],
      [
        'Severity', 'Type', 'Status', 'Finding', 'Suggested action',
        'Date', 'Party', 'Invoice', 'Amount (NPR)',
        'Source document', 'Source line',
        'Decided by', 'Decided on', 'Reason given',
      ],
      ...flags.map((f) => [
        f.severity,
        f.type,
        f.status,
        f.message,
        f.suggestion,
        f.txnDate,
        f.party,
        f.invoiceNumber,
        amount(f.amountPaisa),
        f.documentFilename,
        f.sourceRef?.row ?? '',
        f.resolvedByName ?? '',
        f.resolvedAt ? new Date(f.resolvedAt).toISOString().slice(0, 10) : '',
        f.resolvedNote ?? '',
      ]),
      [],
      [
        open.length > 0
          ? `${open.length} finding(s) remain open. This period has NOT been fully reviewed.`
          : 'Every finding has been reviewed. The figures are prepared, not filed.',
      ],
      ['Prepared by Attest. Nothing in this report is signed or filed — that remains the accountant’s.'],
    ];

    await audit.record(db, {
      firmId: user.firmId,
      userId: user.id,
      action: 'export',
      entityType: 'fiscal_period',
      entityId: fiscalPeriodId,
      detail: { kind: 'review_report', findings: flags.length, open: open.length },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return {
      filename: `attest-review-report-${slug(period.label)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(rows),
    };
  });
}

/** Every normalized transaction, with its provenance, for a firm's own records. */
async function exportTransactions(user, fiscalPeriodId, context = {}) {
  return withFirm(user.firmId, async (db) => {
    const period = await clients.findPeriodById(db, fiscalPeriodId);
    if (!period) {
      throw new ApiError(404, 'That fiscal period was not found.', { code: 'not_found' });
    }

    const total = await documents.countTransactionsForPeriod(db, fiscalPeriodId);
    const rows = await documents.listTransactionsForPeriod(db, fiscalPeriodId, { limit: total });

    const csv = [
      [
        'Date', 'BS date', 'Source', 'Kind', 'Description', 'Party', 'PAN',
        'Invoice', 'Reference', 'Amount (NPR)', 'Direction',
        'Reported net', 'Reported VAT', 'Computed net', 'Computed VAT', 'Computed TDS',
        'Source document', 'Source line',
      ],
      ...rows.map((t) => [
        t.txnDate,
        t.bsDateLabel,
        t.source,
        t.kind,
        t.description,
        t.party,
        t.partyPan,
        t.invoiceNumber,
        t.reference,
        amount(t.amountPaisa),
        t.direction,
        // Reported and computed side by side, deliberately. The whole point of
        // keeping them apart is that someone can compare them.
        amount(t.reportedNetPaisa),
        amount(t.reportedVatPaisa),
        amount(t.netPaisa),
        amount(t.vatPaisa),
        amount(t.tdsPaisa),
        t.documentFilename,
        t.sourceRef?.row ?? '',
      ]),
    ];

    await audit.record(db, {
      firmId: user.firmId,
      userId: user.id,
      action: 'export',
      entityType: 'fiscal_period',
      entityId: fiscalPeriodId,
      detail: { kind: 'transactions', rows: rows.length },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return {
      filename: `attest-transactions-${slug(period.label)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(csv),
    };
  });
}

async function recordExport(user, fiscalPeriodId, kind, context) {
  await withFirm(user.firmId, (db) =>
    audit.record(db, {
      firmId: user.firmId,
      userId: user.id,
      action: 'export',
      entityType: 'fiscal_period',
      entityId: fiscalPeriodId,
      detail: { kind },
      ip: context.ip,
      userAgent: context.userAgent,
    }),
  );
}

function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = {
  exportVatSummary,
  exportReviewReport,
  exportTransactions,
  _internals: { csvField, toCsv, amount },
};
