-- Video FS Agent — billing schema reconciliation
-- ---------------------------------------------------------------------------
-- Brings this project's Supabase to a SUPERSET-compatible billing schema with
-- impractical-chat's production billing, so its live rows (user_credits,
-- credit_transactions, subscriptions, auto_recharge_settings) can be copied in
-- without type/constraint failures. Derived from the LIVE donor schema
-- (project eiufbnkdusxbasijoxbl), not the stale database/*.sql files.
--
-- Drift handled:
--   * user_credits.free_credits: donor is bigint, ours was integer -> widen.
--   * credit_transactions: donor types (usage/refund/grant/subscription/reset)
--     already satisfy our existing CHECK; our extra nullable project_id is a
--     harmless superset column.
--   * subscriptions / auto_recharge_settings: did not exist here; created to
--     match donor columns (incl. business_enabled). tier/status CHECKs are
--     widened to cover all live values plus Stripe headroom.
-- ---------------------------------------------------------------------------

-- 1) Widen free_credits to match donor (safe widening).
ALTER TABLE public.user_credits
  ALTER COLUMN free_credits TYPE bigint;

-- 2) subscriptions (donor-aligned).
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id                text NOT NULL UNIQUE,
  stripe_customer_id     text,
  stripe_subscription_id text UNIQUE,
  tier                   text NOT NULL,
  status                 text NOT NULL DEFAULT 'active',
  credits_per_period     integer NOT NULL DEFAULT 0,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean DEFAULT false,
  business_enabled       boolean DEFAULT false,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_tier_check
    CHECK (tier IN ('free','core','creator','studio','standard','pro')),
  CONSTRAINT subscriptions_status_check
    CHECK (status IN ('active','canceled','past_due','trialing','incomplete','incomplete_expired','unpaid'))
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx        ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_customer_idx    ON public.subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_subscription_idx ON public.subscriptions(stripe_subscription_id);

-- 3) auto_recharge_settings (donor-aligned; 0 rows to copy, created for parity).
CREATE TABLE IF NOT EXISTS public.auto_recharge_settings (
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id                  text NOT NULL UNIQUE,
  enabled                  boolean NOT NULL DEFAULT false,
  threshold_credits        integer NOT NULL DEFAULT 500,
  recharge_pack            text NOT NULL DEFAULT 'starter',
  stripe_payment_method_id text,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now(),
  CONSTRAINT auto_recharge_settings_pkey PRIMARY KEY (id)
);

-- 4) Optional but recommended (donor lacks it): Stripe webhook idempotency.
-- Stripe retries deliveries; without a dedup record a retry can double-grant
-- credits. Keyed by Stripe's event id. Enable in the webhook route before
-- processing each event.
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id          text PRIMARY KEY,            -- Stripe event id (evt_...)
  type        text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 5) Security posture: match the rest of the app (deny-all to client keys;
-- server uses service-role which has BYPASSRLS).
ALTER TABLE public.subscriptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auto_recharge_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events  ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.subscriptions          FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.auto_recharge_settings FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.stripe_webhook_events  FROM anon, authenticated;

-- 6) updated_at touch triggers (set_updated_at() defined in initial schema).
DROP TRIGGER IF EXISTS subscriptions_set_updated_at ON public.subscriptions;
CREATE TRIGGER subscriptions_set_updated_at BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS auto_recharge_set_updated_at ON public.auto_recharge_settings;
CREATE TRIGGER auto_recharge_set_updated_at BEFORE UPDATE ON public.auto_recharge_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
