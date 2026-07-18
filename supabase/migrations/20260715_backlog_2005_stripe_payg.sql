-- Migration: Stripe PAYG charge tracking + fulfillment + refund netting (BACKLOG-2005a)
--
-- PURPOSE
--   Server-side money path for the "Paid Launch v1" pay-as-you-go model. Builds
--   directly on BACKLOG-2004's credit ledger (credit_ledger, transaction_unlocks,
--   credit_pricing_tiers, get_next_unlock_quote, get_credit_balance,
--   record_credit_purchase). This migration adds:
--     1. stripe_customers    -- user <-> Stripe customer + saved payment method.
--     2. payment_intents      -- in-flight charge tracking + the pay-but-unlock-fails
--                                reconciliation ledger (drives the sweep in 2005a's
--                                broker-portal /api/cron/payment-reconcile route).
--     3. transaction_unlocks.refunded_at  -- refund netting for the tier ladder.
--     4. get_next_unlock_quote (CREATE OR REPLACE)  -- exclude refunded unlocks.
--     5. finalize_paid_unlock(...)  -- the deferred "purchase_and_unlock" from 2004:
--          record a purchase (+1) then a FORCED purchase-funded debit + unlock,
--          all under 2004's per-user advisory lock. Called by the Stripe webhook
--          (payment_intent.succeeded, single fulfillment trigger) and the
--          reconciliation sweep, under service_role.
--     6. record_refund(...)  -- set refunded_at + a compensating adjustment(-1) +
--          mark the payment_intents row refunded.
--
-- DESIGN NOTES (SR plan review ec64ebc5 + 79cb1b9b; founder decisions on epic 1998)
--   R1  transaction_unlocks had NO refunded column and get_next_unlock_quote counted
--       ONLY counts_toward_tier (verified live). Refund-netting is NET-NEW here.
--   R3  finalize_paid_unlock writes the debit DIRECTLY with FORCED funding_source=
--       'purchase' / counts_toward_tier=true, funded_by = the JUST-inserted purchase.
--       It does NOT delegate to unlock_transaction() (which is GRANTS-FIRST and would
--       mis-attribute a paid unlock as free for any user holding a leftover grant).
--   R4  A distinct Stripe event id for an already-fulfilled tx must not create a 2nd
--       +1. finalize_paid_unlock SHORT-CIRCUITS on the existing (user, tx) unlock
--       BEFORE recording any purchase. Webhook also restricts fulfillment to the single
--       event type payment_intent.succeeded (2005a portal code).
--   C-B funded_by is LITERALLY the just-inserted purchase row id (RETURNING), never
--       2004's oldest-first selection.
--   Webhook idempotency inherits 2004's credit_ledger_webhook_event unique index
--       (metadata->>'webhook_event_id'): a replayed event -> 23505 on record_credit_purchase.
--
-- SECURITY MODEL (mirrors 2004 exactly)
--   stripe_customers / payment_intents: RLS enabled, own-row SELECT (+ internal-role
--   read-all), service_role ALL, NO direct user writes (all writes via service_role or
--   SECURITY DEFINER RPC). finalize_paid_unlock / record_refund: service_role OR internal
--   role (BACKLOG-1875 bypass: auth.uid() is NULL under service_role -> check auth.role()).
--
-- ROLLBACK (clean; net-new tables/columns, no data migration to reverse)
--   DROP FUNCTION IF EXISTS public.record_refund(uuid, text, jsonb);
--   DROP FUNCTION IF EXISTS public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb);
--   -- restore the 2004 body of get_next_unlock_quote (without the refunded predicate)
--   DROP TABLE IF EXISTS public.payment_intents;
--   DROP TABLE IF EXISTS public.stripe_customers;
--   ALTER TABLE public.transaction_unlocks DROP COLUMN IF EXISTS refunded_at;
--   DROP INDEX IF EXISTS public.transaction_unlocks_paid_counter_netted;

-- ============================================================================
-- 1. Refund column on the 2004 entitlement table + netted counter index (R1)
-- ============================================================================
ALTER TABLE public.transaction_unlocks
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;  -- NULL = not refunded

COMMENT ON COLUMN public.transaction_unlocks.refunded_at IS
  'BACKLOG-2005a: set by record_refund() when the funding purchase is refunded. A '
  'non-NULL value EXCLUDES this (paid) unlock from the annual tier counter in '
  'get_next_unlock_quote so a refund does not leave the user stuck at a higher tier.';

