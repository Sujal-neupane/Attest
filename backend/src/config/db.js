/**
 * Database access, and the single mechanism that makes tenant isolation real.
 *
 * ─── READ THIS BEFORE ADDING A QUERY ────────────────────────────────────────
 *
 * Postgres row-level security filters every tenant-scoped table against the
 * session variable `app.current_firm_id`. That variable is set HERE, from the
 * verified JWT, and nowhere else. A query that runs outside `withFirm()` has no
 * firm set, so the policies match nothing and it returns zero rows.
 *
 * That is the intended failure mode. Forgetting the tenant scope should produce
 * an empty result that someone notices immediately in development, not another
 * firm's client financials.
 *
 * `SET LOCAL` is used rather than `SET`, so the value is scoped to the
 * transaction and cannot leak to the next request that borrows this pooled
 * connection. Using plain `SET` here would be a cross-tenant data leak with a
 * long fuse: it would work perfectly under light load and start mixing firms
 * together exactly when the pool gets busy.
 */

const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // An idle client erroring out is a connectivity problem, not a request
  // problem; log it loudly rather than letting it take the process down.
  // eslint-disable-next-line no-console
  console.error('[db] idle client error', err);
});

/**
 * Run a function inside a transaction scoped to one firm.
 *
 * Everything that touches tenant data goes through here.
 *
 * @param {string} firmId  uuid, from the verified token — never from a request body
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withFirm(firmId, fn) {
  if (!firmId || !/^[0-9a-f-]{36}$/i.test(firmId)) {
    // Refusing a malformed id here rather than interpolating it is what stops
    // this function from being an injection point into a session variable.
    throw new Error(`withFirm called with an invalid firm id: ${JSON.stringify(firmId)}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Parameterised, and LOCAL so it dies with the transaction.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_firm_id', firmId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a query with NO firm scope.
 *
 * Deliberately named to be uncomfortable to type and to read in a diff. There
 * are exactly two legitimate uses: authenticating a user before we know which
 * firm they belong to, and registering a new firm. Anything else is a bug.
 */
async function unscoped(text, params) {
  return pool.query(text, params);
}

async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = { pool, withFirm, unscoped, healthcheck, close };
