/**
 * SQL for reconciliation results, computed tax figures, and flags.
 */

const { insertMany } = require('./batch');

const FLAG_COLUMNS = `
  f.id, f.transaction_id AS "transactionId",
  f.related_transaction_ids AS "relatedTransactionIds",
  f.type, f.severity, f.message, f.suggestion, f.ai_drafted AS "aiDrafted",
  f.evidence, f.status, f.resolved_by AS "resolvedBy",
  f.resolved_note AS "resolvedNote", f.resolved_at AS "resolvedAt",
  f.created_at AS "createdAt"
`;

/**
 * Replace a period's derived results.
 *
 * Reconciling twice must not double the flags, and re-running after new
 * documents arrive must not leave stale findings behind. Derived data is
 * therefore rebuilt wholesale rather than merged.
 *
 * The exception is deliberate and important: a flag a human has already
 * resolved is NOT discarded. Their decision, note and attribution survive a
 * re-run — losing an accountant's work because a colleague uploaded another
 * statement would be unforgivable, and re-asking a question they have already
 * answered is how a review tool loses trust.
 */
async function clearDerivedResults(client, fiscalPeriodId) {
  // Nothing in this application hard-deletes a financial record — there is no
  // DELETE grant at all (see migration 002) — so stale open flags are marked
  // 'superseded', which is a system action with its own status rather than a
  // 'dismissed' that would falsely imply a person decided it.
  const { rowCount: supersededFlags } = await client.query(
    `UPDATE flags
        SET status = 'superseded',
            resolved_note = 'Superseded by a later reconciliation run.',
            resolved_at = now()
      WHERE fiscal_period_id = $1 AND status = 'open'`,
    [fiscalPeriodId],
  );

  return { supersededFlags };
}

/** Flags a human has already decided on, keyed so a re-run can skip re-raising them. */
async function resolvedFlagKeys(client, fiscalPeriodId) {
  const { rows } = await client.query(
    `SELECT type, transaction_id AS "transactionId"
       FROM flags
      WHERE fiscal_period_id = $1 AND status <> 'open' AND resolved_by IS NOT NULL`,
    [fiscalPeriodId],
  );
  return new Set(rows.map((r) => `${r.type}::${r.transactionId ?? ''}`));
}

async function insertFlags(client, rows) {
  return insertMany(client, {
    table: 'flags',
    columns: [
      'firm_id', 'fiscal_period_id', 'transaction_id', 'related_transaction_ids',
      'type', 'severity', 'message', 'suggestion', 'ai_drafted', 'evidence',
    ],
    rows,
    toValues: (row) => [
      row.firmId, row.fiscalPeriodId, row.transactionId ?? null,
      row.relatedTransactionIds ?? [], row.type, row.severity, row.message,
      row.suggestion ?? null, row.aiDrafted ?? false,
      JSON.stringify(row.evidence ?? []),
    ],
    returning: 'id, type, severity',
  });
}

async function listFlags(client, fiscalPeriodId, { status } = {}) {
  const { rows } = await client.query(
    `SELECT ${FLAG_COLUMNS},
            u.full_name AS "resolvedByName",
            t.txn_date AS "txnDate", t.amount_paisa AS "amountPaisa",
            t.party, t.invoice_number AS "invoiceNumber",
            -- The date in the client's own calendar. The review sheet shows both
            -- so nobody converts in their head; without this the card silently
            -- rendered the Gregorian date alone.
            t.bs_date_label AS "bsDateLabel",
            t.document_id AS "documentId", t.source_ref AS "sourceRef",
            d.filename AS "documentFilename"
       FROM flags f
       LEFT JOIN users u ON u.id = f.resolved_by
       LEFT JOIN transactions t ON t.id = f.transaction_id
       LEFT JOIN documents d ON d.id = t.document_id
      WHERE f.fiscal_period_id = $1
        AND ($2::flag_status IS NULL OR f.status = $2)
      ORDER BY
        -- Open first, then most severe: the reviewer should land on the thing
        -- that most needs a decision without sorting anything themselves.
        (f.status = 'open') DESC,
        CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        f.created_at`,
    [fiscalPeriodId, status ?? null],
  );
  return rows;
}

