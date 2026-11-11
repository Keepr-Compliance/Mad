-- BACKLOG-4170 PR4 — admin user write functions check a permission; three billing write functions
-- are service_role only; admin_get_user_detail is dropped
--
-- Group B: each function keeps its internal-role check and now also requires one permission (a caller
-- must pass both). Refusal text and SQLSTATE are unchanged; only the guard line changes.
--   admin_suspend_user(uuid, text)                 users.suspend
--   admin_unsuspend_user(uuid)                     users.suspend
--   admin_update_license(uuid, jsonb)              licenses.edit
--   admin_adjust_credits(uuid, integer, text, jsonb) credits.adjust (new key)
--   reinstate_suspended_account(uuid, text)        billing.suspend
--   create_active_individual_license(uuid)         licenses.edit for the internal branch (a caller
--                                                  creating another user's license); the self path and
--                                                  the service_role path are unchanged
-- Group C: the guard is COALESCE(auth.role(), '') <> 'service_role' -> RAISE 'Unauthorized'; the
-- internal-role branch is removed. EXECUTE for service_role only.
--   finalize_paid_unlock(uuid, text, integer, uuid, jsonb)
--   record_credit_purchase(uuid, integer, integer, jsonb)
--   record_refund(uuid, text, jsonb)               the BACKLOG-2345 body with the new guard
-- Dropped: admin_get_user_detail(uuid) (no caller).
--
-- Catalog: permission key credits.adjust (category billing), granted to the super-admin, sales and
-- support-supervisor roles; support-supervisor also gets billing.suspend.
-- Grants: group B EXECUTE revoked from PUBLIC and anon, granted to authenticated and service_role.
-- Group C EXECUTE revoked from PUBLIC, anon and authenticated, granted to service_role.
-- Comments on finalize_paid_unlock and record_refund updated to read "service_role only".
--
-- Pre-pin: stops unless each body is the text this file replaces or this file's text, record_refund is
-- the BACKLOG-2345 body (or this file's), migration 20261110100000 is recorded, and
-- admin_get_user_detail is absent or one of its two known bodies.
-- Post-check: bodies, grants and catalog rows.
-- Rollback: supabase/tests/backlog-4170-p4/rollback-4170-p4.sql.

DO $pin$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261110100000') THEN
    RAISE EXCEPTION 'BACKLOG-4170 PR4: migration 20261110100000 (BACKLOG-2345) is not recorded; apply it first';
  END IF;
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
    IF r.cur IS NULL THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR4: % not found', r.sig;
    END IF;
    IF r.cur NOT IN (r.prev, r.post) THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR4: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
  IF to_regprocedure('public.admin_get_user_detail(uuid)') IS NOT NULL
     AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.admin_get_user_detail(uuid)'))
         NOT IN ('e690d13b157f1ec88cd664f59cfacde4', 'fe2ed884c110aac7ad0e7075d093cc6c') THEN
    RAISE EXCEPTION 'BACKLOG-4170 PR4: public.admin_get_user_detail(uuid) body changed; re-review before applying';
  END IF;
END
$pin$;

-- ===== catalog =====
INSERT INTO public.admin_permissions (key, label, description, category) VALUES
  ('credits.adjust', 'Adjust credits', 'Grant or claw back a user''s credits', 'billing')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.admin_roles r
  JOIN public.admin_permissions p ON
       (r.slug IN ('super-admin', 'sales', 'support-supervisor') AND p.key = 'credits.adjust')
    OR (r.slug = 'support-supervisor' AND p.key = 'billing.suspend')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- users.suspend
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
  IF NOT public.has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'users.suspend') THEN
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

-- users.suspend
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
  IF NOT public.has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'users.suspend') THEN
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

-- licenses.edit (internal branch; the self and service_role paths are unchanged)
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
  IF NOT public.has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'licenses.edit') THEN
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

-- credits.adjust (new key)
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(p_user_id uuid, p_amount integer, p_reason text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_id uuid;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'credits.adjust') THEN
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

-- billing.suspend
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
  IF NOT public.has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'billing.suspend') THEN
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

-- licenses.edit (internal branch; the self and service_role paths are unchanged)
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
          OR (p_user_id IS DISTINCT FROM auth.uid() AND NOT (public.has_internal_role(auth.uid())
                                                    AND public.has_permission(auth.uid(), 'licenses.edit')))) THEN
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

