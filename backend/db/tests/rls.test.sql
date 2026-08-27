-- Tenant isolation tests.
--
-- The claim "firm A cannot see firm B's data" is the single load-bearing
-- security property of this product, so it is tested against a real database
-- rather than asserted in a README.
--
-- Run with:  npm run test:db     (see backend/db/tests/run.sh)
--
-- Note on roles: a Postgres SUPERUSER bypasses row-level security entirely, so
-- these tests run as a dedicated non-superuser role. Testing isolation as the
-- superuser would pass trivially and prove nothing — which is a mistake worth
-- naming, because it is an easy one to make and it produces a green test that
-- is lying to you.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Fixtures: two firms, each with a client, a period and a transaction.
-- Created as the owner, before we drop to the restricted role.
-- ---------------------------------------------------------------------------

SET app.current_firm_id = '';

DO $$
DECLARE
  firm_a uuid; firm_b uuid;
  user_a uuid; user_b uuid;
  client_a uuid; client_b uuid;
  period_a uuid; period_b uuid;
  doc_a uuid; doc_b uuid;
BEGIN
  -- Seeding runs as a superuser, which bypasses RLS. That is the only reason
  -- rows for two different firms can be inserted in one transaction here.
  INSERT INTO firms (name) VALUES ('Firm A') RETURNING id INTO firm_a;
  INSERT INTO firms (name) VALUES ('Firm B') RETURNING id INTO firm_b;

  INSERT INTO users (firm_id, email, full_name, role)
    VALUES (firm_a, 'a@example.com', 'A User', 'admin') RETURNING id INTO user_a;
  INSERT INTO users (firm_id, email, full_name, role)
    VALUES (firm_b, 'b@example.com', 'B User', 'admin') RETURNING id INTO user_b;

  INSERT INTO clients (firm_id, name, pan)
    VALUES (firm_a, 'Client A', '123456789') RETURNING id INTO client_a;
  INSERT INTO clients (firm_id, name, pan)
    VALUES (firm_b, 'Client B', '987654321') RETURNING id INTO client_b;

  INSERT INTO fiscal_periods (firm_id, client_id, label, bs_year, bs_month, start_date, end_date)
    VALUES (firm_a, client_a, 'FY 2081-82, Shrawan', 2081, 4, '2024-07-16', '2024-08-16')
    RETURNING id INTO period_a;
  INSERT INTO fiscal_periods (firm_id, client_id, label, bs_year, bs_month, start_date, end_date)
    VALUES (firm_b, client_b, 'FY 2081-82, Shrawan', 2081, 4, '2024-07-16', '2024-08-16')
    RETURNING id INTO period_b;

  INSERT INTO documents (firm_id, client_id, fiscal_period_id, type, filename, storage_key, uploaded_by)
    VALUES (firm_a, client_a, period_a, 'bank_statement', 'a.csv', 'key-a', user_a)
    RETURNING id INTO doc_a;
  INSERT INTO documents (firm_id, client_id, fiscal_period_id, type, filename, storage_key, uploaded_by)
    VALUES (firm_b, client_b, period_b, 'bank_statement', 'b.csv', 'key-b', user_b)
    RETURNING id INTO doc_b;

  INSERT INTO transactions
    (firm_id, client_id, fiscal_period_id, document_id, source, txn_date, description,
     party, amount_paisa, direction)
  VALUES
    (firm_a, client_a, period_a, doc_a, 'bank', '2024-07-20', 'A payment',
     'Sharma Traders', -113000, 'debit'),
    (firm_b, client_b, period_b, doc_b, 'bank', '2024-07-20', 'B payment',
     'Gurung Hardware', -227000, 'debit');

  -- Stash the ids where the tests below can reach them.
  CREATE TEMP TABLE fixture (firm_a uuid, firm_b uuid, user_a uuid, period_a uuid);
  INSERT INTO fixture VALUES (firm_a, firm_b, user_a, period_a);
