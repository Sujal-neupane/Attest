/**
 * End-to-end API tests against a real database.
 *
 * These exercise the whole stack — HTTP, validation, auth, service,
 * repository, row-level security — because that is the only place the
 * interesting failures live. The isolation tests in db/tests/rls.test.sql prove
 * the policies work; these prove the application actually goes through them.
 *
 * Skipped automatically when no database is reachable, so `npm test` still runs
 * clean on a machine with nothing set up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SOCKET = process.env.PGHOST || '/tmp/attest-pg';
const PORT = process.env.PGPORT || '55432';
const DB_NAME = 'attest_api_test';
// Connects as attest_app, NOT as postgres. A superuser bypasses row-level
// security entirely, so testing the API as one would prove nothing about
// tenant isolation — which is exactly the bug these tests caught.
const DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  `postgres://attest_app@/${DB_NAME}?host=${SOCKET}&port=${PORT}`;

function psql(args, opts = {}) {
  return execFileSync('psql', args, { encoding: 'utf8', stdio: 'pipe', ...opts });
}

let available = true;
try {
  psql(['-h', SOCKET, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', 'select 1']);
} catch {
  available = false;
}

const describe = available ? test.describe : test.describe.skip;

if (!available) {
  test('API tests skipped — no database reachable', () => {
    // Visible in the output rather than silently absent, so a green run on CI
    // cannot quietly mean "these never executed".
    assert.ok(true);
  });
}

describe('API', async () => {
  let server;
  let base;

  test.before(async () => {
    psql(['-h', SOCKET, '-p', PORT, '-U', 'postgres', '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`,
      '-c', `CREATE DATABASE ${DB_NAME}`]);
    psql(['-h', SOCKET, '-p', PORT, '-U', 'postgres', '-d', DB_NAME, '-q',
      '-v', 'ON_ERROR_STOP=1',
      '-f', path.join(__dirname, '../db/migrations/001_initial_schema.sql')]);
    psql(['-h', SOCKET, '-p', PORT, '-U', 'postgres', '-d', DB_NAME, '-q',
      '-v', 'ON_ERROR_STOP=1',
      '-f', path.join(__dirname, '../db/migrations/002_app_role.sql')]);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-xx';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-different-xx';
    process.env.LOG_LEVEL = 'fatal';

    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  test.after(async () => {
    server?.close();
    await require('../src/config/db').close().catch(() => {});
  });

  const api = async (method, url, { body, token } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const firmA = {
    firmName: 'Neupane & Associates',
    fullName: 'Sujal Neupane',
    email: 'sujal@example.com',
    password: 'a-sufficiently-long-password',
  };
  const firmB = {
    firmName: 'Rival Chartered Accountants',
    fullName: 'Someone Else',
    email: 'rival@example.com',
    password: 'another-sufficiently-long-pw',
  };

  let tokenA;
  let tokenB;
  let clientAId;

  await test('registering a firm returns the firm, the user and a token pair', async () => {
    const { status, body } = await api('POST', '/auth/register', { body: firmA });
    assert.equal(status, 201);
    assert.equal(body.firm.name, firmA.firmName);
    assert.equal(body.user.role, 'admin', 'the first user of a firm is its admin');
    assert.ok(body.accessToken && body.refreshToken);
    assert.equal(body.user.passwordHash, undefined, 'a password hash must never be returned');
    tokenA = body.accessToken;
  });

  await test('registering the same email twice is refused', async () => {
    const { status, body } = await api('POST', '/auth/register', { body: firmA });
    assert.equal(status, 409);
    assert.equal(body.error.code, 'email_taken');
  });

  await test('a short password is rejected with a message that says why', async () => {
    const { status, body } = await api('POST', '/auth/register', {
      body: { ...firmB, email: 'x@example.com', password: 'short' },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_failed');
    assert.match(body.error.fields[0].message, /at least 12 characters/);
  });

  await test('signing in returns a working token', async () => {
    const { status, body } = await api('POST', '/auth/login', {
      body: { email: firmA.email, password: firmA.password },
    });
    assert.equal(status, 200);
    assert.ok(body.accessToken);
    tokenA = body.accessToken;
  });

  await test('a wrong password and an unknown address give the same answer', async () => {
    const wrongPassword = await api('POST', '/auth/login', {
      body: { email: firmA.email, password: 'not-the-right-password' },
    });
    const unknownUser = await api('POST', '/auth/login', {
      body: { email: 'nobody@example.com', password: 'not-the-right-password' },
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(
      wrongPassword.body.error.message,
      unknownUser.body.error.message,
      'the response must not reveal whether an account exists',
    );
  });

  await test('protected routes reject a missing or malformed token', async () => {
    assert.equal((await api('GET', '/clients')).status, 401);
    assert.equal((await api('GET', '/clients', { token: 'garbage' })).status, 401);
  });

  await test('a refresh token is not accepted as an access token', async () => {
    const { body } = await api('POST', '/auth/login', {
      body: { email: firmA.email, password: firmA.password },
    });
    const { status } = await api('GET', '/clients', { token: body.refreshToken });
    assert.equal(status, 401, 'a refresh token must not authorise a request');
  });

  await test('creating and listing a client works', async () => {
    const created = await api('POST', '/clients', {
      token: tokenA,
      body: { name: 'Himalayan Traders Pvt Ltd', pan: '123456789' },
    });
    assert.equal(created.status, 201);
    clientAId = created.body.id;

    const listed = await api('GET', '/clients', { token: tokenA });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].name, 'Himalayan Traders Pvt Ltd');
  });

  await test('a malformed PAN is rejected before it reaches the database', async () => {
    const { status, body } = await api('POST', '/clients', {
      token: tokenA,
      body: { name: 'Bad PAN Ltd', pan: '12345' },
    });
    assert.equal(status, 400);
    assert.match(body.error.fields[0].message, /nine digits/);
  });

  await test('a fiscal period can be created', async () => {
    const { status, body } = await api('POST', `/clients/${clientAId}/periods`, {
      token: tokenA,
      body: {
        label: 'FY 2081-82, Shrawan',
        bsYear: 2081,
        bsMonth: 4,
        startDate: '2024-07-16',
        endDate: '2024-08-16',
      },
    });
    assert.equal(status, 201);
    assert.equal(body.label, 'FY 2081-82, Shrawan');
  });

  await test('an overlapping period is refused, because it would double-count', async () => {
    const { status, body } = await api('POST', `/clients/${clientAId}/periods`, {
      token: tokenA,
      body: {
        label: 'Overlapping',
        bsYear: 2081,
        startDate: '2024-08-01',
        endDate: '2024-09-01',
      },
    });
    assert.equal(status, 409);
    assert.equal(body.error.code, 'period_overlap');
    assert.match(body.error.message, /counted in two returns/);
  });

  // ---- The one that matters -----------------------------------------------

  await test('a second firm cannot see the first firm\'s clients', async () => {
    const registered = await api('POST', '/auth/register', { body: firmB });
    assert.equal(registered.status, 201);
    tokenB = registered.body.accessToken;

    const listed = await api('GET', '/clients', { token: tokenB });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [], "firm B must see none of firm A's clients");
  });

  await test('a second firm cannot fetch the first firm\'s client by its id', async () => {
    // The id is guessed correctly here — this is the case where application
    // code passes an id straight from a URL without re-checking ownership.
    const { status, body } = await api('GET', `/clients/${clientAId}`, { token: tokenB });
    assert.equal(status, 404, 'row-level security must make it invisible, not merely forbidden');
    assert.equal(body.error.code, 'not_found');
  });

  await test('a second firm cannot add a period to the first firm\'s client', async () => {
    const { status } = await api('POST', `/clients/${clientAId}/periods`, {
      token: tokenB,
      body: {
        label: 'Smuggled In',
        bsYear: 2081,
        startDate: '2025-01-01',
        endDate: '2025-01-31',
      },
    });
    assert.equal(status, 404);
  });

  await test('every action was written to the audit trail', async () => {
    const rows = psql(['-h', SOCKET, '-p', PORT, '-U', 'postgres', '-d', DB_NAME, '-tA',
      '-c', `SELECT action FROM audit_log ORDER BY created_at`]);
    const actions = rows.trim().split('\n');
    assert.ok(actions.includes('register'), 'registration must be audited');
    assert.ok(actions.includes('login'), 'sign-in must be audited');
    assert.ok(actions.includes('create_client'), 'creating a client must be audited');
    assert.ok(actions.includes('create_period'), 'creating a period must be audited');
  });

  await test('health reports the database', async () => {
    const { status, body } = await api('GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.database, 'ok');
  });

  await test('an unknown route returns a useful 404', async () => {
    const { status, body } = await api('GET', '/nope');
    assert.equal(status, 404);
    assert.match(body.error.message, /No route for GET/);
  });
});
