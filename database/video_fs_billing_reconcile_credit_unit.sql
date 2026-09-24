-- Video FS Agent — billing reconciliation for the $0.01 credit unit
-- ---------------------------------------------------------------------------
-- Aligns the credit grant default and adds raw-COGS accounting to the ledger so
-- the DB matches lib/usage-pricing.ts (1 credit = $0.01, 1.25x markup).
--
-- SAFETY: additive only. SET DEFAULT affects future inserts; ADD COLUMN IF NOT
-- EXISTS is idempotent. Existing user_credits balances and credit_transactions
-- rows (live/copied data) are intentionally NOT modified.
-- ---------------------------------------------------------------------------

-- 1) New free-tier signups start with 150 credits (was 500). Existing rows left
--    as-is; monthly grant logic in the app sets the per-tier amount thereafter.
ALTER TABLE public.user_credits
  ALTER COLUMN free_credits SET DEFAULT 150;

-- 2) Raw provider cost (USD) per transaction, for margin reporting without
--    parsing it back out of metadata. Nullable: only usage rows populate it.
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS cogs_usd numeric;

COMMENT ON COLUMN public.credit_transactions.cogs_usd IS
  'Raw provider COGS in USD for this op (fal/LLM); credits = ceil(cogs_usd * markup / 0.01).';