END;
$$;

-- ---------------------------------------------------------------------------
-- Drop to a role that does NOT bypass RLS.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'attest_app') THEN
    CREATE ROLE attest_app NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO attest_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO attest_app;

-- ---------------------------------------------------------------------------
-- The tests
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f_a uuid; f_b uuid; u_a uuid; p_a uuid;
  visible int;
  failed boolean;
BEGIN
  SELECT firm_a, firm_b, user_a, period_a INTO f_a, f_b, u_a, p_a FROM fixture;

  SET LOCAL ROLE attest_app;

  -- 1. With no firm set, an unauthenticated connection sees nothing at all.
  --    Failing closed is the only acceptable direction for this to fail in.
  PERFORM set_config('app.current_firm_id', '', true);
  SELECT count(*) INTO visible FROM transactions;
  ASSERT visible = 0,
    format('unauthenticated connection saw %s transactions, expected 0', visible);

  SELECT count(*) INTO visible FROM clients;
  ASSERT visible = 0, 'unauthenticated connection could see clients';

  -- 2. Acting as firm A, only firm A's rows are visible.
  PERFORM set_config('app.current_firm_id', f_a::text, true);

  SELECT count(*) INTO visible FROM transactions;
  ASSERT visible = 1, format('firm A saw %s transactions, expected exactly its own 1', visible);

  SELECT count(*) INTO visible FROM transactions WHERE party = 'Gurung Hardware';
  ASSERT visible = 0, 'FIRM A COULD SEE FIRM B''S TRANSACTION — tenant isolation is broken';

  SELECT count(*) INTO visible FROM clients WHERE name = 'Client B';
  ASSERT visible = 0, 'firm A could see firm B''s client';

  SELECT count(*) INTO visible FROM documents WHERE filename = 'b.csv';
  ASSERT visible = 0, 'firm A could see firm B''s document';

  SELECT count(*) INTO visible FROM users WHERE email = 'b@example.com';
  ASSERT visible = 0, 'firm A could see firm B''s users';

  -- 3. An explicit id from the other firm still returns nothing. This is the
  --    case that matters: it is what happens when application code forgets a
  --    WHERE clause and passes an id straight from a URL.
  SELECT count(*) INTO visible FROM clients WHERE firm_id = f_b;
  ASSERT visible = 0, 'a direct query for another firm''s id returned rows';

  -- 4. Firm A cannot WRITE a row belonging to firm B, which the WITH CHECK
  --    clause is there to prevent. Without it, isolation would be read-only
  --    and a compromised session could plant data in another firm's books.
  failed := false;
  BEGIN
    INSERT INTO clients (firm_id, name) VALUES (f_b, 'Smuggled In');
  EXCEPTION WHEN insufficient_privilege THEN
    failed := true;
  END;
  ASSERT failed, 'firm A was able to INSERT a row belonging to firm B';

  -- 5. Firm A cannot reassign its own row into firm B.
  failed := false;
  BEGIN
    UPDATE clients SET firm_id = f_b WHERE firm_id = f_a;
  EXCEPTION WHEN insufficient_privilege THEN
    failed := true;
  END;
  ASSERT failed, 'firm A was able to move a row into firm B';

  -- 6. Switching firms switches the entire visible world.
  PERFORM set_config('app.current_firm_id', f_b::text, true);
  SELECT count(*) INTO visible FROM transactions WHERE party = 'Gurung Hardware';
  ASSERT visible = 1, 'firm B could not see its own transaction';
  SELECT count(*) INTO visible FROM transactions WHERE party = 'Sharma Traders';
  ASSERT visible = 0, 'firm B could see firm A''s transaction';

  RESET ROLE;
  RAISE NOTICE 'PASS  tenant isolation: 6/6';
END;
$$;

