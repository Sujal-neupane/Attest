-- What the client's own books SAY, kept separately from what the engine COMPUTES.
--
-- A register states its own taxable value and VAT. Those figures are the
-- client's assertion, not the truth: a register that states Rs. 1,000 of VAT on
-- a Rs. 10,000 taxable sale is wrong, and that discrepancy is precisely what
-- the accountant is being paid to find.
--
-- Writing the reported figure into net_paisa/vat_paisa would destroy it — the
-- computed value would overwrite the claim, the numbers would agree, and the
-- error would vanish. So the two live in different columns:
--
--   reported_*  what the client wrote down       (from the register, never altered)
--   net/vat/tds what domain/tax.js computed      (deterministic, reproducible)
--
-- A difference between them becomes a flag. That comparison is only possible
-- because both survive.

BEGIN;

ALTER TABLE transactions
  ADD COLUMN reported_net_paisa bigint,
  ADD COLUMN reported_vat_paisa bigint,
  ADD COLUMN party_pan text,
  -- The date as the client wrote it, when their books are kept in Bikram
  -- Sambat. The review sheet shows both so nobody has to convert in their head.
  ADD COLUMN bs_date_label text;

ALTER TABLE transactions
  ADD CONSTRAINT reported_vat_non_negative
    CHECK (reported_vat_paisa IS NULL OR reported_vat_paisa >= 0);

COMMENT ON COLUMN transactions.reported_net_paisa IS
  'Taxable value as stated by the client''s register. Never overwritten by the tax engine.';
COMMENT ON COLUMN transactions.reported_vat_paisa IS
  'VAT as stated by the client''s register. Compared against the computed figure; a difference is a flag.';
COMMENT ON COLUMN transactions.net_paisa IS
  'Taxable value computed by domain/tax.js. The figure that reaches a return.';
COMMENT ON COLUMN transactions.vat_paisa IS
  'VAT computed by domain/tax.js. The figure that reaches a return.';

-- ---------------------------------------------------------------------------
-- A flag can also be superseded, which is not a human decision.
--
-- Re-running reconciliation after a new statement arrives must not leave stale
-- findings standing. Those old flags cannot be deleted (nothing in this system
-- hard-deletes financial records) and they must not be marked 'dismissed'
-- either — dismissed means an accountant looked at it and decided, and the
-- schema rightly demands to know WHO. Recording a machine action as a human
-- one is exactly the kind of false accountability the audit trail exists to
-- prevent.
--
-- So superseding gets its own status, and the attribution constraint is
-- narrowed to the two statuses that genuinely represent a person's judgement.
-- ---------------------------------------------------------------------------

ALTER TYPE flag_status ADD VALUE IF NOT EXISTS 'superseded';

COMMIT;

-- A new enum value cannot be used in the same transaction that adds it.
BEGIN;

ALTER TABLE flags DROP CONSTRAINT IF EXISTS resolution_is_attributed;
ALTER TABLE flags ADD CONSTRAINT resolution_is_attributed CHECK (
  status NOT IN ('accepted', 'dismissed')
  OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
);

-- Superseding still has to say when it happened, just not who.
ALTER TABLE flags ADD CONSTRAINT superseded_is_timestamped CHECK (
  status <> 'superseded' OR resolved_at IS NOT NULL
);

COMMIT;
