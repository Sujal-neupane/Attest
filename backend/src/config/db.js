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
 * Refuse to serve unless row-level security actually applies to this connection.
 *
 * ─── WHY THIS CHECKS MORE THAN OWNERSHIP ────────────────────────────────────
 *
 * It used to check only whether the app connected as the table owner, because
 * `jobs` is RLS-enabled-but-not-forced and an owner would bypass its policy.
 * That was too narrow, and a real deployment proved it within minutes.
 *
 * Neon makes every role created through its console a member of
 * `neon_superuser`, which carries BYPASSRLS. Such a role owns nothing, so the
 * ownership check passed happily — while the role bypassed EVERY policy in the
 * database. Tenant isolation would have been completely off, every firm would
 * have seen every other firm's clients and documents, and nothing anywhere
 * would have looked wrong.
 *
 * The right question is not "does this role own the tables" but "can this role
 * bypass row-level security at all", by any route: the attribute directly, or
 * inherited through a role membership, or by owning a table whose policy is not
 * forced. All three are checked here, and any of them stops the process.
 *
 * A managed host handing you a privileged role by default is not an unusual
 * situation. It is the normal one.
 */
async function assertRowSecurityApplies() {
  let rows;
  try {
    ({ rows } = await pool.query(
    `WITH me AS (SELECT oid, rolname, rolsuper, rolbypassrls
                   FROM pg_roles WHERE rolname = current_user),
     inherited AS (
       SELECT g.rolname, g.rolbypassrls
         FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN me ON me.oid = m.member
        WHERE g.rolbypassrls OR g.rolsuper
     )
     SELECT me.rolname                                   AS role,
            me.rolsuper                                  AS is_superuser,
            me.rolbypassrls                              AS bypasses_rls,
            (SELECT string_agg(rolname, ', ') FROM inherited) AS via_membership,
            (SELECT pg_get_userbyid(c.relowner)
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'jobs') AS jobs_owner
       FROM me`));
  } catch (err) {
    // A connection failure is not a security verdict, and reporting it as one
    // is actively misleading: the deploy log read "Refusing to start: password
    // authentication failed", which looks like the guard rejected the role on
    // purpose rather than never having reached the database at all.
    throw new Error(
      `Could not connect to the database to check its security configuration.\n\n` +
        `  ${err.message}\n\n` +
        (err.code === '28P01'
          ? `The password in DATABASE_URL does not match the one the database has ` +
            `for that role. If migrations just created the role, DATABASE_URL must ` +
            `carry the same password as APP_DB_PASSWORD.`
          : `Check DATABASE_URL — host, database name, user and password.`),
      { cause: err },
    );
  }

  const row = rows[0];
  if (!row) return { checked: false };

  const problems = [];
  if (row.is_superuser) problems.push('it is a superuser');
  if (row.bypasses_rls) problems.push('it has the BYPASSRLS attribute');
  if (row.via_membership) {
    problems.push(`it is a member of ${row.via_membership}, which can bypass RLS`);
  }
  if (row.jobs_owner && row.jobs_owner === row.role) {
    problems.push('it owns the tables, so it bypasses the unforced policy on jobs');
  }

  if (problems.length > 0) {
    throw new Error(
      `Attest is connecting to Postgres as "${row.role}", and row-level security ` +
        `would NOT apply to it:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\n\nEvery firm would be able to read every other firm's data, and ` +
        `nothing would look wrong.\n\n` +
        `Create the application role with SQL rather than through a hosting ` +
        `console — a console-created role is often granted more than you asked ` +
        `for. Migration 002 creates a correct one; run migrations as the owner ` +
        `and point DATABASE_URL at attest_app.\n\nSee docs/DEPLOY.md.`,
    );
  }

  return { checked: true, role: row.role };
}

async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = { pool, withFirm, unscoped, healthcheck, assertRowSecurityApplies, close };
