/**
 * The parse worker, running inside the API process.
 *
 * Enabled with WORKER_MODE=inline. See config/env.js for why this exists and
 * what it costs.
 *
 * Two things make it safe enough to offer:
 *
 * 1. It yields between jobs. setTimeout rather than a tight loop means the
 *    event loop gets to serve requests between documents, so an upload does
 *    not freeze the API for the length of a parse.
 *
 * 2. It uses the SAME claim path as the standalone worker — SELECT ... FOR
 *    UPDATE SKIP LOCKED. So running inline on two instances, or inline
 *    alongside a separate worker, cannot double-process a document. The
 *    concurrency guarantee is in the database, not in the process model, which
 *    is exactly why changing the process model is safe.
 */

const { runOnce } = require('./parseDocument');

const IDLE_POLL_MS = 3_000;
const BUSY_POLL_MS = 250;
const ERROR_PAUSE_MS = 10_000;

function startInlineWorker({ store, logger = console }) {
  let running = true;
  let timer = null;

  async function tick() {
    if (!running) return;

    let delay;
    try {
      const outcome = await runOnce({ store, logger });
      // Work found? Come straight back — a queue with ten documents in it
      // should not take thirty seconds to notice the second one.
      delay = outcome === null ? IDLE_POLL_MS : BUSY_POLL_MS;
    } catch (err) {
      logger.error?.({ err }, 'inline worker error');
      delay = ERROR_PAUSE_MS;
    }

    // unref() so a pending poll never holds the process open during shutdown.
    timer = setTimeout(tick, delay);
    timer.unref();
  }

  tick();

  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { startInlineWorker };