async function findFlagById(client, id) {
  const { rows } = await client.query(
    `SELECT ${FLAG_COLUMNS}, f.fiscal_period_id AS "fiscalPeriodId"
       FROM flags f WHERE f.id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function resolveFlag(client, { id, status, userId, note }) {
  const { rows } = await client.query(
    `UPDATE flags
        SET status = $2, resolved_by = $3, resolved_note = $4, resolved_at = now()
      WHERE id = $1
      RETURNING ${FLAG_COLUMNS.replaceAll('f.', '')}`,
    [id, status, userId, note ?? null],
  );
  return rows[0] || null;
}

async function insertReconciliations(client, rows) {
  return insertMany(client, {
    table: 'reconciliations',
    columns: [
      'firm_id', 'fiscal_period_id', 'bank_txn_id', 'ledger_txn_id', 'status',
      'method', 'confidence', 'reasons', 'amount_difference_paisa', 'day_difference',
    ],
    rows,
    toValues: (row) => [
      row.firmId, row.fiscalPeriodId, row.bankTxnId ?? null, row.ledgerTxnId ?? null,
      row.status, row.method ?? null, row.confidence ?? null,
      JSON.stringify(row.reasons ?? []),
      row.amountDifferencePaisa ?? null, row.dayDifference ?? null,
    ],
    // A transaction may appear in at most one match. Re-running reconciliation
    // must update the verdict rather than fail on the unique index.
    conflict: `ON CONFLICT (bank_txn_id) WHERE bank_txn_id IS NOT NULL
     DO UPDATE SET status = EXCLUDED.status,
                   ledger_txn_id = EXCLUDED.ledger_txn_id,
                   method = EXCLUDED.method,
                   confidence = EXCLUDED.confidence,
                   reasons = EXCLUDED.reasons,
                   amount_difference_paisa = EXCLUDED.amount_difference_paisa,
                   day_difference = EXCLUDED.day_difference`,
    returning: 'id, status',
  });
}

async function listReconciliations(client, fiscalPeriodId) {
  const { rows } = await client.query(
    `SELECT r.id, r.status, r.method, r.confidence, r.reasons,
            r.amount_difference_paisa AS "amountDifferencePaisa",
            r.day_difference AS "dayDifference",
            r.bank_txn_id AS "bankTxnId", r.ledger_txn_id AS "ledgerTxnId",
            r.confirmed_by AS "confirmedBy"
       FROM reconciliations r
      WHERE r.fiscal_period_id = $1
      ORDER BY r.created_at`,
    [fiscalPeriodId],
  );
  return rows;
}

/**
 * Write the computed tax figures back onto transactions.
 *
 * These are the figures that reach a return, and they are written only by the
 * deterministic engine — never by a parser, never by a model.
 */
async function updateComputedTax(client, rows) {
  if (rows.length === 0) return 0;

  const { rowCount } = await client.query(
    `UPDATE transactions t
        SET net_paisa = v.net_paisa,
            vat_paisa = v.vat_paisa,
            tds_paisa = v.tds_paisa
       FROM (
         SELECT unnest($1::uuid[]) AS id,
                unnest($2::bigint[]) AS net_paisa,
                unnest($3::bigint[]) AS vat_paisa,
                unnest($4::bigint[]) AS tds_paisa
       ) AS v
      WHERE t.id = v.id`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.netPaisa),
      rows.map((r) => r.vatPaisa),
      rows.map((r) => r.tdsPaisa),
    ],
  );
  return rowCount;
}

module.exports = {
  clearDerivedResults,
  resolvedFlagKeys,
  insertFlags,
  listFlags,
  findFlagById,
  resolveFlag,
  insertReconciliations,
  listReconciliations,
  updateComputedTax,
};
