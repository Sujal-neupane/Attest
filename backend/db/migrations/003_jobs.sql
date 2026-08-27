-- Background jobs.
--
-- ─── WHY POSTGRES AND NOT REDIS/BULLMQ ──────────────────────────────────────
--
-- The original plan called for BullMQ on Redis. This uses Postgres instead,
-- with SELECT ... FOR UPDATE SKIP LOCKED, and the reasoning is worth recording
-- because it is a trade and not a free win.
--
-- What Postgres buys here:
--   * One datastore, not two. Redis would be a second thing to provision,
--     secure, back up and monitor, for a workload measured in documents per
--     day rather than messages per second.
--   * Enqueueing a job is part of the SAME transaction that creates the
--     document row. With a separate broker those two can diverge: the row
--     commits and the enqueue fails, leaving a document that is never parsed
--     and never marked failed — the exact silent-drop this product must not do.
--   * Jobs are inspectable with SQL, and their history is auditable alongside
--     the financial records they touched.
--
-- What it costs:
--   * Polling latency instead of a push. Fine when the work takes seconds.
--   * It will not scale to high message rates. If throughput ever demands it,
--     the queue module behind this table is a small interface and BullMQ can
--     be swapped in without touching the pipeline.
--
-- SKIP LOCKED is what makes this correct rather than merely convenient: two
-- workers polling at the same instant cannot claim the same job, because the
-- second one skips the row the first has locked instead of blocking on it.

BEGIN;

CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'dead');

CREATE TABLE jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  type           text NOT NULL,              -- 'parse_document', ...
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         job_status NOT NULL DEFAULT 'queued',

  attempts       integer NOT NULL DEFAULT 0,
  max_attempts   integer NOT NULL DEFAULT 3,
  -- When this job becomes eligible to run. Retries push it into the future,
  -- which is how backoff is expressed without a scheduler.
  run_at         timestamptz NOT NULL DEFAULT now(),

  -- Set while a worker holds the job. A row that is 'running' with a
  -- locked_at far in the past is a crashed worker, and is reclaimed.
  locked_at      timestamptz,
  locked_by      text,

  last_error     text,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attempts_within_limit CHECK (attempts >= 0 AND attempts <= max_attempts + 1),
  CONSTRAINT failure_has_reason CHECK (
    status NOT IN ('failed', 'dead') OR last_error IS NOT NULL
  )
);

-- The claim query's index: eligible jobs, oldest first. Partial, because
-- finished jobs are the overwhelming majority over time and never claimed.
CREATE INDEX jobs_claimable_idx ON jobs (run_at, created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX jobs_firm_idx ON jobs (firm_id, created_at DESC);
CREATE INDEX jobs_type_status_idx ON jobs (type, status);

-- One live job per document, so a double-click on Upload cannot queue the same
-- parse twice and write every transaction into the period twice over.
CREATE UNIQUE INDEX jobs_one_live_per_document
  ON jobs (type, (payload->>'documentId'))
  WHERE status IN ('queued', 'running') AND payload ? 'documentId';

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY jobs_firm_isolation ON jobs
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());

-- ---------------------------------------------------------------------------
-- The worker runs outside any one firm's request, so it needs to see the queue
-- across firms in order to pick up the next job at all. It gets exactly that
-- and nothing more: a SECURITY DEFINER function that claims one job and
-- returns it, including which firm it belongs to. The worker then does all its
-- real work inside withFirm() for that firm, under normal isolation.
--
-- This is the second and last SECURITY DEFINER exception in the system, and
-- like the first it is narrow enough to read in one sitting.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION attest_claim_job(
  p_types text[],
  p_worker text,
  p_stale_after interval DEFAULT '5 minutes'
)
RETURNS TABLE (
  id uuid,
  firm_id uuid,
  type text,
  payload jsonb,
  attempts integer,
  max_attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE jobs j
     SET status = 'running',
         attempts = j.attempts + 1,
         locked_at = now(),
         locked_by = p_worker,
         started_at = COALESCE(j.started_at, now())
   WHERE j.id = (
     SELECT candidate.id
       FROM jobs candidate
      WHERE candidate.type = ANY(p_types)
        AND candidate.run_at <= now()
        AND (
          candidate.status = 'queued'
          -- A job left 'running' by a worker that died is reclaimed once its
          -- lock goes stale. Without this a crash would strand a document in
          -- 'processing' forever, which to the accountant looks like an upload
          -- that silently did nothing.
          OR (candidate.status = 'running' AND candidate.locked_at < now() - p_stale_after)
        )
      ORDER BY candidate.run_at, candidate.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING j.id, j.firm_id, j.type, j.payload, j.attempts, j.max_attempts;
END;
$$;

REVOKE ALL ON FUNCTION attest_claim_job(text[], text, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION attest_claim_job(text[], text, interval) TO attest_app;

COMMIT;
