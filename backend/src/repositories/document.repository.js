/**
 * SQL for documents and the transactions parsed out of them.
 *
 * As everywhere, row-level security supplies the firm filter; these queries
 * scope only by the ids the caller actually asked about.
 */

const { insertMany } = require('./batch');

const DOCUMENT_COLUMNS = `
  id, client_id AS "clientId", fiscal_period_id AS "fiscalPeriodId", type,
  filename, storage_key AS "storageKey", content_hash AS "contentHash",
  byte_size AS "byteSize", page_count AS "pageCount", status,
  failure_reason AS "failureReason", parsed_at AS "parsedAt",
  uploaded_by AS "uploadedBy", created_at AS "createdAt"
`;

async function create(client, doc) {
  const { rows } = await client.query(
    `INSERT INTO documents
       (id, firm_id, client_id, fiscal_period_id, type, filename, storage_key,
        content_hash, byte_size, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${DOCUMENT_COLUMNS}`,
    [
      doc.id,
      doc.firmId,
      doc.clientId,
      doc.fiscalPeriodId,
      doc.type,
      doc.filename,
      doc.storageKey,
      doc.contentHash ?? null,
      doc.byteSize ?? null,
      doc.uploadedBy,
    ],
  );
  return rows[0];
}

async function findById(client, id) {
  const { rows } = await client.query(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function listForPeriod(client, fiscalPeriodId) {
  const { rows } = await client.query(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents
      WHERE fiscal_period_id = $1
      ORDER BY created_at DESC`,
    [fiscalPeriodId],
  );
  return rows;
}

/** The same file uploaded twice into one period, found by content hash. */
async function findDuplicate(client, { fiscalPeriodId, contentHash }) {
  const { rows } = await client.query(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents
      WHERE fiscal_period_id = $1 AND content_hash = $2
      LIMIT 1`,
    [fiscalPeriodId, contentHash],
  );
  return rows[0] || null;
}

async function markProcessing(client, id) {
  await client.query(
    `UPDATE documents SET status = 'processing' WHERE id = $1`,
    [id],
  );
}

async function markParsed(client, id, { pageCount } = {}) {
  await client.query(
    `UPDATE documents
        SET status = 'parsed', parsed_at = now(), failure_reason = NULL,
            page_count = COALESCE($2, page_count)
      WHERE id = $1`,
    [id, pageCount ?? null],
  );
}

/**
 * A document that could not be parsed is marked failed WITH its reason, never
 * left in 'processing' and never quietly dropped. The schema enforces the pair:
 * status = 'failed' requires a failure_reason and vice versa.
 */
async function markFailed(client, id, reason) {
  await client.query(
    `UPDATE documents SET status = 'failed', failure_reason = $2 WHERE id = $1`,
    [id, String(reason).slice(0, 2000)],
  );
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Insert a batch of parsed transactions.
 *
 * One multi-row INSERT rather than a loop of single inserts: a bank statement
 * is hundreds of rows, and a round trip each would make parsing dominated by
 * network latency rather than by work.
 */
async function insertTransactions(client, rows) {
  return insertMany(client, {
    table: 'transactions',
    columns: [
      'firm_id', 'client_id', 'fiscal_period_id', 'document_id', 'source', 'kind',
      'txn_date', 'description', 'party', 'invoice_number', 'reference',
      'amount_paisa', 'direction', 'source_ref',
      // What the client's books SAY — never overwritten by the tax engine.
      'reported_net_paisa', 'reported_vat_paisa', 'vat_applicable',
      'party_pan', 'bs_date_label',
      // The classification, and WHO decided it. "Who said this was rent" is
      // exactly the question an auditor asks, so the answer is stored rather
      // than inferred later.
      'tds_category', 'category_source',
    ],
    rows,
    toValues: (row) => [
      row.firmId, row.clientId, row.fiscalPeriodId, row.documentId,
      row.source, row.kind, row.txnDate, row.description ?? '',
      row.party ?? null, row.invoiceNumber ?? null, row.reference ?? null,
      row.amountPaisa, row.direction, row.sourceRef ?? {},
      row.reportedNetPaisa ?? null, row.reportedVatPaisa ?? null,
      row.vatApplicable ?? true, row.partyPan ?? null, row.bsDateLabel ?? null,
      row.tdsCategory ?? null, row.categorySource ?? null,
    ],
    returning: 'id, txn_date AS "txnDate", amount_paisa AS "amountPaisa"',
  });
}

async function listTransactionsForPeriod(client, fiscalPeriodId, { source, limit = 1000 } = {}) {
  const { rows } = await client.query(
    `SELECT t.id, t.source, t.kind, t.txn_date AS "txnDate", t.description,
            t.party, t.invoice_number AS "invoiceNumber", t.reference,
            t.amount_paisa AS "amountPaisa", t.direction,
            t.net_paisa AS "netPaisa", t.vat_paisa AS "vatPaisa",
            t.tds_paisa AS "tdsPaisa", t.category,
            t.tds_category AS "tdsCategory",
            t.category_source AS "categorySource",
            t.category_confirmed_by AS "categoryConfirmedBy",
            t.reported_net_paisa AS "reportedNetPaisa",
            t.reported_vat_paisa AS "reportedVatPaisa",
            t.vat_applicable AS "vatApplicable",
            t.party_pan AS "partyPan", t.bs_date_label AS "bsDateLabel",
            t.source_ref AS "sourceRef", t.document_id AS "documentId",
            d.filename AS "documentFilename"
       FROM transactions t
       JOIN documents d ON d.id = t.document_id
      WHERE t.fiscal_period_id = $1
        AND ($2::txn_source IS NULL OR t.source = $2)
      ORDER BY t.txn_date, t.created_at
      LIMIT $3`,
    [fiscalPeriodId, source ?? null, limit],
  );
  return rows;
}

/** Total transactions in a period, used to detect a truncated read. */
async function countTransactionsForPeriod(client, fiscalPeriodId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM transactions WHERE fiscal_period_id = $1`,
    [fiscalPeriodId],
  );
  return rows[0].count;
}

/** How many transactions a document produced, used to make re-parsing safe. */
async function countTransactionsForDocument(client, documentId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM transactions WHERE document_id = $1`,
    [documentId],
  );
  return rows[0].count;
}

module.exports = {
  create,
  findById,
  listForPeriod,
  findDuplicate,
  markProcessing,
  markParsed,
  markFailed,
  insertTransactions,
  listTransactionsForPeriod,
  countTransactionsForPeriod,
  countTransactionsForDocument,
};
