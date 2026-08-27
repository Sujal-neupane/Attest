/**
 * The job queue.
 *
 * Backed by Postgres (see db/migrations/003_jobs.sql for why, and what it
 * costs). This module is deliberately a small interface — enqueue, claim,
 * succeed, fail — so that if throughput ever outgrows polling, BullMQ can be
 * dropped in behind it without the pipeline noticing.
 *
 * The one property everything else depends on: **enqueue() takes the caller's
 * transaction client**. The job is written in the same transaction as the
 * document row it refers to. Either both commit or neither does, so there can
 * never be a document with no job (silently never parsed) or a job with no
 * document (fails forever on a row that does not exist).
 */

const crypto = require('node:crypto');
const { unscoped } = require('../config/db');

const JOB_TYPES = Object.freeze({ PARSE_DOCUMENT: 'parse_document' });

/** Identifies which process holds a lock, so a stuck job names its worker. */
const WORKER_ID = `${require('node:os').hostname()}#${process.pid}`;

/**
 * Retry backoff. Deliberately generous rather than aggressive: the failures
 * this queue actually sees are a storage hiccup or a transient database blip,
 * and hammering either one makes an outage worse. A malformed document does not
 * benefit from any retry at all, which is why permanent failures skip straight
 * to dead (see fail()).
 */
const BACKOFF_SECONDS = [30, 300, 1800];

/**
 * Add a job. MUST be called with the transaction client of whatever created the
 * work, so the two commit together.
 *
 * @param {import('pg').PoolClient} client
 */
async function enqueue(client, { firmId, type, payload, maxAttempts = 3, runAt }) {
  if (!Object.values(JOB_TYPES).includes(type)) {
    throw new Error(`Unknown job type: ${type}`);
  }

  const { rows } = await client.query(
    `INSERT INTO jobs (firm_id, type, payload, max_attempts, run_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()))
     -- One live job per document. A double-click on Upload must not queue the
     -- same parse twice and write every transaction into the period twice.
     ON CONFLICT DO NOTHING
     RETURNING id, type, status, run_at AS "runAt"`,
    [firmId, type, payload ?? {}, maxAttempts, runAt ?? null],
  );

  // No row means a live job for this document already exists. That is the
  // correct outcome, not an error — but the caller is told, so it can say
  // "already processing" rather than pretending it queued something new.
  return rows[0] ?? { duplicate: true };
}

/**
 * Claim the next eligible job across all firms.
 *
 * Goes through attest_claim_job(), a SECURITY DEFINER function, because the
 * worker runs outside any one firm's request and must see the whole queue to
 * pick anything up. It returns the job's firm, and every subsequent step runs
 * inside withFirm() under normal isolation.
 */
async function claim(types = Object.values(JOB_TYPES)) {
  const { rows } = await unscoped(
    `SELECT id, firm_id AS "firmId", type, payload, attempts, max_attempts AS "maxAttempts"
       FROM attest_claim_job($1, $2)`,
    [types, WORKER_ID],
  );
  return rows[0] ?? null;
}

async function succeed(client, jobId) {
  await client.query(
    `UPDATE jobs
        SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL
      WHERE id = $1`,
    [jobId],
  );
}

/**
 * Record a failure and decide whether to retry.
 *
 * `permanent` marks failures that retrying cannot fix — a file with no amount
 * column will not grow one on the third attempt. Those go straight to `dead`
 * with their explanation intact, so the accountant sees the real reason
 * immediately instead of watching a document sit in "processing" for half an
 * hour while it fails identically three times.
 */
async function fail(client, job, error, { permanent = false } = {}) {
  const message = truncate(error?.message || String(error), 2000);
  const exhausted = job.attempts >= job.maxAttempts;
  const dead = permanent || exhausted;

  const backoff = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)];

  // `dead` is passed as a boolean rather than reusing the status parameter in
  // both a SET and a comparison: Postgres cannot deduce one parameter as both
  // job_status and text, and casting around that reads worse than being
  // explicit about the thing we are actually branching on.
  await client.query(
    `UPDATE jobs
        SET status = CASE WHEN $2 THEN 'dead'::job_status ELSE 'queued'::job_status END,
            last_error = $3,
            run_at = CASE WHEN $2 THEN run_at ELSE now() + make_interval(secs => $4) END,
            finished_at = CASE WHEN $2 THEN now() ELSE NULL END,
            locked_at = NULL,
            locked_by = NULL
      WHERE id = $1`,
    [job.id, dead, message, backoff],
  );

  return { dead, retryInSeconds: dead ? null : backoff, message };
}

async function findById(client, jobId) {
  const { rows } = await client.query(
    `SELECT id, type, status, attempts, max_attempts AS "maxAttempts",
            last_error AS "lastError", run_at AS "runAt",
            started_at AS "startedAt", finished_at AS "finishedAt",
            created_at AS "createdAt"
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0] || null;
}

/** Queue depth, for the health endpoint and for knowing when to add workers. */
async function stats(client) {
  const { rows } = await client.query(
    `SELECT status, count(*)::int AS count FROM jobs GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Exposed so tests can generate a distinct worker identity. */
function newWorkerId(label) {
  return `${label}#${crypto.randomUUID().slice(0, 8)}`;
}

module.exports = {
  JOB_TYPES,
  WORKER_ID,
  BACKOFF_SECONDS,
  enqueue,
  claim,
  succeed,
  fail,
  findById,
  stats,
  newWorkerId,
};
