/* eslint-disable no-console -- This is the process entrypoint; writing
   startup and shutdown lines to stdout is exactly its job, and it runs before
   the request logger exists. */

/**
 * Process entrypoint.
 *
 * Separate from app.js so tests can build an app without binding a port, and so
 * everything about running as a process — signals, shutdown, unhandled
 * rejections — lives in one place.
 */

const env = require('./config/env');
const { createApp } = require('./app');
const db = require('./config/db');

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Attest API listening on :${env.PORT} (${env.NODE_ENV})`);
});

/**
 * Finish in-flight requests before exiting.
 *
 * A hard exit mid-request can leave a document marked `processing` forever,
 * which is worse than a slightly slower deploy: the accountant sees a stuck
 * upload and has no way to retry it.
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, finishing in-flight requests`);

  const force = setTimeout(() => {
    console.error('Shutdown timed out after 10s, exiting anyway');
    process.exit(1);
  }, 10_000).unref();

  server.close(async () => {
    clearTimeout(force);
    await db.close().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason);
  shutdown('unhandledRejection');
});
