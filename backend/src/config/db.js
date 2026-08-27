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

const { Pool, types } = require('pg');
const env = require('./env');
const { sslFor } = require('./pgSsl');

/**
 * Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date objects.
 *
 * A calendar date has no time and no timezone. node-pg's default is to parse
 * DATE into a Date at LOCAL midnight, and serialising that back through
 * toISOString() shifts it to the previous day in any timezone ahead of UTC —
 * which includes Nepal, at +05:45. Shrawan 1, 2081 went into the database as
 * 2024-07-16 and came back out of the API as 2024-07-15.
 *
 * That is the exact class of bug this product exists to prevent: a date silently
 * moved across a period boundary, with nothing on screen looking wrong. Fixed
 * once, here, at the driver, rather than by remembering to format defensively at
 * every call site.
 *
 * 1082 is the OID for DATE.
 */
types.setTypeParser(1082, (value) => value);

/**
 * Return BIGINT columns as numbers, not strings.
 *
 * node-pg's default is a string, because a Postgres bigint can exceed
 * Number.MAX_SAFE_INTEGER. That default is disastrous here: every monetary
 * amount is a bigint of paisa, so `amount_paisa` came back as '-1130000' and
 * arithmetic on it silently became string concatenation — a sum of two
 * payments producing '-1130000-565000' rather than a figure. It does not throw.
 * It produces a wrong number that looks like a number.
 *
 * Converting is safe for this schema because paisa amounts, page counts and
 * audit ids are all far inside the safe-integer range — but "safe because of
 * how we use it" is exactly the reasoning that rots, so the guard is explicit
 * rather than assumed. If a value ever does exceed the safe range, this throws
 * loudly at the boundary instead of quietly losing precision somewhere later.
 *
 * 20 is the OID for INT8/BIGINT.
 */
types.setTypeParser(20, (value) => {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `Refusing to read bigint ${value} as a JavaScript number: it is outside ` +
        `the safe integer range and converting would silently lose precision.`,
    );
  }
  return parsed;
});

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Declared, never inferred from the hostname — see pgSsl.js for the outage
  // that taught that lesson.
  ssl: sslFor({ databaseUrl: env.DATABASE_URL, nodeEnv: env.NODE_ENV }),
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // An idle client erroring out is a connectivity problem, not a request
  // problem; log it loudly rather than letting it take the process down.
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

/**
 * Refuse to serve if the application is connecting as the database owner.
 *
 * `jobs` is deliberately RLS-enabled-but-not-forced so the SECURITY DEFINER
 * claim function can see the queue across firms (see migration 005). That is
 * safe precisely because the app connects as a role that owns nothing — the
 * policy applies to it in full.
 *
 * Connect as the owner instead and the same line becomes a cross-tenant leak:
 * every firm would see every firm's jobs, and nothing would look wrong. It is a
 * one-line mistake in a dashboard, and it is exactly the kind that a managed
 * host encourages by handing you a single owner connection string.
 *
 * So it is checked at startup, and the process refuses rather than serving.
 */
async function assertNotTableOwner() {
  const { rows } = await pool.query(
    `SELECT current_user AS role,
            pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'jobs'`,
  );

  const row = rows[0];
  if (!row) return { checked: false };

  if (row.role === row.owner) {
    throw new Error(
      `Attest is connecting to Postgres as "${row.role}", which owns its tables.\n\n` +
        `That role bypasses the row-level security policy on the jobs table, so ` +
        `every firm would be able to see every other firm's jobs.\n\n` +
        `Run migrations as the owner, but point DATABASE_URL at the restricted ` +
        `role instead:\n` +
        `  MIGRATION_DATABASE_URL=<owner connection string>\n` +
        `  DATABASE_URL=<same host/database, user attest_app>\n\n` +
        `See docs/DEPLOY.md.`,
    );
  }

  return { checked: true, role: row.role, owner: row.owner };
}

async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = { pool, withFirm, unscoped, healthcheck, assertNotTableOwner, close };
