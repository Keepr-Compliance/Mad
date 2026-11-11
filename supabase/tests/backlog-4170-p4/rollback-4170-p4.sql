-- BACKLOG-4170 PR4 rollback: restores the ten functions changed by 20261111140000 to the text, ACL and
-- comment keepr-test held on 2026-11-10 before PR4 (bodies dumped from keepr-test; record_refund is the
-- BACKLOG-2345 body), recreates admin_get_user_detail(uuid) with the BACKLOG-4170 PR1 body and ACL
-- {postgres,authenticated,service_role}, and removes the PR4 catalog rows (credits.adjust and its role
-- grants by cascade; support-supervisor's billing.suspend).
-- Pre-pin: refuses unless each of the ten bodies is the PR4 text or the text this file restores (a
-- later migration's body is not overwritten).
-- Run only inside a transaction that is rolled back (harness), or with an explicit go for a real rollback.

DO $rbpin$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT v.sig, v.prev, v.post, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.admin_suspend_user(uuid,text)', 'c626b20ccdd9e6fc2595b3b33ca07bc6', '9456e424a6e67e7854eecf011644210e'),
        ('public.admin_unsuspend_user(uuid)', '25b70a3e30d2f029a920844097342248', 'bf90c682d4a149803723a568af8ace02'),
        ('public.admin_update_license(uuid,jsonb)', 'ab793576ab168fec56e30d428cfc0514', 'a4e8f48882981a58ad484bea7bbafd83'),
        ('public.admin_adjust_credits(uuid,integer,text,jsonb)', '32260362f3b97ab78b39eb9801510f69', '91edfad9cd29b13238f4e652c634fef0'),
        ('public.reinstate_suspended_account(uuid,text)', '8c3026b70a4c7a67d248f15640f3dc78', '2269e6ded34fde3a3ad2b737a9e94c61'),
        ('public.create_active_individual_license(uuid)', 'f16cd5585a0d62636a7ac1384fa6073d', '444a6fb65e16149252aa5aae5abb7dfb'),
        ('public.finalize_paid_unlock(uuid,text,integer,uuid,jsonb)', 'b6ae1cead90857a8611c70862b569b77', 'abca1cd3389a48209d431ca331116ac2'),
        ('public.record_credit_purchase(uuid,integer,integer,jsonb)', 'd44d9c9b68946403230151b958b0a2b3', '4a5267d181be72eff3c8424f04f18453'),
        ('public.record_refund(uuid,text,jsonb)', '977ff4981212913bb18d0b1f2ff5a1b8', '699d942f9ebd462e6d4e1e60521c63b5')
      ) AS v(sig, prev, post)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL OR r.cur NOT IN (r.prev, r.post) THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR4 rollback: % body is neither the PR4 text nor the pre-PR4 text (md5 %)', r.sig, r.cur;
    END IF;
  END LOOP;
END
$rbpin$;

CREATE OR REPLACE FUNCTION public.admin_suspend_user(p_user_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_status TEXT;
  v_email TEXT;
  v_licenses_suspended INT;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'Cannot suspend an internal user. Remove their internal role first.';
  END IF;

  SELECT status, email INTO v_current_status, v_email
  FROM public.users WHERE id = p_user_id;
  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF v_current_status = 'suspended' THEN
    RAISE EXCEPTION 'User is already suspended';
  END IF;

  -- Suspend the user
  UPDATE public.users
  SET status = 'suspended',
      suspended_at = NOW(),
      suspension_reason = p_reason,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Also suspend all active licenses so broker app blocks access
  UPDATE public.licenses
  SET status = 'suspended',
      updated_at = NOW()
  WHERE user_id = p_user_id
    AND status = 'active';
  GET DIAGNOSTICS v_licenses_suspended = ROW_COUNT;

  PERFORM public.log_admin_action(
    'user.suspend',
    'user',
    p_user_id::TEXT,
    jsonb_build_object(
      'before', jsonb_build_object(
        'status', v_current_status,
        'email', COALESCE(v_email, '')
      ),
      'after', jsonb_build_object(
        'status', 'suspended',
        'reason', COALESCE(p_reason, ''),
        'licenses_suspended', v_licenses_suspended
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'licenses_suspended', v_licenses_suspended);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_unsuspend_user(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_status TEXT;
  v_email TEXT;
  v_licenses_restored INT;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT status, email INTO v_current_status, v_email
  FROM public.users WHERE id = p_user_id;
  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF v_current_status != 'suspended' THEN
    RAISE EXCEPTION 'User is not suspended (current status: %)', v_current_status;
  END IF;

  -- Unsuspend the user
  UPDATE public.users
  SET status = 'active',
      suspended_at = NULL,
      suspension_reason = NULL,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Restore suspended licenses back to active
  UPDATE public.licenses
  SET status = 'active',
      updated_at = NOW()
  WHERE user_id = p_user_id
    AND status = 'suspended';
  GET DIAGNOSTICS v_licenses_restored = ROW_COUNT;

  PERFORM public.log_admin_action(
    'user.unsuspend',
    'user',
    p_user_id::TEXT,
    jsonb_build_object(
      'before', jsonb_build_object(
        'status', v_current_status,
        'email', COALESCE(v_email, '')
      ),
      'after', jsonb_build_object(
        'status', 'active',
        'licenses_restored', v_licenses_restored
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'licenses_restored', v_licenses_restored);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_license(p_license_id uuid, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_license RECORD;
  v_old_values JSONB;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_changes->>'license_type' = 'trial' THEN
    RAISE EXCEPTION 'license_type trial is no longer accepted' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_license FROM public.licenses WHERE id = p_license_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'License not found';
  END IF;

  v_old_values := jsonb_build_object(
    'status', v_license.status,
    'expires_at', v_license.expires_at,
    'license_type', v_license.license_type,
    'transaction_limit', v_license.transaction_limit,
    'trial_status', v_license.trial_status
  );

  IF p_changes ? 'status' THEN
    UPDATE public.licenses SET status = (p_changes->>'status'), updated_at = NOW() WHERE id = p_license_id;
  END IF;
  IF p_changes ? 'expires_at' THEN
    UPDATE public.licenses SET expires_at = (p_changes->>'expires_at')::TIMESTAMPTZ, updated_at = NOW() WHERE id = p_license_id;
  END IF;
  IF p_changes ? 'license_type' THEN
    UPDATE public.licenses SET license_type = (p_changes->>'license_type'), updated_at = NOW() WHERE id = p_license_id;
  END IF;
  IF p_changes ? 'transaction_limit' THEN
    UPDATE public.licenses SET transaction_limit = (p_changes->>'transaction_limit')::INTEGER, updated_at = NOW() WHERE id = p_license_id;
  END IF;
  IF p_changes ? 'trial_status' THEN
    UPDATE public.licenses SET trial_status = (p_changes->>'trial_status'), updated_at = NOW() WHERE id = p_license_id;
  END IF;

  PERFORM public.log_admin_action(
    'license.update',
    'license',
    p_license_id::TEXT,
    jsonb_build_object('old_values', v_old_values, 'new_values', p_changes, 'user_id', v_license.user_id)
  );

  RETURN jsonb_build_object('success', true, 'old_values', v_old_values, 'new_values', p_changes);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_adjust_credits(p_user_id uuid, p_amount integer, p_reason text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_id uuid;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'Adjustment amount must be non-zero';
  END IF;
  IF abs(p_amount) > 10000 THEN
    RAISE EXCEPTION 'Adjustment amount magnitude exceeds the 10000 credit cap';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required for every credit adjustment';
  END IF;

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, reason, metadata, created_by)
  VALUES
    (p_user_id, 'adjustment', p_amount, p_reason, COALESCE(p_metadata, '{}'::jsonb), auth.uid())
  RETURNING id INTO v_ledger_id;

  PERFORM public.log_admin_action(
    'credits.adjust',
    'user',
    p_user_id::text,
    jsonb_build_object('amount', p_amount, 'reason', p_reason, 'ledger_entry_id', v_ledger_id)
  );

  RETURN jsonb_build_object(
    'ledger_entry_id', v_ledger_id,
    'balance_after', public.get_credit_balance(p_user_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reinstate_suspended_account(p_user_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev_status    text;
  v_restore_status text;
  v_event_id       uuid;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reinstate an account';
  END IF;

  SELECT status INTO v_prev_status
  FROM public.licenses
  WHERE user_id = p_user_id;

  IF v_prev_status IS DISTINCT FROM 'suspended' THEN
    RAISE EXCEPTION 'Account is not suspended (current status: %)', COALESCE(v_prev_status, 'no license');
  END IF;

  SELECT previous_license_status INTO v_restore_status
  FROM public.account_suspensions
  WHERE user_id = p_user_id AND event_type = 'suspended'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_restore_status IS NULL OR v_restore_status = 'suspended' THEN
    v_restore_status := 'active';
  END IF;

  UPDATE public.licenses
  SET status = v_restore_status, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.account_suspensions (
    user_id, event_type, reason, previous_license_status, acted_by
  ) VALUES (
    p_user_id, 'reinstated', p_reason, v_prev_status, auth.uid()
  )
  RETURNING id INTO v_event_id;

  PERFORM public.log_admin_action(
    'account.reinstate',
    'user',
    p_user_id::text,
    jsonb_build_object(
      'reason', p_reason,
      'restored_license_status', v_restore_status,
      'suspension_event_id', v_event_id
    )
  );

  RETURN jsonb_build_object(
    'reinstated', true,
    'user_id', p_user_id,
    'restored_license_status', v_restore_status,
    'suspension_event_id', v_event_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_active_individual_license(p_user_id uuid)
 RETURNS licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_license public.licenses; v_key text; v_user_status text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND (auth.uid() IS NULL
          OR (p_user_id IS DISTINCT FROM auth.uid() AND NOT public.has_internal_role(auth.uid()))) THEN
    RAISE EXCEPTION 'Not allowed for this user' USING ERRCODE = '42501';
  END IF;
  SELECT u.status INTO v_user_status FROM public.users u WHERE u.id = p_user_id;
  v_key := 'IND-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.licenses (user_id, license_key, license_type, status, trial_status, trial_started_at, trial_expires_at, expires_at, max_devices, transaction_limit)
  VALUES (p_user_id, v_key, 'individual', CASE WHEN v_user_status = 'suspended' THEN 'suspended' ELSE 'active' END, NULL, NULL, NULL, NULL, 2, 99999)
  ON CONFLICT (user_id) DO NOTHING
  RETURNING * INTO v_license;
  IF v_license IS NULL THEN SELECT * INTO v_license FROM public.licenses WHERE user_id = p_user_id; END IF;
  RETURN v_license;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_paid_unlock(p_user_id uuid, p_local_transaction_id text, p_unit_price_cents integer, p_pricing_tier_id uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing        public.transaction_unlocks;
  v_purchase_id     uuid;
  v_debit_id        uuid;
  v_unlock_id       uuid;
  v_webhook_event_id text := p_metadata->>'webhook_event_id';
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_unit_price_cents < 0 THEN
    RAISE EXCEPTION 'Unit price must be non-negative';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

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

  BEGIN
    v_purchase_id := (
      public.record_credit_purchase(p_user_id, 1, p_unit_price_cents, p_metadata)
    )->>'ledger_entry_id';
  EXCEPTION WHEN unique_violation THEN
    IF v_webhook_event_id IS NULL THEN
      RAISE;
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

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, unit_price_cents, pricing_tier_id, funded_by, funding_source, created_by)
  VALUES
    (p_user_id, 'debit', -1, p_unit_price_cents, p_pricing_tier_id, v_purchase_id, 'purchase', p_user_id)
  RETURNING id INTO v_debit_id;

  INSERT INTO public.transaction_unlocks
    (user_id, local_transaction_id, ledger_entry_id, funding_source, counts_toward_tier)
  VALUES
    (p_user_id, p_local_transaction_id, v_debit_id, 'purchase', true)
  ON CONFLICT ON CONSTRAINT transaction_unlocks_user_tx_uq DO NOTHING
  RETURNING id INTO v_unlock_id;

  IF v_unlock_id IS NULL THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.record_credit_purchase(p_user_id uuid, p_units integer, p_unit_price_cents integer, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_units <= 0 THEN
    RAISE EXCEPTION 'Purchase units must be positive';
  END IF;

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, unit_price_cents, metadata, created_by)
  VALUES
    (p_user_id, 'purchase', p_units, p_unit_price_cents, COALESCE(p_metadata, '{}'::jsonb), auth.uid())
  RETURNING id INTO v_ledger_id;

  RETURN jsonb_build_object(
    'ledger_entry_id', v_ledger_id,
    'balance_after', public.get_credit_balance(p_user_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_refund(p_user_id uuid, p_local_transaction_id text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.admin_suspend_user(uuid, text) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_unsuspend_user(uuid) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_unsuspend_user(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_unsuspend_user(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_unsuspend_user(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_unsuspend_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unsuspend_user(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_update_license(uuid, jsonb) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_license(uuid, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_update_license(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_license(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.reinstate_suspended_account(uuid, text) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reinstate_suspended_account(uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.reinstate_suspended_account(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reinstate_suspended_account(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.create_active_individual_license(uuid) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.record_refund(uuid, text, jsonb) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) IS
  'BACKLOG-2005a: PAYG purchase-and-unlock. service_role/internal only. Under 2004 per-user advisory lock: short-circuit if already unlocked (R4), record purchase (+1, idempotent via 2004 webhook_event_id index), then a FORCED purchase-funded debit (funded_by=that purchase, R3/C-B) + unlock. Called by the Stripe webhook (payment_intent.succeeded) and the reconciliation sweep.';
COMMENT ON FUNCTION public.record_refund(uuid, text, jsonb) IS
  'BACKLOG-2345 (replaces 2005a): service_role/internal only. Sets transaction_unlocks.refunded_at and marks payment_intents refunded. Takes back only unspent purchased credit (funding purchase minus debits drawn, floored at 0, capped at the balance); writes no ledger row and returns credit_already_consumed=true when nothing is unspent. Never leaves the balance below zero. Idempotent (no-op if already refunded).';
COMMENT ON FUNCTION public.admin_suspend_user(uuid, text) IS NULL;
COMMENT ON FUNCTION public.admin_unsuspend_user(uuid) IS NULL;
COMMENT ON FUNCTION public.admin_update_license(uuid, jsonb) IS NULL;
COMMENT ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) IS NULL;
COMMENT ON FUNCTION public.reinstate_suspended_account(uuid, text) IS NULL;
COMMENT ON FUNCTION public.create_active_individual_license(uuid) IS NULL;
COMMENT ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) IS NULL;

-- admin_get_user_detail(uuid): the BACKLOG-4170 PR1 body (md5 fe2ed884c110aac7ad0e7075d093cc6c)
CREATE OR REPLACE FUNCTION public.admin_get_user_detail(target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result JSONB;
BEGIN
  -- Validate caller has internal role and users.view (BACKLOG-4170)
  IF NOT has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'users.view') THEN
    RAISE EXCEPTION 'Unauthorized: internal role required';
  END IF;

  SELECT jsonb_build_object(
    'user', (SELECT jsonb_build_object(
      'id', u.id,
      'email', u.email,
      'first_name', u.first_name,
      'last_name', u.last_name,
      'display_name', u.display_name,
      'avatar_url', u.avatar_url,
      'status', u.status,
      'is_active', u.is_active,
      'subscription_tier', u.subscription_tier,
      'subscription_status', u.subscription_status,
      'last_login_at', u.last_login_at,
      'login_count', u.login_count,
      'created_at', u.created_at,
      'trial_ends_at', u.trial_ends_at,
      'suspended_at', u.suspended_at,
      'suspension_reason', u.suspension_reason,
      'onboarding_completed_at', u.onboarding_completed_at,
      'oauth_provider', u.oauth_provider
    ) FROM users u WHERE u.id = target_user_id),
    'organizations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'org_id', o.id,
        'org_name', o.name,
        'org_slug', o.slug,
        'role', om.role,
        'license_status', om.license_status,
        'joined_at', om.created_at
      ))
      FROM organization_members om
      JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = target_user_id
    ), '[]'::jsonb),
    'license', (SELECT jsonb_build_object(
      'id', l.id,
      'status', l.status,
      'license_type', l.license_type,
      'max_devices', l.max_devices,
      'trial_status', l.trial_status,
      'trial_started_at', l.trial_started_at,
      'trial_expires_at', l.trial_expires_at,
      'transaction_count', l.transaction_count,
      'transaction_limit', l.transaction_limit,
      'activated_at', l.activated_at,
      'expires_at', l.expires_at,
      'created_at', l.created_at
    ) FROM licenses l WHERE l.user_id = target_user_id LIMIT 1),
    'devices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id,
        'device_id', d.device_id,
        'device_name', d.device_name,
        'os', d.os,
        'platform', d.platform,
        'app_version', d.app_version,
        'is_active', d.is_active,
        'last_seen_at', d.last_seen_at,
        'created_at', d.created_at
      ) ORDER BY d.last_seen_at DESC NULLS LAST)
      FROM devices d WHERE d.user_id = target_user_id
    ), '[]'::jsonb),
    'recent_audit_logs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', al.id,
        'action', al.action,
        'resource_type', al.resource_type,
        'resource_id', al.resource_id,
        'metadata', al.metadata,
        'success', al.success,
        'timestamp', al."timestamp"
      ) ORDER BY al."timestamp" DESC)
      FROM (
        SELECT * FROM audit_logs
        WHERE user_id = target_user_id
        ORDER BY "timestamp" DESC
        LIMIT 50
      ) al
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_get_user_detail(uuid) FROM PUBLIC, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) TO service_role;

-- catalog
DELETE FROM public.admin_role_permissions rp
 USING public.admin_roles r, public.admin_permissions p
 WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.slug = 'support-supervisor' AND p.key = 'billing.suspend';
DELETE FROM public.admin_permissions WHERE key = 'credits.adjust';
