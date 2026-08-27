/**
 * SQL for client businesses and their fiscal periods.
 *
 * Note the consistent absence of `WHERE firm_id = $n`. That is not an
 * oversight: row-level security applies it on every statement below. Writing it
 * out as well would imply the filter is what protects the data, and the next
 * person to add a query would assume forgetting it is merely a bug rather than
 * a non-event.
 */

const CLIENT_COLUMNS = `
  id, name, pan, is_archived AS "isArchived", created_at AS "createdAt"
`;

const PERIOD_COLUMNS = `
  id, client_id AS "clientId", label, bs_year AS "bsYear", bs_month AS "bsMonth",
  start_date AS "startDate", end_date AS "endDate", is_locked AS "isLocked",
  created_at AS "createdAt"
`;

async function createClient(client, { firmId, name, pan }) {
  const { rows } = await client.query(
    `INSERT INTO clients (firm_id, name, pan)
     VALUES ($1, $2, $3)
     RETURNING ${CLIENT_COLUMNS}`,
    [firmId, name, pan ?? null],
  );
  return rows[0];
}

async function listClients(client, { includeArchived = false } = {}) {
  const { rows } = await client.query(
    `SELECT ${CLIENT_COLUMNS}
       FROM clients
      WHERE ($1::boolean OR NOT is_archived)
      ORDER BY name`,
    [includeArchived],
  );
  return rows;
}

async function findClientById(client, id) {
  const { rows } = await client.query(
    `SELECT ${CLIENT_COLUMNS} FROM clients WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Archive rather than delete. Financial records are never hard-deleted — the
 * periods, documents and transactions beneath a client remain, and the foreign
 * keys are ON DELETE RESTRICT so a delete would fail anyway.
 */
async function archiveClient(client, id) {
  const { rows } = await client.query(
    `UPDATE clients SET is_archived = true WHERE id = $1 RETURNING ${CLIENT_COLUMNS}`,
    [id],
  );
  return rows[0] || null;
}

async function createPeriod(client, { firmId, clientId, label, bsYear, bsMonth, startDate, endDate }) {
  const { rows } = await client.query(
    `INSERT INTO fiscal_periods
       (firm_id, client_id, label, bs_year, bs_month, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${PERIOD_COLUMNS}`,
    [firmId, clientId, label, bsYear, bsMonth ?? null, startDate, endDate],
  );
  return rows[0];
}

async function listPeriods(client, clientId) {
  const { rows } = await client.query(
    `SELECT ${PERIOD_COLUMNS}
       FROM fiscal_periods
      WHERE client_id = $1
      ORDER BY start_date DESC`,
    [clientId],
  );
  return rows;
}

async function findPeriodById(client, id) {
  const { rows } = await client.query(
    `SELECT ${PERIOD_COLUMNS} FROM fiscal_periods WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Overlapping periods for the same client would double-count a transaction
 * across two VAT returns, so the check happens before insert and the caller
 * turns it into a refusal the accountant can act on.
 */
async function findOverlappingPeriod(client, { clientId, startDate, endDate }) {
  const { rows } = await client.query(
    `SELECT ${PERIOD_COLUMNS}
       FROM fiscal_periods
      WHERE client_id = $1
        AND start_date <= $3
        AND end_date >= $2
      LIMIT 1`,
    [clientId, startDate, endDate],
  );
  return rows[0] || null;
}

module.exports = {
  createClient,
  listClients,
  findClientById,
  archiveClient,
  createPeriod,
  listPeriods,
  findPeriodById,
  findOverlappingPeriod,
};
