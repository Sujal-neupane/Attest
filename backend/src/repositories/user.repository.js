/**
 * All SQL touching users.
 *
 * Repositories are the only layer permitted to write SQL. Services call
 * repositories; controllers call services. That boundary is what lets the
 * domain logic be tested without a database and what stops query strings from
 * spreading into places nobody thinks to audit.
 *
 * Every function here takes a `client` — the transaction-scoped connection
 * handed down by `withFirm()` with the firm already set — except the two that
 * cannot, because they run before we know which firm the user belongs to.
 */

const crypto = require('node:crypto');
const { unscoped, pool } = require('../config/db');

const PUBLIC_COLUMNS = `
  id, firm_id AS "firmId", email, full_name AS "fullName",
  role, is_active AS "isActive", last_login_at AS "lastLoginAt",
  created_at AS "createdAt"
`;

/**
 * Look a user up by email for sign-in.
 *
 * Goes through attest_login_lookup(), a SECURITY DEFINER function that returns
 * only the columns a login needs. It exists because this is the one query that
 * legitimately runs before a firm is known — and giving the application a
 * narrow, auditable exception is far better than giving its role the ability to
 * bypass row-level security in general.
 */
async function findByEmailForAuth(email) {
  const { rows } = await unscoped(
    `SELECT id, firm_id AS "firmId", email, password_hash AS "passwordHash",
            full_name AS "fullName", role, is_active AS "isActive"
       FROM attest_login_lookup($1)`,
    [email],
  );
  return rows[0] || null;
}

/**
 * Create a firm and its first user.
 *
 * The chicken-and-egg problem: row-level security requires app.current_firm_id
 * to be set, but the firm being inserted does not exist yet.
 *
 * The fix is to generate the firm's id in the application, declare it as the
 * current firm, and then insert a row with that id. Both policies are satisfied
 * honestly — the INSERT's WITH CHECK passes because the row genuinely belongs
 * to the firm we said we were acting as. No bypass, no elevated role, no
 * SECURITY DEFINER; registration runs under exactly the same isolation as every
 * other write in the system.
 */
async function createFirmWithFirstUser({ firmName, email, passwordHash, fullName }) {
  const firmId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_firm_id', firmId]);

    const { rows: firmRows } = await client.query(
      `INSERT INTO firms (id, name) VALUES ($1, $2)
       RETURNING id, name, created_at AS "createdAt"`,
      [firmId, firmName],
    );
    const firm = firmRows[0];

    // The first user of a firm is its admin by definition — there is nobody
    // else yet to grant the role.
    const { rows: userRows } = await client.query(
      `INSERT INTO users (firm_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'admin')
       RETURNING ${PUBLIC_COLUMNS}`,
      [firm.id, email, passwordHash, fullName],
    );

    await client.query('COMMIT');
    return { firm, user: userRows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function findById(client, id) {
  const { rows } = await client.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function listByFirm(client) {
  // No WHERE firm_id — row-level security applies it. Adding one would be
  // harmless but misleading: it would suggest the filter is what protects us.
  const { rows } = await client.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at`,
  );
  return rows;
}

async function recordLogin(client, userId) {
  await client.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
}

async function updatePasswordHash(client, userId, passwordHash) {
  await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
    passwordHash,
    userId,
  ]);
}

async function emailExists(email) {
  const { rows } = await unscoped(`SELECT id FROM attest_login_lookup($1)`, [email]);
  return rows.length > 0;
}

module.exports = {
  findByEmailForAuth,
  createFirmWithFirstUser,
  findById,
  listByFirm,
  recordLogin,
  updatePasswordHash,
  emailExists,
};
