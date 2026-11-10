-- BACKLOG-2345: a refund never takes the credit balance below zero.
--
-- record_refund (replaced, same signature) still marks the unlock refunded
-- (transaction_unlocks.refunded_at) and the payment_intents row refunded. It now takes back only
-- credit that is still unspent:
--   refundable = funding purchase amount - debits drawn on that purchase, floored at 0,
--                capped at the current balance (floored at 0).
-- The adjustment is written only when refundable > 0. Otherwise no ledger row is written and the
-- result carries credit_already_consumed = true. Only a 'purchase' funding entry counts; an unlock
-- funded by a grant adjustment takes nothing back. A balance below zero after the adjustment
-- raises (backstop, inside the write branch only, so a balance that was already negative before
-- the refund does not turn the webhook into a permanent error).
-- Removing the desktop unlock on refund is not part of this change (BACKLOG-4218).
-- Pre-check: the body being replaced is the 20260715_backlog_2005_stripe_payg.sql one (md5 pinned),
-- or this one. Grants: EXECUTE for service_role only (PUBLIC, anon, authenticated lose it).
-- Post-check: new md5 and the grants.
-- Rollback: supabase/tests/backlog-2345/rollback-2345.sql.

DO $pin$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.record_refund(uuid,text,jsonb)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-2345: record_refund(uuid,text,jsonb) not found';
  END IF;
  IF md5(v_src) <> 'c201419e1dcb0bae2dd34bea95118ef6' AND position('credit_already_consumed' IN v_src) = 0 THEN
    RAISE EXCEPTION 'BACKLOG-2345: unexpected record_refund body (md5 %)', md5(v_src);
  END IF;
END
$pin$;

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
  v_unlock           public.transaction_unlocks;
  v_funding_purchase uuid;
  v_purchase_amount  integer;
  v_debits_drawn     integer;
  v_refundable       integer := 0;
  v_balance          integer;
  v_adjustment_id    uuid;
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

  -- The purchase that funded this unlock (via the debit's funded_by). A grant-funded unlock
  -- has no funding purchase and takes nothing back.
  SELECT f.id, f.amount INTO v_funding_purchase, v_purchase_amount
  FROM public.credit_ledger d
  JOIN public.credit_ledger f ON f.id = d.funded_by AND f.entry_type = 'purchase'
  WHERE d.id = v_unlock.ledger_entry_id;

  IF v_funding_purchase IS NOT NULL THEN
    SELECT count(*)::int INTO v_debits_drawn
    FROM public.credit_ledger d
    WHERE d.entry_type = 'debit' AND d.funded_by = v_funding_purchase;

    -- Floor: only the unspent part of the purchase.
    v_refundable := GREATEST(v_purchase_amount - v_debits_drawn, 0);
    -- Cap: never more than the user holds.
    v_balance := public.get_credit_balance(p_user_id);
    v_refundable := LEAST(v_refundable, GREATEST(v_balance, 0));
  END IF;

  IF v_refundable > 0 THEN
    -- funded_by stays NULL (this is not a debit); the purchase link lives in metadata.
    INSERT INTO public.credit_ledger
      (user_id, entry_type, amount, reason, metadata, created_by)
    VALUES
      (p_user_id, 'adjustment', -v_refundable, 'refund',
       COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('refund_of_ledger_entry_id', v_funding_purchase),
       NULL)
    RETURNING id INTO v_adjustment_id;

    -- Backstop: this write must not leave the balance below zero.
    IF public.get_credit_balance(p_user_id) < 0 THEN
      RAISE EXCEPTION 'Balance invariant violated';
    END IF;
  END IF;

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
    'credit_already_consumed', (v_refundable = 0),
    'balance_after', public.get_credit_balance(p_user_id)
  );
END;
$$;

COMMENT ON FUNCTION public.record_refund(uuid, text, jsonb) IS
  'BACKLOG-2345 (replaces 2005a): service_role/internal only. Sets transaction_unlocks.refunded_at '
  'and marks payment_intents refunded. Takes back only unspent purchased credit (funding purchase '
  'minus debits drawn, floored at 0, capped at the balance); writes no ledger row and returns '
  'credit_already_consumed=true when nothing is unspent. Never leaves the balance below zero. '
  'Idempotent (no-op if already refunded).';

-- Only the Stripe webhook (service_role) calls this; no signed-in client does. Follows the repo's
-- revoke-by-default rule for new and replaced functions: EXECUTE for service_role only. The
-- has_internal_role branch inside the body stays as a second line and is unreachable for
-- authenticated callers once the grant is gone.
REVOKE EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO service_role;

DO $post$
DECLARE v_src text; v_acl text;
BEGIN
  SELECT p.prosrc, p.proacl::text INTO v_src, v_acl FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.record_refund(uuid,text,jsonb)');
  IF md5(v_src) <> '977ff4981212913bb18d0b1f2ff5a1b8' THEN
    RAISE EXCEPTION 'BACKLOG-2345: record_refund body md5 % after replace', md5(v_src);
  END IF;
  IF has_function_privilege('anon', 'public.record_refund(uuid,text,jsonb)', 'EXECUTE')
     OR v_acl LIKE '{=X%' OR v_acl LIKE '%,=X%'
     OR has_function_privilege('authenticated', 'public.record_refund(uuid,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_refund(uuid,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'BACKLOG-2345: record_refund ACL unexpected: %', v_acl;
  END IF;
END
$post$;
