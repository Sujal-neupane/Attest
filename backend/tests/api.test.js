/**
 * End-to-end API tests against a real database.
 *
 * These exercise the whole stack — HTTP, validation, auth, service, repository,
 * row-level security — because that is the only place the interesting failures
 * live. db/tests/rls.test.sql proves the policies work; these prove the
 * application actually goes through them.
 *
 * Skipped automatically when no database is reachable, so `npm test` still runs
 * clean on a machine with nothing set up.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/testDatabase');

const available = db.isAvailable();

// Setup runs at module scope, before anything under src/ is required:
// src/config/env.js validates on first require and exits if configuration is
// missing, so this cannot wait for a hook.
const fixture = available ? db.setup('attest_api_test', 'attest_test_api') : null;
if (available) db.applyTestEnv(fixture.url);

if (!available) {
  test('API tests skipped — no database reachable', () => {
    // Visible in the output rather than silently absent, so a green run cannot
    // quietly mean "these never executed".
    assert.ok(true);
  });
}

// Every test runs, or every test is skipped — never a silent partial run.
const run = available ? test : test.skip;

let server;
let base;

before(async () => {
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
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

run('registering a firm returns the firm, the user and a token pair', async () => {
  const { status, body } = await api('POST', '/auth/register', { body: firmA });
  assert.equal(status, 201);
  assert.equal(body.firm.name, firmA.firmName);
  assert.equal(body.user.role, 'admin', 'the first user of a firm is its admin');
  assert.ok(body.accessToken && body.refreshToken);
  assert.equal(body.user.passwordHash, undefined, 'a password hash must never be returned');
  tokenA = body.accessToken;
});

run('registering the same email twice is refused', async () => {
  const { status, body } = await api('POST', '/auth/register', { body: firmA });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'email_taken');
});

run('a short password is rejected with a message that says why', async () => {
  const { status, body } = await api('POST', '/auth/register', {
    body: { ...firmB, email: 'x@example.com', password: 'short' },
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'validation_failed');
  assert.match(body.error.fields[0].message, /at least 12 characters/);
});

run('signing in returns a working token', async () => {
  const { status, body } = await api('POST', '/auth/login', {
    body: { email: firmA.email, password: firmA.password },
  });
  assert.equal(status, 200);
  assert.ok(body.accessToken);
  tokenA = body.accessToken;
});

run('a wrong password and an unknown address give the same answer', async () => {
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

run('protected routes reject a missing or malformed token', async () => {
  assert.equal((await api('GET', '/clients')).status, 401);
  assert.equal((await api('GET', '/clients', { token: 'garbage' })).status, 401);
});

run('a refresh token is not accepted as an access token', async () => {
  const { body } = await api('POST', '/auth/login', {
    body: { email: firmA.email, password: firmA.password },
  });
  const { status } = await api('GET', '/clients', { token: body.refreshToken });
  assert.equal(status, 401, 'a refresh token must not authorise a request');
});

run('creating and listing a client works', async () => {
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

run('a malformed PAN is rejected before it reaches the database', async () => {
  const { status, body } = await api('POST', '/clients', {
    token: tokenA,
    body: { name: 'Bad PAN Ltd', pan: '12345' },
  });
  assert.equal(status, 400);
  assert.match(body.error.fields[0].message, /nine digits/);
});

run('a fiscal period can be created', async () => {
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

run('a period can be created from a Bikram Sambat month alone', async () => {
  const second = await api('POST', '/clients', {
    token: tokenA,
    body: { name: 'Everest Retail Pvt Ltd' },
  });
  const { status, body } = await api('POST', `/clients/${second.body.id}/periods`, {
    token: tokenA,
    body: { bsYear: 2081, bsMonth: 4 },
  });
  assert.equal(status, 201);
  assert.equal(body.label, 'Shrawan 2081');
  assert.equal(body.startDate, '2024-07-16', 'a DATE must survive the round trip unshifted');
});

run('a period can be created from a Nepali fiscal year alone', async () => {
  const third = await api('POST', '/clients', {
    token: tokenA,
    body: { name: 'Gurung Hardware' },
  });
  const { status, body } = await api('POST', `/clients/${third.body.id}/periods`, {
    token: tokenA,
    body: { bsYear: 2081 },
  });
  assert.equal(status, 201);
  assert.equal(body.label, 'FY 2081-82');
  assert.equal(body.startDate, '2024-07-16');
  assert.equal(body.endDate, '2025-07-16', 'FY 2081-82 ends on the last day of Ashadh 2082');
});

run('a BS year beyond the verified calendar is refused with an explanation', async () => {
  const fourth = await api('POST', '/clients', {
    token: tokenA,
    body: { name: 'Far Future Ltd' },
  });
  const { status, body } = await api('POST', `/clients/${fourth.body.id}/periods`, {
    token: tokenA,
    body: { bsYear: 2099 },
  });
  assert.equal(status, 422);
  assert.match(body.error.message, /outside the range/);
});

run('an overlapping period is refused, because it would double-count', async () => {
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

run('a second firm cannot see the first firm\'s clients', async () => {
  const registered = await api('POST', '/auth/register', { body: firmB });
  assert.equal(registered.status, 201);
  tokenB = registered.body.accessToken;

  const listed = await api('GET', '/clients', { token: tokenB });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, [], "firm B must see none of firm A's clients");
});

run('a second firm cannot fetch the first firm\'s client by its id', async () => {
  // The id is guessed correctly here — this is the case where application
  // code passes an id straight from a URL without re-checking ownership.
  const { status, body } = await api('GET', `/clients/${clientAId}`, { token: tokenB });
  assert.equal(status, 404, 'row-level security must make it invisible, not merely forbidden');
  assert.equal(body.error.code, 'not_found');
});

run('a second firm cannot add a period to the first firm\'s client', async () => {
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

run('every action was written to the audit trail', async () => {
  const rows = fixture.psql(['-tA', '-c', `SELECT action FROM audit_log ORDER BY created_at`]);
  const actions = rows.trim().split('\n');
  assert.ok(actions.includes('register'), 'registration must be audited');
  assert.ok(actions.includes('login'), 'sign-in must be audited');
  assert.ok(actions.includes('create_client'), 'creating a client must be audited');
  assert.ok(actions.includes('create_period'), 'creating a period must be audited');
});

run('health reports the database', async () => {
  const { status, body } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.database, 'ok');
});

run('an unknown route returns a useful 404', async () => {
  const { status, body } = await api('GET', '/nope');
  assert.equal(status, 404);
  assert.match(body.error.message, /No route for GET/);
});
