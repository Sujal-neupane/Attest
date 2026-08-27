/**
 * Shared setup for tests that need a real database.
 *
 * Runs synchronously at module load, so callers can set process.env.DATABASE_URL
 * before anything under src/ is required — src/config/env.js validates on first
 * require and exits the process if configuration is missing, which makes setting
 * it inside a hook depend on hook ordering.
 *
 * ─── WHY EACH TEST FILE GETS ITS OWN ROLE ───────────────────────────────────
 *
 * Every DB test file used to run `ALTER ROLE attest_app PASSWORD ...` during its
 * own setup. pg_authid is cluster-wide, so two test files running concurrently
 * updated the same catalog row and Postgres refused one of them with
 * "tuple concurrently updated". The result was a suite that failed perhaps one
 * run in three, on something entirely unrelated to what it was testing.
 *
 * Now each file creates its own login role and grants it membership of
 * attest_app, inheriting exactly the privileges the real application has —
 * SELECT/INSERT/UPDATE, no DELETE, and crucially NOBYPASSRLS. Different rows in
 * pg_authid, no contention, and the tests still run as something that cannot
 * bypass row-level security. Testing as a superuser would make every isolation
 * assertion pass for the wrong reason.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const LOCK_PATH = path.join(os.tmpdir(), 'attest-test-setup.lock');

/**
 * Serialise setup across test FILES, which are separate processes.
 *
 * Postgres advisory locks cannot do this job: their lock tag includes the
 * database oid, and each suite sets up its own database, so they never contend.
 * Roles, meanwhile, live in cluster-wide pg_authid — so three suites bootstrap-
 * ping in parallel really do collide, and the symptom is "tuple concurrently
 * updated" raised against whichever migration lost, which looks like a bug in
 * the migration rather than in the harness.
 *
 * An exclusive-create lockfile is atomic and works across processes. The stale
 * check matters: a suite killed mid-setup would otherwise wedge every later run.
 */
function withSetupLock(fn) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale;
      try {
        stale = Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 60_000;
      } catch {
        // Vanished between the open and the stat; just retry.
        continue;
      }
      if (stale) {
        try { fs.unlinkSync(LOCK_PATH); } catch { /* another process won */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${LOCK_PATH}. Delete it if no test run is active.`, {
          cause: err,
        });
      }
      // execFileSync is synchronous, so this must busy-wait rather than await.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

const HOST = process.env.PGHOST || '/tmp/attest-pg';
const PORT = process.env.PGPORT || '55432';
const SUPERUSER = process.env.PGUSER || 'postgres';
const MIGRATIONS = path.join(__dirname, '../../db/migrations');

function psql(database, args) {
  return execFileSync('psql', ['-h', HOST, '-p', PORT, '-U', SUPERUSER, '-d', database, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

/** Is a database reachable at all? Tests skip rather than fail when not. */
function isAvailable() {
  try {
    psql('postgres', ['-c', 'select 1']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a fresh database, apply every migration, and return a connection URL
 * for a role that behaves exactly like the application's.
 *
 * @param {string} dbName    unique per test file
 * @param {string} roleName  unique per test file
 */
function setup(dbName, roleName) {
  return withSetupLock(() => setupUnlocked(dbName, roleName));
}

function setupUnlocked(dbName, roleName) {
  const password = `${roleName}_pw`;

  psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${dbName}`, '-c', `CREATE DATABASE ${dbName}`]);

  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    psql(dbName, ['-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(MIGRATIONS, file)]);
  }

  // Membership of attest_app rather than a copy of its grants, so a privilege
  // added to the application role in a later migration is picked up by the
  // tests automatically instead of drifting away from it.
  // One statement, one transaction, one advisory lock — and deliberately the
  // SAME lock key migration 002 uses. Granting membership of attest_app writes
  // the same cluster-wide catalog the migration's ALTER ROLE does, so two
  // different keys would serialise each side against itself and not against
  // the other, which is exactly the race that was left.
  psql(dbName, [
    '-q',
    '-v', 'ON_ERROR_STOP=1',
    '-c',
    `BEGIN;
     SELECT pg_advisory_xact_lock(hashtext('attest:app_role'));
     DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
         CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
       END IF;
     END $$;
     GRANT attest_app TO ${roleName};
     COMMIT;`,
  ]);

  const url = HOST.startsWith('/')
    ? `postgres://${roleName}:${password}@/${dbName}?host=${HOST}&port=${PORT}`
    : `postgres://${roleName}:${password}@${HOST}:${PORT}/${dbName}`;

  return { url, dbName, roleName, password, psql: (args) => psql(dbName, args) };
}

/** Test-only environment. Secrets are fixed values; nothing here reaches a real deployment. */
function applyTestEnv(databaseUrl) {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-xx';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-different-xx';
  process.env.LOG_LEVEL = 'fatal';
}

module.exports = { isAvailable, setup, applyTestEnv, HOST, PORT };
