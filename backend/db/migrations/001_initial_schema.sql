-- Attest — initial schema.
--
-- Two ideas run through this whole file and are worth reading before the SQL:
--
-- 1. TENANT ISOLATION IS ENFORCED BY THE DATABASE, NOT BY APPLICATION CODE.
--    Every tenant-scoped table carries firm_id and has Row-Level Security
--    policies that check it against a session variable set from the caller's
--    JWT. Application code has bugs; a missing WHERE clause in one repository
--    method would leak one firm's client financials to another and end this
--    product's credibility permanently. RLS makes that leak physically
--    impossible rather than merely unlikely.
--
-- 2. FINANCIAL RECORDS ARE NEVER HARD-DELETED.
--    Deletion is a status change. The audit log is append-only and enforced by
--    trigger, not by convention. This is both a professional expectation and a
--    legal requirement under the IRD's e-billing directives.
--
-- The schema is single-firm in practice for v1 but multi-tenant in shape from
-- the first migration, because retrofitting firm_id onto a live financial
-- database is not a migration anyone wants to write.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy party-name search

-- ---------------------------------------------------------------------------
-- Enumerated types. Constrained at the database so an impossible value cannot
-- be written even by a direct psql session during an incident.
-- ---------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('admin', 'preparer', 'reviewer');

CREATE TYPE document_type AS ENUM (
  'bank_statement', 'sales_register', 'purchase_register', 'invoice'
);

CREATE TYPE document_status AS ENUM (
  'uploaded', 'queued', 'processing', 'parsed', 'failed'
);

CREATE TYPE txn_source AS ENUM ('bank', 'ledger');
CREATE TYPE txn_direction AS ENUM ('debit', 'credit');
CREATE TYPE txn_kind AS ENUM ('sale', 'purchase', 'receipt', 'payment', 'other');

CREATE TYPE recon_status AS ENUM (
  'matched', 'matched_low_confidence', 'unmatched_bank', 'unmatched_ledger', 'partial'
);

CREATE TYPE flag_type AS ENUM (
  'duplicate_invoice', 'missing_bill', 'round_number', 'invoice_gap', 'anomaly'
);

CREATE TYPE flag_severity AS ENUM ('low', 'medium', 'high');
CREATE TYPE flag_status AS ENUM ('open', 'accepted', 'dismissed');

-- ---------------------------------------------------------------------------
-- Tenancy root
-- ---------------------------------------------------------------------------

CREATE TABLE firms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  -- Stored as written; compared case-insensitively via the unique index below,
  -- which avoids depending on the citext extension being available on the host.
  email          text,
  -- Nullable because Supabase Auth may own the credential instead; when this
  -- column is used it holds an argon2id hash and never a plaintext password.
  password_hash  text,
  full_name      text NOT NULL DEFAULT '',
  role           user_role NOT NULL DEFAULT 'preparer',
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Email is unique globally, not per firm: one address is one person, and
-- allowing the same address in two firms makes login ambiguous.
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_firm_idx ON users (firm_id);

-- ---------------------------------------------------------------------------
-- The firm's client businesses, and their fiscal periods
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  -- Nepali Permanent Account Number: exactly nine digits.
  pan         text CHECK (pan ~ '^[0-9]{9}$'),
  is_archived boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX clients_firm_pan_key ON clients (firm_id, pan) WHERE pan IS NOT NULL;
CREATE INDEX clients_firm_idx ON clients (firm_id) WHERE NOT is_archived;

CREATE TABLE fiscal_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  -- Human label in Bikram Sambat, e.g. 'FY 2081-82, Shrawan'. The BS dates are
  -- what the client and the IRD speak; start_date/end_date are the Gregorian
  -- equivalents the engine computes with. Both are stored because converting
  -- on every query is both slow and a place for drift to hide.
  label       text NOT NULL,
  bs_year     smallint NOT NULL CHECK (bs_year BETWEEN 2000 AND 2200),
  bs_month    smallint CHECK (bs_month BETWEEN 1 AND 12),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  is_locked   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_dates_ordered CHECK (end_date >= start_date)
);

CREATE INDEX fiscal_periods_client_idx ON fiscal_periods (client_id, start_date DESC);
CREATE INDEX fiscal_periods_firm_idx ON fiscal_periods (firm_id);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  fiscal_period_id  uuid NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  type              document_type NOT NULL,
  filename          text NOT NULL,
  -- Pointer into object storage. The file itself never lives on the app server
  -- and is only ever reachable through a short-lived signed URL.
  storage_key       text NOT NULL UNIQUE,
  content_hash      text,        -- sha256; catches the same statement uploaded twice
  byte_size         bigint CHECK (byte_size >= 0),
  page_count        integer CHECK (page_count >= 0),
  status            document_status NOT NULL DEFAULT 'uploaded',
  -- Populated when status = 'failed'. A document that fails to parse is marked
  -- failed and surfaced, never silently dropped.
  failure_reason    text,
  parsed_at         timestamptz,
  uploaded_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT failure_reason_present CHECK (
    (status = 'failed') = (failure_reason IS NOT NULL)
  )
);

