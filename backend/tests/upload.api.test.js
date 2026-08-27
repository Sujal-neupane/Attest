/**
 * The upload path over real HTTP.
 *
 * pipeline.test.js drives the services directly; this drives the same journey
 * the frontend will — multipart upload, poll for status, read the transactions,
 * follow a signed link back to the source. The seam between Express and the
 * services is exactly where a service that works in isolation stops working.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDb = require('./helpers/testDatabase');

const available = testDb.isAvailable();
const fixture = available ? testDb.setup('attest_upload_test', 'attest_test_upload') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('upload API tests skipped — no database reachable', () => assert.ok(true));
}

const run = available ? test : test.skip;

const STATEMENT = [
  'Date,Narration,Withdrawl,Deposit,Balance',
  '16/07/2024,OPENING BALANCE,,,"1,00,000.00"',
  '17/07/2024,"TRF TO SHARMA TRADERS, LALITPUR","11,300.00",,"88,700.00"',
  '18/07/2024,IPS/FT FROM EVEREST RETAIL,,"22,600.00","1,11,300.00"',
].join('\n');

let server;
let base;
let db;
let storeRoot;
let token;
let periodId;
let worker;
let store;

before(async () => {
  db = require('../src/config/db');
  const storage = require('../src/services/storage');
  const storageConfig = require('../src/config/storage');
  worker = require('../src/workers/parseDocument');

  // A temp store, injected so the suite never writes to the real uploads dir.
  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-upload-'));
  store = storage.createLocalStorage({ root: storeRoot, key: crypto.randomBytes(32) });
  storageConfig.override({ store, signer: storage.createSigner('upload-test-secret'), root: storeRoot });

  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;

  const registered = await json('POST', '/auth/register', {
    body: {
      firmName: 'Upload Test Firm',
      fullName: 'Sujal Neupane',
      email: 'upload@example.com',
      password: 'a-sufficiently-long-password',
    },
  });
  token = registered.body.accessToken;

  const client = await json('POST', '/clients', {
    token,
    body: { name: 'Himalayan Traders Pvt Ltd', pan: '123456789' },
  });
  const period = await json('POST', `/clients/${client.body.id}/periods`, {
    token,
    body: { bsYear: 2081, bsMonth: 4 },
  });
  periodId = period.body.id;
});

after(async () => {
  server?.close();
  await db?.close().catch(() => {});
  if (storeRoot) fs.rmSync(storeRoot, { recursive: true, force: true });
});

async function json(method, url, { body, token: bearer } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * Run the worker until the queue is empty.
 *
 * Earlier tests in this file leave their own jobs queued, so a single
 * runOnce() would claim whichever job happens to be oldest rather than the one
 * the test just created — which made this suite depend on the order its tests
 * were written in.
 */
async function drainQueue(limit = 20) {
  const outcomes = [];
  for (let i = 0; i < limit; i++) {
    const outcome = await worker.runOnce({ store, logger: {} });
    if (outcome === null) return outcomes;
    outcomes.push(outcome);
  }
  throw new Error(`Queue still had jobs after ${limit} passes — something is requeueing.`);
}

