/**
 * Worker process entrypoint.
 *
 * Run with:  npm run worker
 *
 * Deliberately a separate process from the API, not a background timer inside
 * it. Parsing is CPU- and memory-heavy; sharing a process with the API means a
 * large statement makes every request slow. Separate processes also mean the
 * scaling answer is "run more workers", which is the whole reason the queue
 * exists.
 */

/* eslint-disable no-console -- process entrypoint; stdout is the log. */

const crypto = require('node:crypto');
const path = require('node:path');
const env = require('../config/env');
const db = require('../config/db');
const storage = require('../services/storage');
const { runOnce } = require('./parseDocument');

/** How long to wait after finding an empty queue before asking again. */
const IDLE_POLL_MS = 2_000;
/** After an unexpected error, back off before hammering whatever broke. */
const ERROR_PAUSE_MS = 5_000;

function resolveStore() {
  // The key must be 32 bytes of real entropy. In development one is derived
  // from the JWT secret so the worker and API agree without extra setup; in
  // production it is a distinct, explicitly configured secret, because reusing
  // a signing key as an encryption key is a mistake that is invisible until it
  // matters.
  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (env.isProduction && !secret) {
    console.error('STORAGE_ENCRYPTION_KEY is required in production.');
    process.exit(1);
  }
  const key = secret
    ? Buffer.from(secret, 'base64')
    : crypto.createHash('sha256').update(`dev-storage:${env.JWT_ACCESS_SECRET}`).digest();

  if (key.length !== storage.KEY_BYTES) {
    console.error(`STORAGE_ENCRYPTION_KEY must decode to ${storage.KEY_BYTES} bytes.`);
    process.exit(1);
  }

  const root = path.resolve(process.env.STORAGE_ROOT || 'uploads');
  return storage.createLocalStorage({ root, key });
}

async function main() {
  const store = resolveStore();
  const workerId = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`Attest worker ${workerId} started (${env.NODE_ENV})`);

  let running = true;
  let idle = 0;

  const stop = (signal) => {
    // Finish the job in hand rather than abandoning it — an abandoned job
    // leaves a document in 'processing' until its lock goes stale.
    console.log(`${signal} received, finishing current job then exiting`);
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (running) {
    try {
      const outcome = await runOnce({ store, logger: console });
      if (outcome === null) {
        idle++;
        await sleep(IDLE_POLL_MS);
      } else {
        idle = 0;
      }
    } catch (err) {
      // runOnce already handles job-level failure; reaching here means the
      // queue or database itself is unhappy.
      console.error('worker loop error', err);
      await sleep(ERROR_PAUSE_MS);
    }
  }

  await db.close().catch(() => {});
  console.log(`worker ${workerId} stopped after ${idle} idle polls`);
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('worker failed to start', err);
    process.exit(1);
  });
}

module.exports = { resolveStore };