CREATE INDEX documents_period_idx ON documents (fiscal_period_id, created_at DESC);
CREATE INDEX documents_firm_idx ON documents (firm_id);
CREATE UNIQUE INDEX documents_period_hash_key
  ON documents (fiscal_period_id, content_hash) WHERE content_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Transactions — the normalized spine of the product
-- ---------------------------------------------------------------------------

CREATE TABLE transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  fiscal_period_id  uuid NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,

  source            txn_source NOT NULL,
  kind              txn_kind NOT NULL DEFAULT 'other',
  txn_date          date NOT NULL,
  description       text NOT NULL DEFAULT '',
  party             text,
  invoice_number    text,
  reference         text,          -- cheque number, transfer reference

  -- MONEY IS INTEGER PAISA. Never numeric-with-scale, never float. bigint holds
  -- ~92 quadrillion paisa, which is comfortably beyond any real ledger, and
  -- integer arithmetic is exact by construction.
  amount_paisa      bigint NOT NULL,
  direction         txn_direction NOT NULL,

  -- Computed deterministically by backend/src/domain/tax.js. Nullable until the
  -- compute step has run, so a half-processed period is visibly half-processed
  -- rather than silently showing zeros.
  net_paisa         bigint,
  vat_paisa         bigint,
  tds_paisa         bigint,
  vat_applicable    boolean NOT NULL DEFAULT true,
  tds_category      text,

  -- AI may propose this; a human confirms it. Both facts are recorded, because
  -- "who decided this was rent" is exactly the question an auditor asks.
  category          text,
  category_source   text CHECK (category_source IN ('ai', 'human', 'rule')),
  category_confirmed_by uuid REFERENCES users(id),

  -- PROVENANCE. The reason this product can be trusted: page, line, and bounding
  -- box of the value in the source document, so every figure on screen can be
  -- traced back to the pixels it came from.
  --   { "page": 3, "line": 42, "bbox": [x0,y0,x1,y1], "raw": "1,234.50 Dr" }
  source_ref        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Sign convention, enforced rather than documented: a debit is money out and
  -- is stored negative. Getting this wrong silently inverts a VAT return, so it
  -- is a constraint and not a comment.
  CONSTRAINT amount_sign_matches_direction CHECK (
    (direction = 'debit'  AND amount_paisa <= 0) OR
    (direction = 'credit' AND amount_paisa >= 0)
  ),
  CONSTRAINT vat_non_negative CHECK (vat_paisa IS NULL OR vat_paisa >= 0),
  CONSTRAINT tds_non_negative CHECK (tds_paisa IS NULL OR tds_paisa >= 0)
);

CREATE INDEX transactions_period_idx ON transactions (fiscal_period_id, txn_date);
CREATE INDEX transactions_period_source_idx ON transactions (fiscal_period_id, source);
CREATE INDEX transactions_document_idx ON transactions (document_id);
CREATE INDEX transactions_firm_idx ON transactions (firm_id);
CREATE INDEX transactions_invoice_idx ON transactions (fiscal_period_id, invoice_number)
  WHERE invoice_number IS NOT NULL;
-- Trigram index: reconciliation and the AI's searchTransactions tool both look
-- up parties by approximate name.
CREATE INDEX transactions_party_trgm_idx ON transactions USING gin (party gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  fiscal_period_id  uuid NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  bank_txn_id       uuid REFERENCES transactions(id) ON DELETE RESTRICT,
  ledger_txn_id     uuid REFERENCES transactions(id) ON DELETE RESTRICT,
  status            recon_status NOT NULL,
  -- How the match was made and why, so the accountant can audit the matcher
  -- itself rather than taking it on faith.
  method            text,        -- 'exact' | 'strong' | 'fuzzy' | 'manual'
  confidence        numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  reasons           jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_difference_paisa bigint,
  day_difference    integer,
  -- Set when a human accepts or corrects the machine's proposal.
  confirmed_by      uuid REFERENCES users(id),
  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT at_least_one_side CHECK (bank_txn_id IS NOT NULL OR ledger_txn_id IS NOT NULL),
  CONSTRAINT matched_has_both_sides CHECK (
    status NOT IN ('matched', 'matched_low_confidence')
    OR (bank_txn_id IS NOT NULL AND ledger_txn_id IS NOT NULL)
  )
);

