-- BACKLOG-2345 rollback (keepr-test; production only if the migration was applied there).
-- Restores the deployed 20260715_backlog_2005_stripe_payg.sql body of record_refund verbatim (the
-- deployed body is the file's body without its comment lines; md5 c201419e1dcb0bae2dd34bea95118ef6),
-- checks its md5, then removes the 20261110100000 ledger row. CREATE OR REPLACE keeps the ACL, so
-- the REVOKE from PUBLIC and anon stays in place (anon never passed the guard inside anyway).
-- No data change: adjustments and refunded_at values written while the fix was live stay.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_refund(
  p_user_id            uuid,
  p_local_transaction_id text,
  p_metadata           jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $rb$
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

  IF v_unlock.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object('refunded', true, 'already', true, 'unlock_id', v_unlock.id);
  END IF;

  SELECT d.funded_by INTO v_funding_purchase
  FROM public.credit_ledger d
  WHERE d.id = v_unlock.ledger_entry_id;

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, reason, metadata, created_by)
  VALUES
    (p_user_id, 'adjustment', -1, 'refund',
     COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('refund_of_ledger_entry_id', v_funding_purchase),
     NULL)
  RETURNING id INTO v_adjustment_id;

  UPDATE public.transaction_unlocks
  SET refunded_at = now()
  WHERE id = v_unlock.id;

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
$rb$;

COMMENT ON FUNCTION public.record_refund(uuid, text, jsonb) IS
  'BACKLOG-2005a: refund netting. service_role/internal only. Sets '
  'transaction_unlocks.refunded_at (drops the unlock from the tier counter), writes a '
  'compensating adjustment(-1) referencing the funding purchase, and marks the '
  'payment_intents row refunded. Idempotent (no-op if already refunded). The -1 '
  'adjustment cannot become spendable grant capacity (2004 CR1 clamp).';

DO $chk$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.record_refund(uuid,text,jsonb)'))
     <> 'c201419e1dcb0bae2dd34bea95118ef6' THEN
    RAISE EXCEPTION 'BACKLOG-2345 rollback: restored body md5 mismatch';
  END IF;
  IF has_function_privilege('anon', 'public.record_refund(uuid,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_refund(uuid,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'BACKLOG-2345 rollback: unexpected grants';
  END IF;
END
$chk$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261110100000';

COMMIT;