-- service_role only
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
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
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

-- service_role only
CREATE OR REPLACE FUNCTION public.record_credit_purchase(p_user_id uuid, p_units integer, p_unit_price_cents integer, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_id uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
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

-- service_role only
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
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
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

DROP FUNCTION IF EXISTS public.admin_get_user_detail(uuid);

REVOKE EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_unsuspend_user(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_license(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reinstate_suspended_account(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_active_individual_license(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_unsuspend_user(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_license(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reinstate_suspended_account(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.finalize_paid_unlock(uuid, text, integer, uuid, jsonb) IS
  'BACKLOG-2005a: PAYG purchase-and-unlock. service_role only. Under 2004 per-user advisory lock: short-circuit if already unlocked (R4), record purchase (+1, idempotent via 2004 webhook_event_id index), then a FORCED purchase-funded debit (funded_by=that purchase, R3/C-B) + unlock. Called by the Stripe webhook (payment_intent.succeeded) and the reconciliation sweep.';

COMMENT ON FUNCTION public.record_refund(uuid, text, jsonb) IS
  'BACKLOG-2345 (replaces 2005a): service_role only. Sets transaction_unlocks.refunded_at and marks payment_intents refunded. Takes back only unspent purchased credit (funding purchase minus debits drawn, floored at 0, capped at the balance); writes no ledger row and returns credit_already_consumed=true when nothing is unspent. Never leaves the balance below zero. Idempotent (no-op if already refunded).';

DO $post$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT v.sig, v.post, v.acl, md5(p.prosrc) AS cur, p.proacl::text AS cur_acl
      FROM (VALUES
        ('public.admin_suspend_user(uuid,text)', '9456e424a6e67e7854eecf011644210e', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('public.admin_unsuspend_user(uuid)', 'bf90c682d4a149803723a568af8ace02', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('public.admin_update_license(uuid,jsonb)', 'a4e8f48882981a58ad484bea7bbafd83', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('public.admin_adjust_credits(uuid,integer,text,jsonb)', '91edfad9cd29b13238f4e652c634fef0', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('public.reinstate_suspended_account(uuid,text)', '2269e6ded34fde3a3ad2b737a9e94c61', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('public.create_active_individual_license(uuid)', '444a6fb65e16149252aa5aae5abb7dfb', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('public.finalize_paid_unlock(uuid,text,integer,uuid,jsonb)', 'abca1cd3389a48209d431ca331116ac2', '{postgres=X/postgres,service_role=X/postgres}'),
        ('public.record_credit_purchase(uuid,integer,integer,jsonb)', '4a5267d181be72eff3c8424f04f18453', '{postgres=X/postgres,service_role=X/postgres}'),
        ('public.record_refund(uuid,text,jsonb)', '699d942f9ebd462e6d4e1e60521c63b5', '{postgres=X/postgres,service_role=X/postgres}')
      ) AS v(sig, post, acl)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS DISTINCT FROM r.post THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR4 post-check: % md5 % (expected %)', r.sig, r.cur, r.post;
    END IF;
    IF r.cur_acl IS DISTINCT FROM r.acl THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR4 post-check: % acl % (expected %)', r.sig, r.cur_acl, r.acl;
    END IF;
  END LOOP;
  IF to_regprocedure('public.admin_get_user_detail(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-4170 PR4 post-check: admin_get_user_detail(uuid) still exists';
  END IF;
  IF (SELECT string_agg(ar.slug, ',' ORDER BY ar.slug)
        FROM public.admin_role_permissions rp
        JOIN public.admin_roles ar ON ar.id = rp.role_id
        JOIN public.admin_permissions ap ON ap.id = rp.permission_id
       WHERE ap.key = 'credits.adjust') IS DISTINCT FROM 'sales,super-admin,support-supervisor' THEN
    RAISE EXCEPTION 'BACKLOG-4170 PR4 post-check: credits.adjust is not held by exactly sales, super-admin, support-supervisor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admin_role_permissions rp
                   JOIN public.admin_roles ar ON ar.id = rp.role_id
                   JOIN public.admin_permissions ap ON ap.id = rp.permission_id
                  WHERE ar.slug = 'support-supervisor' AND ap.key = 'billing.suspend') THEN
    RAISE EXCEPTION 'BACKLOG-4170 PR4 post-check: support-supervisor does not hold billing.suspend';
  END IF;
END
$post$;
