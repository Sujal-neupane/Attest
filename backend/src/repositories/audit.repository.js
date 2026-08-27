/**
 * The audit trail.
 *
 * Insert-only by design and by trigger: the table refuses UPDATE and DELETE at
 * the database level, so there is deliberately no update function here to be
 * called by mistake. Corrections are new entries.
 */

async function record(client, { firmId, userId, action, entityType, entityId, detail, ip, userAgent }) {
  const { rows } = await client.query(
    `INSERT INTO audit_log
       (firm_id, user_id, action, entity_type, entity_id, detail, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at AS "createdAt"`,
    [
      firmId,
      userId ?? null,
      action,
      entityType,
      entityId ?? null,
      detail ?? {},
      ip ?? null,
      userAgent ?? null,
    ],
  );
  return rows[0];
}

async function listForPeriod(client, fiscalPeriodId, { limit = 200 } = {}) {
  const { rows } = await client.query(
    `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
            a.detail, a.created_at AS "createdAt",
            u.full_name AS "userName", u.email AS "userEmail"
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.detail->>'fiscalPeriodId' = $1
         OR a.entity_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [fiscalPeriodId, limit],
  );
  return rows;
}

async function listForFirm(client, { limit = 200, before } = {}) {
  const { rows } = await client.query(
    `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
            a.detail, a.created_at AS "createdAt",
            u.full_name AS "userName", u.email AS "userEmail"
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE ($1::timestamptz IS NULL OR a.created_at < $1)
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [before ?? null, limit],
  );
  return rows;
}

module.exports = { record, listForPeriod, listForFirm };
