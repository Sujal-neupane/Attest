-- The role the application connects as.
--
-- ─── WHY THIS MIGRATION EXISTS ─────────────────────────────────────────────
--
-- Migration 001 enabled row-level security on every tenant-scoped table, and
-- the SQL tests proved the policies work. The application then connected as the
-- `postgres` superuser and every one of those policies was silently ignored —
-- because a Postgres SUPERUSER bypasses RLS unconditionally, and no error, log
-- line or warning is produced when it does. Firm B could list Firm A's clients
-- through the API while the isolation tests stayed green, because those tests
-- were careful to drop to a restricted role and the application was not.
--
-- This was caught by an end-to-end API test asserting that a second firm sees
-- an empty list. It is worth stating plainly: RLS is not a property of the
-- schema alone. It is a property of the schema AND the role that connects. A
-- correct policy reached by the wrong role is decorative.
--
-- So the application gets its own role, and that role can never bypass RLS.

BEGIN;

-- Roles live in pg_authid, which is CLUSTER-wide rather than per-database. Two
-- migrations running at the same time — three test suites setting up in
-- parallel, or two app instances deploying together — both try to update the
-- same catalog row, and Postgres refuses one of them with "tuple concurrently
-- updated". The failure has nothing to do with what either migration was
-- actually doing, which makes it maddening to diagnose.
--
-- An advisory lock serialises concurrent runs against THIS database. Note the
-- limit: advisory lock tags include the database oid, so runs against different
-- databases in the same cluster do not serialise against each other. That is
-- why the ALTER below is also made conditional — together they cover both the
-- same-database case (lock) and the different-database case (no write at all
-- when nothing needs changing).
SELECT pg_advisory_xact_lock(hashtext('attest:app_role'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'attest_app') THEN
    CREATE ROLE attest_app LOGIN;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Refuse to continue if attest_app can bypass row-level security.
--
-- A role created through a hosting console is often granted more than you asked
-- for. Neon, for one, makes every console-created role a member of
-- neon_superuser, which carries BYPASSRLS — so a role that looks perfectly
-- ordinary silently bypasses every policy in this schema, and the application
-- would run with tenant isolation entirely switched off while appearing fine.
--
-- The owner usually cannot fix such a role either: it can neither ALTER nor
-- DROP a role it did not create. So this stops here and says what to do,
-- rather than granting privileges to something that will ignore them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  problem text;
BEGIN
  SELECT CASE
           WHEN r.rolsuper THEN 'it is a superuser'
           WHEN r.rolbypassrls THEN 'it has the BYPASSRLS attribute'
           ELSE (SELECT 'it is a member of ' || g.rolname ||
                        ', which can bypass row-level security'
                   FROM pg_auth_members m
                   JOIN pg_roles g ON g.oid = m.roleid
                  WHERE m.member = r.oid AND (g.rolbypassrls OR g.rolsuper)
                  LIMIT 1)
         END
    INTO problem
    FROM pg_roles r
   WHERE r.rolname = 'attest_app';

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'The attest_app role cannot be used: %', problem
      USING HINT =
        'Delete attest_app in your hosting console and re-run migrations — this '
        'file creates a correct one with SQL. A role that bypasses RLS would '
        'let every firm read every other firm''s data.';
  END IF;
END;
$$;

-- Explicit and non-negotiable. NOSUPERUSER is stated even though it is the
-- default, because this is precisely the property that was assumed and wrong.
--
-- Applied only when something actually differs. An unconditional ALTER ROLE
-- rewrites the pg_authid row every time the migration runs, and because that
-- catalog is cluster-wide, two runs against different databases collide with
-- "tuple concurrently updated" — a failure with nothing to do with either
-- migration. Not writing when there is nothing to write removes the collision
-- and is the right behaviour regardless.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'attest_app'
       AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR NOT rolcanlogin)
  ) THEN
    ALTER ROLE attest_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;
END;
$$;

DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO attest_app', current_database());
END; $$;
GRANT USAGE ON SCHEMA public TO attest_app;

-- SELECT, INSERT and UPDATE — deliberately no DELETE, anywhere.
--
-- Financial records are never hard-deleted in this product: clients are
-- archived, flags are resolved, documents are marked failed. Withholding the
-- privilege means a stray DELETE is refused by the database rather than relying
-- on every future developer remembering the rule.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO attest_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO attest_app;

-- Tables added by later migrations must inherit the same grants, or the first
-- new table will work fine for the owner and fail in production.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO attest_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO attest_app;

COMMIT;

-- ---------------------------------------------------------------------------
-- The one query that legitimately runs before a firm is known.
--
-- Signing in requires reading a user row to check a password, and at that
-- moment nobody has proved who they are, so there is no firm to scope to. Every
-- other query in the system runs inside withFirm(); this is the single
-- exception, and rather than granting the application a way around row-level
-- security in general, it gets one narrow, auditable function that returns
-- exactly the columns a login needs and nothing else.
--
-- SECURITY DEFINER runs it as the owner, so the policies do not apply inside
-- it. search_path is pinned because a SECURITY DEFINER function with a mutable
-- search_path can be hijacked by a caller creating a same-named object in a
-- schema earlier on the path.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION attest_login_lookup(p_email text)
RETURNS TABLE (
  id uuid,
  firm_id uuid,
  email text,
  password_hash text,
  full_name text,
  role user_role,
  is_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.firm_id, u.email, u.password_hash, u.full_name, u.role, u.is_active
    FROM users u
   WHERE lower(u.email) = lower(p_email)
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION attest_login_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION attest_login_lookup(text) TO attest_app;
