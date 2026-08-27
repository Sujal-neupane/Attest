/**
 * Queue tests against a real database.
 *
 * SKIP LOCKED, row locks and the claim function are Postgres behaviour; there is
 * nothing to test without Postgres, and a mock would only assert that the mock
 * behaves as written.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const testDb = require('./helpers/testDatabase');

const available = testDb.isAvailable();

// Its own database AND its own login role. Sharing a role with the other DB
// suite meant both files updated the same pg_authid row concurrently, and
// Postgres refused one of them with "tuple concurrently updated".
const fixture = available ? testDb.setup('attest_queue_test', 'attest_test_queue') : null;
if (available) testDb.applyTestEnv(fixture.url);

if (!available) {
  test('queue tests skipped — no database reachable', () => assert.ok(true));
}

// Every test runs, or every test is skipped — never a silent partial run.
const run = available ? test : test.skip;

let db;
let queue;
let firmId;

before(async () => {
  db = require('../src/config/db');
  queue = require('../src/services/queue');

  // A firm to own the jobs, created the way registration does it.
  firmId = crypto.randomUUID();
  const client = await db.pool.connect();
  await client.query('SELECT set_config($1, $2, false)', ['app.current_firm_id', firmId]);
  await client.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [firmId, 'Queue Test Firm']);
  client.release();
});

after(async () => {
  await db?.close().catch(() => {});
});

const reset = () =>
  // attest_app has no DELETE grant, by design, so finished jobs are marked
  // rather than removed — which is also how the table behaves in production.
  db.withFirm(firmId, (c) =>
    c.query(
      `UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE status <> 'succeeded'`,
    ),
  );

const add = (payload = {}, options = {}) =>
  db.withFirm(firmId, (c) =>
    queue.enqueue(c, { firmId, type: queue.JOB_TYPES.PARSE_DOCUMENT, payload, ...options }),
  );

run('a queued job can be claimed', async () => {
  await reset();
  const enqueued = await add({ documentId: crypto.randomUUID() });
  assert.ok(enqueued.id);

  const claimed = await queue.claim();
  assert.equal(claimed.id, enqueued.id);
  assert.equal(claimed.firmId, firmId);
  assert.equal(claimed.attempts, 1, 'claiming counts as an attempt');
});

run('two workers claiming at once never get the same job', async () => {
  await reset();
  const documentIds = Array.from({ length: 8 }, () => crypto.randomUUID());
  for (const documentId of documentIds) await add({ documentId });

  // Eight concurrent claims against eight jobs. If SKIP LOCKED were not
  // doing its work, two of these would return the same row and the same
  // document would be parsed twice into the same period.
  const claimed = await Promise.all(Array.from({ length: 8 }, () => queue.claim()));
  const ids = claimed.filter(Boolean).map((j) => j.id);

  assert.equal(ids.length, 8, 'every job should have been claimed');
  assert.equal(new Set(ids).size, 8, 'NO JOB MAY BE CLAIMED TWICE');
});

run('an empty queue returns null rather than blocking', async () => {
  await reset();
  assert.equal(await queue.claim(), null);
});

run('the same document cannot be queued twice while one is live', async () => {
  await reset();
  const documentId = crypto.randomUUID();
  const first = await add({ documentId });
  const second = await add({ documentId });

  assert.ok(first.id);
  assert.equal(second.duplicate, true, 'a double-click must not queue a second parse');
});

run('a document can be re-queued once its previous job has finished', async () => {
  await reset();
  const documentId = crypto.randomUUID();
  await add({ documentId });
  const claimed = await queue.claim();
  await db.withFirm(firmId, (c) => queue.succeed(c, claimed.id));

  const requeued = await add({ documentId });
  assert.ok(requeued.id, 'a finished job must not block a later re-parse');
});

run('a failure is retried with backoff rather than immediately', async () => {
  await reset();
  await add({ documentId: crypto.randomUUID() });
  const job = await queue.claim();

  const result = await db.withFirm(firmId, (c) =>
    queue.fail(c, job, new Error('storage timed out')),
  );
  assert.equal(result.dead, false);
  assert.equal(result.retryInSeconds, queue.BACKOFF_SECONDS[0]);

  // Not eligible yet — backoff means backoff.
  assert.equal(await queue.claim(), null, 'a backed-off job must not be claimable yet');

  const stored = await db.withFirm(firmId, (c) => queue.findById(c, job.id));
  assert.equal(stored.status, 'queued');
  assert.match(stored.lastError, /storage timed out/);
});

run('a job that exhausts its attempts is marked dead, not retried forever', async () => {
  await reset();
  await add({ documentId: crypto.randomUUID() }, { maxAttempts: 1 });
  const job = await queue.claim();

  const result = await db.withFirm(firmId, (c) => queue.fail(c, job, new Error('still broken')));
  assert.equal(result.dead, true);

  const stored = await db.withFirm(firmId, (c) => queue.findById(c, job.id));
  assert.equal(stored.status, 'dead');
});

run('a permanent failure goes straight to dead without burning retries', async () => {
  await reset();
  await add({ documentId: crypto.randomUUID() }, { maxAttempts: 5 });
  const job = await queue.claim();

  // A file with no amount column will not grow one on the third attempt, and
  // making the accountant wait half an hour to be told so is the wrong
  // behaviour.
  const result = await db.withFirm(firmId, (c) =>
    queue.fail(c, job, new Error('This file has no column that reads as amount'), {
      permanent: true,
    }),
  );
  assert.equal(result.dead, true);

  const stored = await db.withFirm(firmId, (c) => queue.findById(c, job.id));
  assert.equal(stored.status, 'dead');
  assert.equal(stored.attempts, 1, 'a permanent failure should not consume every attempt');
});

run('a job stranded by a crashed worker is reclaimed once its lock goes stale', async () => {
  await reset();
  await add({ documentId: crypto.randomUUID() });
  const job = await queue.claim();

  // Simulate the worker dying mid-job: the row stays 'running' and its lock
  // is never released. Without reclaiming, the document would sit in
  // 'processing' forever, which to the accountant looks like an upload that
  // silently did nothing.
  await db.withFirm(firmId, (c) =>
    c.query(`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = $1`, [job.id]),
  );

  const reclaimed = await queue.claim();
  assert.ok(reclaimed, 'a stale running job must be reclaimable');
  assert.equal(reclaimed.id, job.id);
  assert.equal(reclaimed.attempts, 2);
});

run('a job scheduled for the future is not claimed early', async () => {
  await reset();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await add({ documentId: crypto.randomUUID() }, { runAt: future });
  assert.equal(await queue.claim(), null);
});

run('one firm cannot see another firm\'s jobs', async () => {
  await reset();
  await add({ documentId: crypto.randomUUID() });

  const otherFirmId = crypto.randomUUID();
  const client = await db.pool.connect();
  await client.query('SELECT set_config($1, $2, false)', ['app.current_firm_id', otherFirmId]);
  await client.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [otherFirmId, 'Other Firm']);
  client.release();

  const visible = await db.withFirm(otherFirmId, (c) => queue.stats(c));
  assert.deepEqual(visible, {}, 'the job table is tenant-isolated like everything else');
});

run('an unknown job type is refused at enqueue', async () => {
  await assert.rejects(
    () => db.withFirm(firmId, (c) => queue.enqueue(c, { firmId, type: 'do_something_odd' })),
    /Unknown job type/,
  );
});