async function uploadFile(contents, { filename = 'statement.csv', type = 'bank_statement', bearer = null } = {}) {
  const form = new FormData();
  form.append('file', new Blob([contents], { type: 'text/csv' }), filename);
  form.append('type', type);

  const res = await fetch(`${base}/periods/${periodId}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer ?? token}` },
    body: form,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

run('uploading a statement returns 202, not 201', async () => {
  const { status, body } = await uploadFile(STATEMENT);

  // 202 Accepted: the document exists but its transactions do not yet. Saying
  // "created" would imply the parse had already happened.
  assert.equal(status, 202, JSON.stringify(body));
  assert.equal(body.status, 'uploaded');
  assert.ok(body.jobId, 'a parse job must have been queued');
  assert.equal(body.filename, 'statement.csv');
});

run('the period reports work still pending before the worker runs', async () => {
  const { body } = await json('GET', `/periods/${periodId}/status`, { token });
  assert.equal(body.documents, 1);
  assert.equal(body.pending, 1);
  assert.equal(body.ready, false);
  assert.equal(body.transactionCount, 0);
});

run('after the worker runs, the period reports ready with its transactions', async () => {
  const [outcome] = await drainQueue();
  assert.equal(outcome.ok, true, outcome.error?.message);

  const { body } = await json('GET', `/periods/${periodId}/status`, { token });
  assert.equal(body.pending, 0);
  assert.equal(body.ready, true);
  assert.equal(body.transactionCount, 2, 'the opening-balance row has no amount');
  assert.deepEqual(body.failed, []);
});

run('the parsed transactions come back as money, not as strings', async () => {
  const { body } = await json('GET', `/periods/${periodId}/transactions`, { token });
  assert.equal(body.length, 2);

  const payment = body.find((t) => t.party?.startsWith('SHARMA'));
  // A bigint arriving as a string would make every downstream sum string
  // concatenation, so the type is asserted, not just the value.
  assert.equal(typeof payment.amountPaisa, 'number');
  assert.equal(payment.amountPaisa, -1_130_000);
  assert.equal(payment.txnDate, '2024-07-17');
  assert.equal(payment.documentFilename, 'statement.csv');
});

run('a truncated transaction list says so in its headers', async () => {
  const res = await fetch(`${base}/periods/${periodId}/transactions?limit=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = await res.json();

  assert.equal(rows.length, 1);
  assert.equal(res.headers.get('x-total-count'), '2', 'the real size must be reported');
  assert.equal(res.headers.get('x-returned-count'), '1');
  assert.equal(res.headers.get('x-truncated'), 'true');
});

run('an untruncated list is not marked truncated', async () => {
  const res = await fetch(`${base}/periods/${periodId}/transactions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await res.json();
  assert.equal(res.headers.get('x-truncated'), null);
});

run('every transaction can be traced back to the line it came from', async () => {
  const { body } = await json('GET', `/periods/${periodId}/transactions`, { token });
  for (const txn of body) {
    assert.ok(Number.isInteger(txn.sourceRef.row));
    assert.ok(txn.sourceRef.raw?.date, 'the original text must be kept verbatim');
  }
});

run('a signed link returns the original file, and expires', async () => {
  const { body: docs } = await json('GET', `/periods/${periodId}/documents`, { token });
  const document = docs[0];

  const { body: link } = await json('GET', `/documents/${document.id}/source-url`, { token });
  assert.ok(link.url.includes('token='));
  assert.ok(new Date(link.expiresAt) > new Date(), 'the link must not arrive already expired');

  const res = await fetch(`${base.replace('/api', '')}${link.url}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  // A client's financial document must never be cached by a proxy or browser.
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(await res.text(), STATEMENT);
});

run('the source link still requires being signed in', async () => {
  const { body: docs } = await json('GET', `/periods/${periodId}/documents`, { token });
  const { body: link } = await json('GET', `/documents/${docs[0].id}/source-url`, { token });

  // A signed link scopes access to one document for a few minutes. It is not a
  // substitute for authentication — a leaked link must not expose a bank
  // statement to whoever received it.
  const res = await fetch(`${base.replace('/api', '')}${link.url}`);
  assert.equal(res.status, 401);
});

run('a tampered token is refused', async () => {
  const { body: docs } = await json('GET', `/periods/${periodId}/documents`, { token });
  const res = await fetch(
    `${base}/documents/${docs[0].id}/content?token=9999999999.deadbeef`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(res.status, 403);
});

run('re-uploading the identical file is refused', async () => {
  const { status, body } = await uploadFile(STATEMENT);
  assert.equal(status, 409);
  assert.equal(body.error.code, 'duplicate_document');
  assert.match(body.error.message, /double every transaction/);
});

run('a request with no file attached says what to send', async () => {
  const res = await fetch(`${base}/periods/${periodId}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: new FormData(),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'missing_file');
  assert.match(body.error.detail, /multipart\/form-data/);
});

run('an unsupported document type is rejected with the accepted list', async () => {
  const { status, body } = await uploadFile(STATEMENT, { type: 'tax_return' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'validation_failed');
});

run('a hostile filename is stripped of path components before storage', async () => {
  const { status, body } = await uploadFile('Date,Amount\n16/07/2024,500\n', {
    filename: '../../../etc/passwd',
  });
  assert.equal(status, 202, JSON.stringify(body));
  assert.equal(body.filename, 'passwd', 'path components must not survive');
  assert.ok(!body.storageKey.includes('..'), 'and must never reach the storage key');
});

run('uploading requires authentication', async () => {
  const res = await fetch(`${base}/periods/${periodId}/documents`, {
    method: 'POST',
    body: new FormData(),
  });
  assert.equal(res.status, 401);
});

run("a document belonging to another firm is invisible, not merely forbidden", async () => {
  const stranger = await json('POST', '/auth/register', {
    body: {
      firmName: 'Rival Accountants',
      fullName: 'Someone Else',
      email: 'rival-upload@example.com',
      password: 'another-sufficiently-long-pw',
    },
  });

  const { body: docs } = await json('GET', `/periods/${periodId}/documents`, { token });
  const mine = docs[0].id;

  const seen = await json('GET', `/documents/${mine}`, { token: stranger.body.accessToken });
  assert.equal(seen.status, 404);

  const theirPeriod = await json('GET', `/periods/${periodId}/transactions`, {
    token: stranger.body.accessToken,
  });
  assert.deepEqual(theirPeriod.body, [], "another firm's transactions must not be readable");
});

run('a failed parse surfaces its reason in the period status', async () => {
  const { body: uploaded } = await uploadFile('Date,Narration,Reference\n16/07/2024,PAYMENT,X1\n', {
    filename: 'no-amount.csv',
  });

  const outcomes = await drainQueue();
  const failure = outcomes.find((o) => !o.ok);
  assert.ok(failure, 'the unparseable document should have failed');
  assert.equal(failure.permanent, true, 'a missing column will not fix itself on retry');

  const { body } = await json('GET', `/periods/${periodId}/status`, { token });
  const surfaced = body.failed.find((f) => f.id === uploaded.id);
  assert.ok(surfaced, 'a failed document must be surfaced without having to go looking');
  assert.match(surfaced.reason, /no column that reads as amount/);
  assert.equal(body.ready, true, 'a failed document is finished, not pending');
});