-- A transaction may appear in at most one match, which is what stops the same
-- bank line being reconciled against two different bills.
CREATE UNIQUE INDEX reconciliations_bank_txn_key
  ON reconciliations (bank_txn_id) WHERE bank_txn_id IS NOT NULL;
CREATE UNIQUE INDEX reconciliations_ledger_txn_key
  ON reconciliations (ledger_txn_id) WHERE ledger_txn_id IS NOT NULL;
CREATE INDEX reconciliations_period_idx ON reconciliations (fiscal_period_id, status);
CREATE INDEX reconciliations_firm_idx ON reconciliations (firm_id);

-- ---------------------------------------------------------------------------
-- Flags — everything needing a human decision
-- ---------------------------------------------------------------------------

CREATE TABLE flags (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  fiscal_period_id  uuid NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  transaction_id    uuid REFERENCES transactions(id) ON DELETE RESTRICT,
  related_transaction_ids uuid[] NOT NULL DEFAULT '{}',

  type              flag_type NOT NULL,
  severity          flag_severity NOT NULL,
  message           text NOT NULL,
  -- May be AI-drafted; ai_drafted records that fact so the reviewer always
  -- knows whether a machine wrote the sentence they are reading.
  suggestion        text,
  ai_drafted        boolean NOT NULL DEFAULT false,
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,

  status            flag_status NOT NULL DEFAULT 'open',
  resolved_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  resolved_note     text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- A resolved flag must say who resolved it and when. Anonymous sign-off is
  -- worse than no sign-off, because it looks like accountability.
  CONSTRAINT resolution_is_attributed CHECK (
    (status = 'open') OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  -- Dismissing a high-severity finding requires a written reason. This is the
  -- single most important rule in the table: it is what makes the review sheet
  -- a defensible record rather than a list someone clicked through.
  CONSTRAINT high_severity_dismissal_needs_reason CHECK (
    NOT (status = 'dismissed' AND severity = 'high')
    OR (resolved_note IS NOT NULL AND length(btrim(resolved_note)) >= 10)
  )
);

CREATE INDEX flags_period_open_idx ON flags (fiscal_period_id, severity, created_at)
  WHERE status = 'open';
CREATE INDEX flags_period_idx ON flags (fiscal_period_id, status);
CREATE INDEX flags_transaction_idx ON flags (transaction_id);
CREATE INDEX flags_firm_idx ON flags (firm_id);

-- ---------------------------------------------------------------------------
-- Audit log — append-only, enforced
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  firm_id      uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  user_id      uuid REFERENCES users(id) ON DELETE RESTRICT,  -- null for system actions
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address   inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_firm_time_idx ON audit_log (firm_id, created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- Append-only is a property of the table, not a promise made by the code that
-- writes to it. Revoking UPDATE and DELETE would be bypassed by a superuser
-- during an incident, so the trigger refuses regardless of role.
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % on audit row % was refused', TG_OP, OLD.id
    USING HINT = 'Corrections are recorded as new entries, never as edits.';
END;
$$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------------------
-- ROW-LEVEL SECURITY
--
-- The API sets `app.current_firm_id` on the connection from the verified JWT
-- before running any query. Every policy below compares firm_id against it.
-- A query that forgets its WHERE clause returns zero rows from another firm
-- instead of returning that firm's financial records.
--
-- current_setting(..., true) returns NULL rather than raising when the variable
-- is unset, so an unauthenticated connection sees nothing at all — the safe
-- direction to fail in.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_firm_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_firm_id', true), '')::uuid;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'clients', 'fiscal_periods', 'documents',
    'transactions', 'reconciliations', 'flags', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE applies the policy to the table owner too. Without this, the
    -- application's own role — which usually owns the tables — would bypass
    -- every policy and the whole mechanism would be decorative.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY %I_firm_isolation ON %I
        USING (firm_id = current_firm_id())
        WITH CHECK (firm_id = current_firm_id())
    $p$, t, t);
  END LOOP;
END;
$$;

-- The audit log is readable and insertable within a firm, but the append-only
-- triggers above still refuse updates and deletes.
CREATE POLICY firms_self_isolation ON firms
  USING (id = current_firm_id())
  WITH CHECK (id = current_firm_id());
ALTER TABLE firms ENABLE ROW LEVEL SECURITY;
ALTER TABLE firms FORCE ROW LEVEL SECURITY;

COMMIT;
