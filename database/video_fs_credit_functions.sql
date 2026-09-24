-- Video FS Agent — credit spend/grant functions (atomic, idempotent)
-- ---------------------------------------------------------------------------
-- All credit mutation goes through these SECURITY DEFINER functions so the
-- 3-bucket balance (free -> subscription -> purchased) and the ledger row are
-- updated in one locked transaction. Called from the server with the
-- service-role key. Idempotency is keyed off credit_transactions metadata so a
-- retried generation never double-charges.
-- ---------------------------------------------------------------------------

-- Enforce idempotency at the DB level: at most one txn per idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_idem_key_idx
  ON public.credit_transactions ((metadata->>'idempotency_key'))
  WHERE metadata ? 'idempotency_key';

-- spend_credits: debit p_credits across buckets (free -> subscription ->
-- purchased) and write a usage ledger row. Returns jsonb status:
--   {status:'ok', transaction_id, balance}
--   {status:'duplicate', transaction_id}      -- idempotency key already spent
--   {status:'insufficient', balance}
--   {status:'no_account'}
CREATE OR REPLACE FUNCTION public.spend_credits(
  p_user_id         text,
  p_credits         integer,
  p_tool_name       text DEFAULT NULL,
  p_project_id      uuid DEFAULT NULL,
  p_description     text DEFAULT NULL,
  p_cogs_usd        numeric DEFAULT NULL,
  p_metadata        jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_free bigint; v_sub integer; v_pur integer; v_total bigint;
  v_rem integer := p_credits;
  v_take integer;
  v_txn uuid;
  v_existing uuid;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN
    RETURN jsonb_build_object('status','bad_request');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.credit_transactions
      WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('status','duplicate','transaction_id',v_existing);
    END IF;
  END IF;

  SELECT free_credits, subscription_credits, purchased_credits
    INTO v_free, v_sub, v_pur
    FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','no_account');
  END IF;

  v_total := COALESCE(v_free,0) + COALESCE(v_sub,0) + COALESCE(v_pur,0);
  IF v_total < p_credits THEN
    RETURN jsonb_build_object('status','insufficient','balance',v_total);
  END IF;

  v_take := LEAST(COALESCE(v_free,0), v_rem); v_free := COALESCE(v_free,0) - v_take; v_rem := v_rem - v_take;
  v_take := LEAST(COALESCE(v_sub,0),  v_rem); v_sub  := COALESCE(v_sub,0)  - v_take; v_rem := v_rem - v_take;
  v_take := LEAST(COALESCE(v_pur,0),  v_rem); v_pur  := COALESCE(v_pur,0)  - v_take; v_rem := v_rem - v_take;

  UPDATE public.user_credits
    SET free_credits = v_free, subscription_credits = v_sub, purchased_credits = v_pur, updated_at = now()
    WHERE user_id = p_user_id;

  INSERT INTO public.credit_transactions
    (user_id, amount, type, tool_name, project_id, description, cogs_usd, metadata)
  VALUES
    (p_user_id, -p_credits, 'usage', p_tool_name, p_project_id, p_description, p_cogs_usd,
     COALESCE(p_metadata,'{}'::jsonb)
       || CASE WHEN p_idempotency_key IS NOT NULL
               THEN jsonb_build_object('idempotency_key', p_idempotency_key)
               ELSE '{}'::jsonb END)
  RETURNING id INTO v_txn;

  RETURN jsonb_build_object('status','ok','transaction_id',v_txn,'balance', v_total - p_credits);
END $$;

-- grant_credits: add credits to a bucket and write a positive ledger row. Used
-- for refunds (bucket 'free'), subscription resets ('subscription'), and
-- purchases ('purchased'). Idempotent on key.
CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id         text,
  p_credits         integer,
  p_bucket          text DEFAULT 'free',        -- free | subscription | purchased
  p_type            text DEFAULT 'grant',       -- grant | refund | subscription | purchase | reset
  p_description     text DEFAULT NULL,
  p_project_id      uuid DEFAULT NULL,
  p_metadata        jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn uuid;
  v_existing uuid;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN
    RETURN jsonb_build_object('status','bad_request');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.credit_transactions
      WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('status','duplicate','transaction_id',v_existing);
    END IF;
  END IF;

  -- Provision an EMPTY row if missing, so grant stays purely additive (does not
  -- double-count the column default). Deterministic 150-free provisioning is
  -- done by ensureCreditAccount() on login.
  INSERT INTO public.user_credits (user_id, free_credits, subscription_credits, purchased_credits)
    VALUES (p_user_id, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING;

  IF p_bucket = 'subscription' THEN
    UPDATE public.user_credits SET subscription_credits = subscription_credits + p_credits, updated_at = now()
      WHERE user_id = p_user_id;
  ELSIF p_bucket = 'purchased' THEN
    UPDATE public.user_credits SET purchased_credits = purchased_credits + p_credits, updated_at = now()
      WHERE user_id = p_user_id;
  ELSE
    UPDATE public.user_credits SET free_credits = free_credits + p_credits, updated_at = now()
      WHERE user_id = p_user_id;
  END IF;

  INSERT INTO public.credit_transactions
    (user_id, amount, type, project_id, description, metadata)
  VALUES
    (p_user_id, p_credits, COALESCE(p_type,'grant'), p_project_id, p_description,
     COALESCE(p_metadata,'{}'::jsonb)
       || CASE WHEN p_idempotency_key IS NOT NULL
               THEN jsonb_build_object('idempotency_key', p_idempotency_key)
               ELSE '{}'::jsonb END)
  RETURNING id INTO v_txn;

  RETURN jsonb_build_object('status','ok','transaction_id',v_txn);
END $$;

-- Lock down: only the service role may execute these.
REVOKE ALL ON FUNCTION public.spend_credits(text,integer,text,uuid,text,numeric,jsonb,text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.grant_credits(text,integer,text,text,text,uuid,jsonb,text)    FROM anon, authenticated;
