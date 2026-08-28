/**
 * The startup guard that refuses to serve when row-level security would not
 * apply to the connection.
 *
 * This exists because of a real deployment. Neon makes every role created
 * through its console a member of `neon_superuser`, which carries BYPASSRLS —
 * so a role that owns nothing, and looks entirely ordinary, silently bypasses
 * every policy in the schema. The original guard checked only for table
 * ownership and let it straight through.
 *
 * Had that shipped, every firm would have read every other firm's clients and
 * documents, and nothing would have looked wrong at any point.
 *
 * These tests use a real Postgres because role attributes and inheritance are
 * the thing under test, and there is nothing to check without them.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const testDb = require('./helpers/testDatabase');

const available = testDb.isAvailable();
const fixture = available ? testDb.setup('attest_guard_test', 'attest_test_guard') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('RLS guard tests skipped — no database reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

const HOST = process.env.PGHOST || '/tmp/attest-pg';
const PORT = process.env.PGPORT || '55432';
const SUFFIX = crypto.randomUUID().slice(0, 8).replace(/-/g, '');

/** Roles the tests create, each representing one way privilege leaks in. */
const ROLES = {
  clean: `guard_clean_${SUFFIX}`,
  bypass: `guard_bypass_${SUFFIX}`,
  inheriting: `guard_inherits_${SUFFIX}`,
  privileged: `guard_privileged_${SUFFIX}`,
};

const psql = (database, sql) =>
  execFileSync('psql', ['-h', HOST, '-p', PORT, '-U', 'postgres', '-d', database, '-q', '-c', sql], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

before(() => {
  if (!available) return;

  psql('postgres', `CREATE ROLE ${ROLES.clean} LOGIN PASSWORD 'pw' NOBYPASSRLS`);
  // The Neon shape: BYPASSRLS directly on the role.
  psql('postgres', `CREATE ROLE ${ROLES.bypass} LOGIN PASSWORD 'pw' BYPASSRLS`);
  // The subtler Neon shape: clean on its own, privileged through a membership.
  psql('postgres', `CREATE ROLE ${ROLES.privileged} BYPASSRLS`);
  psql('postgres', `CREATE ROLE ${ROLES.inheriting} LOGIN PASSWORD 'pw' NOBYPASSRLS`);
  psql('postgres', `GRANT ${ROLES.privileged} TO ${ROLES.inheriting}`);

  for (const role of Object.values(ROLES)) {
    psql('attest_guard_test', `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    psql('attest_guard_test', `GRANT USAGE ON SCHEMA public TO ${role}`);
  }
});

after(() => {
  if (!available) return;
  for (const role of [ROLES.inheriting, ROLES.clean, ROLES.bypass, ROLES.privileged]) {
    try {
      psql('attest_guard_test', `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
      psql('attest_guard_test', `REVOKE USAGE ON SCHEMA public FROM ${role}`);
      psql('postgres', `DROP ROLE ${role}`);
    } catch {
      // Best effort — a leftover test role is noise, not a failure.
    }
  }
});

/**
 * Load a fresh copy of config/db pointed at one role.
 *
 * The module memoises its pool, so each case needs its own module registry
 * entry rather than a shared one.
 */
async function guardFor(role) {
  const url = HOST.startsWith('/')
    ? `postgres://${role}:pw@/attest_guard_test?host=${HOST}&port=${PORT}`
    : `postgres://${role}:pw@${HOST}:${PORT}/attest_guard_test`;

  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;

  delete require.cache[require.resolve('../src/config/db')];
  delete require.cache[require.resolve('../src/config/env')];

  const db = require('../src/config/db');
  try {
    return { result: await db.assertRowSecurityApplies(), error: null, db };
  } catch (error) {
    return { result: null, error, db };
  } finally {
    process.env.DATABASE_URL = previous;
    await db.close().catch(() => {});
    delete require.cache[require.resolve('../src/config/db')];
    delete require.cache[require.resolve('../src/config/env')];
  }
}

run('a role that row-level security applies to is accepted', async () => {
  const { result, error } = await guardFor(ROLES.clean);
  assert.equal(error, null, error?.message);
  assert.equal(result.checked, true);
});

run('A ROLE WITH BYPASSRLS IS REFUSED', async () => {
  // The exact shape Neon hands you from its console.
  const { error } = await guardFor(ROLES.bypass);

  assert.ok(error, 'the process must not start');
  assert.match(error.message, /BYPASSRLS attribute/);
  assert.match(error.message, /read every other firm's data/);
});

run('a role that inherits the privilege through a membership is refused', async () => {
  // The one the ownership check could never have caught: the role itself is
  // clean, and it is a member of something that is not.
  const { error } = await guardFor(ROLES.inheriting);

  assert.ok(error, 'inherited privilege must be caught too');
  assert.match(error.message, /member of/);
  assert.match(error.message, new RegExp(ROLES.privileged));
});

run('the refusal says how to fix it, not just that it is wrong', async () => {
  const { error } = await guardFor(ROLES.bypass);

  // Someone hits this at deploy time, in a dashboard, under pressure.
  assert.match(error.message, /Delete attest_app|created? .*with SQL|hosting\s+console/);
  assert.match(error.message, /docs\/DEPLOY\.md/);
});
