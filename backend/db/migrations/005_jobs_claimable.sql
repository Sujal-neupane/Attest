-- Let the worker actually claim a job.
--
-- ─── THE BUG THIS FIXES ─────────────────────────────────────────────────────
--
-- attest_claim_job() is SECURITY DEFINER so the worker can see the queue across
-- firms — it has to, because it does not know which firm a job belongs to until
-- it has claimed one. That worked while migrations ran as a Postgres superuser:
-- the function inherited superuser, and a superuser bypasses row-level security
-- unconditionally.
--
-- On a real deployment nobody gives you a superuser. Neon, Supabase and Render
-- all hand you a database OWNER that is not one. The function then runs as that
-- owner — and `jobs` was declared FORCE ROW LEVEL SECURITY, which applies the
-- policy to the owner too. Inside the function no app.current_firm_id is set,
-- so the policy matched nothing, so the claim returned nothing.
--
-- No error. No log line. The worker polled an empty-looking queue forever while
-- documents sat at 'uploaded', and the accountant saw an upload that silently
-- did nothing. It only appeared when the deployment topology was reproduced
-- exactly; every test passed because the tests connect as a role that is not
-- the table owner.
--
-- ─── THE FIX, AND WHY IT DOES NOT WEAKEN ISOLATION ──────────────────────────
--
-- FORCE is removed from `jobs` ONLY. Row-level security stays enabled, so the
-- policy still applies to every role that does not own the table — which is
-- every role the application ever connects as.
--
-- That is the whole point of the split: the app connects as attest_app, which
-- owns nothing, so its queries are filtered exactly as before. The only thing
-- that gains is the claim function, which is the one piece that genuinely needs
-- to see across firms and does nothing else.
--
-- The application MUST NOT connect as the database owner. src/config/db.js
-- checks this at startup and refuses to serve if it is, because that
-- configuration would silently turn this line into a cross-tenant leak.

BEGIN;

ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE jobs IS
  'Row-level security is enabled but NOT forced, so the SECURITY DEFINER claim '
  'function can see the queue across firms. The application must connect as a '
  'non-owner role (attest_app); connecting as the owner would bypass the policy. '
  'Checked at startup in src/config/db.js.';

COMMIT;