-- ---------------------------------------------------------------------------
-- Append-only audit log
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f_a uuid; u_a uuid; log_id bigint; failed boolean;
BEGIN
  SELECT firm_a, user_a INTO f_a, u_a FROM fixture;
  PERFORM set_config('app.current_firm_id', f_a::text, true);

  INSERT INTO audit_log (firm_id, user_id, action, entity_type, entity_id, detail)
    VALUES (f_a, u_a, 'override_flag', 'flag', 'some-flag-id', '{"note":"original"}')
    RETURNING id INTO log_id;

  failed := false;
  BEGIN
    UPDATE audit_log SET detail = '{"note":"tampered"}' WHERE id = log_id;
  EXCEPTION WHEN OTHERS THEN
    failed := true;
  END;
  ASSERT failed, 'AN AUDIT LOG ENTRY WAS EDITABLE — the trail is not immutable';

  failed := false;
  BEGIN
    DELETE FROM audit_log WHERE id = log_id;
  EXCEPTION WHEN OTHERS THEN
    failed := true;
  END;
  ASSERT failed, 'AN AUDIT LOG ENTRY WAS DELETABLE — the trail is not immutable';

  RAISE NOTICE 'PASS  audit log is append-only: 2/2';
END;
$$;

-- ---------------------------------------------------------------------------
-- Domain constraints that protect the numbers
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f_a uuid; u_a uuid; p_a uuid; c_a uuid; d_a uuid; t_a uuid;
  failed boolean;
BEGIN
  SELECT firm_a, user_a, period_a INTO f_a, u_a, p_a FROM fixture;
  PERFORM set_config('app.current_firm_id', f_a::text, true);
  SELECT client_id, document_id, id INTO c_a, d_a, t_a FROM transactions WHERE firm_id = f_a LIMIT 1;

  -- A debit is money out and must be stored negative. Getting this wrong
  -- silently inverts a VAT return, so the database refuses it.
  failed := false;
  BEGIN
    INSERT INTO transactions (firm_id, client_id, fiscal_period_id, document_id,
                              source, txn_date, amount_paisa, direction)
      VALUES (f_a, c_a, p_a, d_a, 'bank', '2024-07-21', 500000, 'debit');
  EXCEPTION WHEN check_violation THEN
    failed := true;
  END;
  ASSERT failed, 'a positive debit was accepted — the sign convention is not enforced';

  -- Dismissing a high-severity finding requires a written reason. This is what
  -- makes the review sheet a defensible record rather than a list of clicks.
  INSERT INTO flags (firm_id, fiscal_period_id, transaction_id, type, severity, message)
    VALUES (f_a, p_a, t_a, 'duplicate_invoice', 'high', 'Invoice booked twice');

  failed := false;
  BEGIN
    UPDATE flags SET status = 'dismissed', resolved_by = u_a, resolved_at = now(), resolved_note = 'ok'
      WHERE severity = 'high';
  EXCEPTION WHEN check_violation THEN
    failed := true;
  END;
  ASSERT failed, 'a high-severity flag was dismissed with a token reason';

  -- The same dismissal with a real explanation is allowed.
  UPDATE flags SET status = 'dismissed', resolved_by = u_a, resolved_at = now(),
                   resolved_note = 'Confirmed with client: second entry is a credit note, not a duplicate.'
    WHERE severity = 'high';

  -- A resolved flag must say who resolved it. Anonymous sign-off is worse than
  -- none, because it looks like accountability.
  failed := false;
  BEGIN
    INSERT INTO flags (firm_id, fiscal_period_id, type, severity, message, status)
      VALUES (f_a, p_a, 'round_number', 'low', 'Round figure', 'accepted');
  EXCEPTION WHEN check_violation THEN
    failed := true;
  END;
  ASSERT failed, 'a flag was resolved without recording who resolved it';

  RAISE NOTICE 'PASS  domain constraints: 4/4';
END;
$$;

DO $$ BEGIN RAISE NOTICE 'ALL DATABASE TESTS PASSED'; END; $$;
