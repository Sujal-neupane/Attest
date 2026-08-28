-- Encrypted document storage inside Postgres.
--
-- ─── WHY A THIRD BACKEND ────────────────────────────────────────────────────
--
-- The local-disk backend is wrong for any real deployment: a free host has no
-- persistent disk, so uploaded documents vanish on restart. The S3 backend is
-- the right answer — but every S3-compatible provider worth using asks for a
-- payment card before it will hand out a bucket, and "you need a credit card"
-- is a hard stop for someone deploying a portfolio project.
--
-- A database is a perfectly good blob store at small volume. The documents here
-- are encrypted CSVs and PDFs measured in kilobytes; a free Neon project holds
-- 0.5 GB, which is thousands of them. What a database is NOT good at is large
-- objects at scale — every read pulls the whole thing through the connection,
-- and backups grow with the blobs rather than with the ledger.
--
-- So this is the zero-account option, not the recommended one, and the S3
-- backend stays exactly where it is for when the trade stops being worth it.
-- Switching is one environment variable.
--
-- ─── ENCRYPTION IS STILL OURS ───────────────────────────────────────────────
--
-- The bytes stored here are AES-256-GCM ciphertext, exactly as they would be in
-- a bucket. The database never sees a client's statement in the clear, so a
-- database dump, a backup, or a support engineer with read access does not
-- expose one.

BEGIN;

CREATE TABLE document_blobs (
  storage_key  text PRIMARY KEY,
  firm_id      uuid NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  -- Ciphertext: [ 12-byte IV ][ 16-byte auth tag ][ encrypted document ].
  contents     bytea NOT NULL,
  byte_size    bigint NOT NULL CHECK (byte_size >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_blobs_firm_idx ON document_blobs (firm_id);

-- Isolated like everything else. A storage key is unguessable and the document
-- row that names it is already behind a policy, so this is the third lock on
-- the same door — which is the point.
ALTER TABLE document_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_blobs FORCE ROW LEVEL SECURITY;

CREATE POLICY document_blobs_firm_isolation ON document_blobs
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());

COMMENT ON TABLE document_blobs IS
  'Encrypted document bytes, for deployments without object storage. Enabled '
  'with STORAGE_BACKEND=postgres. Prefer S3 once a bucket is available.';

COMMIT;