-- Index-backed paid-AND-not-refunded counter (supersedes 2004's paid-only counter
-- for the netted quote; 2004's transaction_unlocks_paid_counter is left in place).
CREATE INDEX IF NOT EXISTS transaction_unlocks_paid_counter_netted
  ON public.transaction_unlocks (user_id, unlocked_at)
  WHERE counts_toward_tier AND refunded_at IS NULL;

-- ============================================================================
-- 2. get_next_unlock_quote -- REPLACE to net out refunded unlocks (R1)
--    Body is copied verbatim from the 2004 migration, with ONE added predicate:
--    `AND u.refunded_at IS NULL`.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_next_unlock_quote(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (next_unit_index integer, unit_price_cents integer, currency text, pricing_tier_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH cnt AS (
    SELECT count(*)::int AS n
    FROM public.transaction_unlocks u
    WHERE u.user_id = COALESCE(p_user_id, auth.uid())
      AND u.counts_toward_tier                                    -- PAID unlocks only
      AND u.refunded_at IS NULL                                   -- BACKLOG-2005a: exclude refunded
      AND u.unlocked_at >= public.credit_period_start(COALESCE(p_user_id, auth.uid()))
  )
  SELECT (cnt.n + 1),
         t.unit_price_cents,
         t.currency,
         t.id
  FROM cnt
  JOIN public.credit_pricing_tiers t
    ON t.scope = 'individual'
   AND t.effective_to IS NULL
   AND (cnt.n + 1) >= t.min_units
   AND ((cnt.n + 1) <= t.max_units OR t.max_units IS NULL)
  LIMIT 1;
$$;

-- ============================================================================
-- 3. stripe_customers -- user <-> Stripe customer + saved payment method
-- ============================================================================
CREATE TABLE public.stripe_customers (
  user_id                   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id        text NOT NULL UNIQUE,
  default_payment_method_id text,          -- saved card for off-session charges (Flow B)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stripe_customers IS
  'BACKLOG-2005a: maps a Keepr user to their Stripe Customer and saved off-session '
  'payment method. Populated server-side (broker-portal) on first Checkout; '
  'default_payment_method_id set from checkout.session.completed. Writes via '
  'service_role only.';

-- ============================================================================
-- 4. payment_intents -- in-flight charge tracking + reconciliation ledger
--    (SR) NO UNIQUE(user_id, local_transaction_id, status): a user may legitimately
--    have a failed THEN a succeeded intent for the same tx; that unique would block
--    the retry. Idempotency lives on transaction_unlocks(user_id, local_transaction_id)
--    + stripe_payment_intent_id UNIQUE (double-click guard).
-- ============================================================================
CREATE TABLE public.payment_intents (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_transaction_id      text NOT NULL,   -- the desktop tx being paid to unlock (reliable identity source)
  stripe_payment_intent_id  text UNIQUE,
  stripe_checkout_session_id text UNIQUE,
  quoted_unit_price_cents   integer NOT NULL, -- server quote captured at creation (for reconciliation)
  pricing_tier_id           uuid REFERENCES public.credit_pricing_tiers(id),
  status                    text NOT NULL DEFAULT 'created',
  webhook_event_id          text,             -- last Stripe event id applied
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_status_ck CHECK (
    status IN ('created','requires_action','succeeded','fulfilled','failed','refunded')
  ),
  CONSTRAINT payment_intents_price_ck CHECK (quoted_unit_price_cents >= 0)
);

CREATE INDEX payment_intents_user       ON public.payment_intents (user_id);
-- Reconciliation sweep target: succeeded-but-not-fulfilled rows past the grace window.
CREATE INDEX payment_intents_reconcile  ON public.payment_intents (status, updated_at);

COMMENT ON TABLE public.payment_intents IS
  'BACKLOG-2005a: tracks each Stripe charge attempt and its fulfillment state. '
  'status: created -> (requires_action for SCA) -> succeeded (money captured) -> '
  'fulfilled (purchase + unlock recorded) | failed | refunded. A succeeded-not-'
  'fulfilled row is the reconciliation sweep target. local_transaction_id is the '
  'reliable tx identity source (the sweep uses it, not re-parsed Stripe metadata).';

-- ============================================================================
-- 5. RLS -- mirror 2004 exactly (own-row SELECT + internal-role read-all;
--          service_role ALL; NO user write policy)
-- ============================================================================
ALTER TABLE public.stripe_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents  ENABLE ROW LEVEL SECURITY;

CREATE POLICY stripe_customers_select_own ON public.stripe_customers
  FOR SELECT TO public
  USING (((SELECT auth.uid()) = user_id) OR public.has_internal_role((SELECT auth.uid())));
CREATE POLICY stripe_customers_service_role_all ON public.stripe_customers
  FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY payment_intents_select_own ON public.payment_intents
  FOR SELECT TO public
  USING (((SELECT auth.uid()) = user_id) OR public.has_internal_role((SELECT auth.uid())));
CREATE POLICY payment_intents_service_role_all ON public.payment_intents
  FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- 6. RPC: finalize_paid_unlock -- the deferred purchase_and_unlock (R3/R4/C-B)
--    service_role (Stripe webhook / reconciliation sweep) OR internal role.
--    Composes: short-circuit-if-already-unlocked -> record purchase (+1) ->
--    FORCED purchase-funded debit funded_by=that purchase -> unlock, under 2004's
--    per-user advisory lock. Idempotent by construction.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.finalize_paid_unlock(
  p_user_id            uuid,
  p_local_transaction_id text,
  p_unit_price_cents   integer,
  p_pricing_tier_id    uuid,
  p_metadata           jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_existing        public.transaction_unlocks;
  v_purchase_id     uuid;
  v_debit_id        uuid;
  v_unlock_id       uuid;
  v_webhook_event_id text := p_metadata->>'webhook_event_id';
BEGIN
  -- Guard: service_role (auth.uid() NULL under service_role, BACKLOG-1875) OR internal role.
  IF auth.role() <> 'service_role' AND NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_unit_price_cents < 0 THEN
    RAISE EXCEPTION 'Unit price must be non-negative';
  END IF;

  -- Same per-user advisory lock as 2004 unlock_transaction -> serializes against
  -- concurrent credit unlocks AND concurrent fulfillments for this user.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- R4: short-circuit on an EXISTING unlock BEFORE recording any purchase, so a
  -- distinct Stripe event id for an already-fulfilled tx creates NO second +1 row.
  SELECT * INTO v_existing
  FROM public.transaction_unlocks
  WHERE user_id = p_user_id AND local_transaction_id = p_local_transaction_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'unlocked', false,
      'already_fulfilled', true,
      'ledger_entry_id', v_existing.ledger_entry_id,
      'unlock_id', v_existing.id,
      'purchase_ledger_id', NULL,
      'balance_after', public.get_credit_balance(p_user_id)
    );
  END IF;

  -- Record the purchase (+1). Reuses 2004's record_credit_purchase so webhook
  -- idempotency (credit_ledger_webhook_event unique index) is enforced there.
  -- On a replayed event the unique index raises 23505 -> the purchase already
  -- exists; recover its id by webhook_event_id and proceed to ensure the unlock.
  BEGIN
    v_purchase_id := (
      public.record_credit_purchase(p_user_id, 1, p_unit_price_cents, p_metadata)
    )->>'ledger_entry_id';
  EXCEPTION WHEN unique_violation THEN
    IF v_webhook_event_id IS NULL THEN
      RAISE;  -- a unique violation without a webhook_event_id is not our idempotency case
    END IF;
    SELECT id INTO v_purchase_id
    FROM public.credit_ledger
    WHERE user_id = p_user_id
      AND entry_type = 'purchase'
      AND metadata->>'webhook_event_id' = v_webhook_event_id
    LIMIT 1;
    IF v_purchase_id IS NULL THEN
      RAISE EXCEPTION 'Purchase idempotency recovery failed for event %', v_webhook_event_id;
    END IF;
  END;

  -- R3/C-B: write the debit DIRECTLY, FORCING purchase funding drawn from THIS
  -- purchase row (never 2004's grants-first / oldest-first selection).
  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, unit_price_cents, pricing_tier_id, funded_by, funding_source, created_by)
  VALUES
    (p_user_id, 'debit', -1, p_unit_price_cents, p_pricing_tier_id, v_purchase_id, 'purchase', p_user_id)
  RETURNING id INTO v_debit_id;

  -- The durable, paid, tier-advancing unlock entitlement. ON CONFLICT guards the
  -- (rare) race where a concurrent call inserted the unlock between the short-circuit
  -- SELECT and here (both hold the advisory lock, so this is belt-and-suspenders).
  INSERT INTO public.transaction_unlocks
    (user_id, local_transaction_id, ledger_entry_id, funding_source, counts_toward_tier)
  VALUES
    (p_user_id, p_local_transaction_id, v_debit_id, 'purchase', true)
  ON CONFLICT ON CONSTRAINT transaction_unlocks_user_tx_uq DO NOTHING
  RETURNING id INTO v_unlock_id;

  IF v_unlock_id IS NULL THEN
    -- A concurrent fulfillment won the race: our debit is a duplicate -> reverse it
    -- so the ledger does not drift, and report already_fulfilled.
    DELETE FROM public.credit_ledger WHERE id = v_debit_id;
    SELECT * INTO v_existing
    FROM public.transaction_unlocks
    WHERE user_id = p_user_id AND local_transaction_id = p_local_transaction_id;
    RETURN jsonb_build_object(
      'unlocked', false,
      'already_fulfilled', true,
      'ledger_entry_id', v_existing.ledger_entry_id,
      'unlock_id', v_existing.id,
      'purchase_ledger_id', v_purchase_id,
      'balance_after', public.get_credit_balance(p_user_id)
    );
  END IF;

  -- Backstop only (the +1 purchase covers the -1 debit; balance nets zero).
  IF public.get_credit_balance(p_user_id) < 0 THEN
    RAISE EXCEPTION 'Balance invariant violated';
  END IF;

  RETURN jsonb_build_object(
    'unlocked', true,
    'already_fulfilled', false,
    'ledger_entry_id', v_debit_id,
    'unlock_id', v_unlock_id,
    'purchase_ledger_id', v_purchase_id,
    'balance_after', public.get_credit_balance(p_user_id)
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) IS
  'BACKLOG-2005a: PAYG purchase-and-unlock. service_role/internal only. Under 2004''s '
  'per-user advisory lock: short-circuit if already unlocked (R4), record purchase (+1, '
  'idempotent via 2004 webhook_event_id index), then a FORCED purchase-funded debit '
  '(funded_by=that purchase, R3/C-B) + unlock. Called by the Stripe webhook '
  '(payment_intent.succeeded) and the reconciliation sweep.';

-- ============================================================================
-- 7. RPC: record_refund -- set refunded_at + compensating adjustment(-1) +
--    mark the payment_intents row refunded. service_role / internal only.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_refund(
  p_user_id            uuid,
  p_local_transaction_id text,
  p_metadata           jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_unlock          public.transaction_unlocks;
  v_funding_purchase uuid;
  v_adjustment_id   uuid;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT * INTO v_unlock
  FROM public.transaction_unlocks
  WHERE user_id = p_user_id AND local_transaction_id = p_local_transaction_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('refunded', false, 'reason', 'no unlock for tx');
  END IF;

  -- Idempotent: already refunded -> no-op.
  IF v_unlock.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object('refunded', true, 'already', true, 'unlock_id', v_unlock.id);
  END IF;

  -- The purchase entry that funded this unlock (via the debit's funded_by).
  SELECT d.funded_by INTO v_funding_purchase
  FROM public.credit_ledger d
  WHERE d.id = v_unlock.ledger_entry_id;

  -- Compensating adjustment(-1). CR1 in 2004's unlock_transaction clamps net grant
  -- capacity at 0, so this -1 reduces net capacity and can NEVER become spendable
  -- grant credit (a refund must not hand the user a free future unlock).
  -- NOTE: funded_by is left NULL on the adjustment (funded_by means "the entry a DEBIT
  -- drew down"; this is not a debit). The refund->purchase link lives in metadata
  -- (refund_of_ledger_entry_id), and 2004's drawn-capacity CTE only joins funded_by for
  -- entry_type='debit', so this row never perturbs funding attribution.
  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, reason, metadata, created_by)
  VALUES
    (p_user_id, 'adjustment', -1, 'refund',
     COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('refund_of_ledger_entry_id', v_funding_purchase),
     NULL)
  RETURNING id INTO v_adjustment_id;

  -- Mark the entitlement refunded -> drops out of get_next_unlock_quote's counter.
  UPDATE public.transaction_unlocks
  SET refunded_at = now()
  WHERE id = v_unlock.id;

  -- Mark the matching payment_intents row (best-effort; keyed by tx + user).
  UPDATE public.payment_intents
  SET status = 'refunded', updated_at = now()
  WHERE user_id = p_user_id AND local_transaction_id = p_local_transaction_id
    AND status IN ('succeeded','fulfilled');

  RETURN jsonb_build_object(
    'refunded', true,
    'already', false,
    'unlock_id', v_unlock.id,
    'adjustment_ledger_id', v_adjustment_id,
    'balance_after', public.get_credit_balance(p_user_id)
  );
END;
$$;

COMMENT ON FUNCTION public.record_refund(uuid, text, jsonb) IS
  'BACKLOG-2005a: refund netting. service_role/internal only. Sets '
  'transaction_unlocks.refunded_at (drops the unlock from the tier counter), writes a '
  'compensating adjustment(-1) referencing the funding purchase, and marks the '
  'payment_intents row refunded. Idempotent (no-op if already refunded). The -1 '
  'adjustment cannot become spendable grant capacity (2004 CR1 clamp).';
