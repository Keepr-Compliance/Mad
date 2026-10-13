-- Production bodies (pg_get_functiondef, read 2026-10-12) of the functions the
-- 3846 controls call whose NAS copy has drifted. Loaded inside the rolled-back
-- run, then md5-checked against production's prosrc md5 so a transcription slip
-- fails the run instead of testing the wrong body.

CREATE OR REPLACE FUNCTION public.suspend_account_for_dispute(p_user_id uuid, p_stripe_dispute_id text, p_payment_intent_id text DEFAULT NULL::text, p_local_transaction_id text DEFAULT NULL::text, p_amount_cents integer DEFAULT NULL::integer, p_dispute_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev_status text;
  v_event_id    uuid;
  v_reason      text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_stripe_dispute_id IS NULL OR btrim(p_stripe_dispute_id) = '' THEN
    RAISE EXCEPTION 'p_stripe_dispute_id is required';
  END IF;

  SELECT status INTO v_prev_status
  FROM public.licenses
  WHERE user_id = p_user_id;

  v_reason := 'Chargeback opened (dispute ' || p_stripe_dispute_id || ')'
    || COALESCE(' on tx ' || p_local_transaction_id, '')
    || COALESCE(' for ' || (p_amount_cents::text) || ' cents', '');

  INSERT INTO public.account_suspensions (
    user_id, event_type, reason,
    stripe_dispute_id, stripe_payment_intent_id, local_transaction_id,
    amount_cents, dispute_created_at, previous_license_status, acted_by
  ) VALUES (
    p_user_id, 'suspended', v_reason,
    p_stripe_dispute_id, p_payment_intent_id, p_local_transaction_id,
    p_amount_cents, p_dispute_created_at, v_prev_status, NULL
  )
  ON CONFLICT (stripe_dispute_id) WHERE event_type = 'suspended'
  DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN jsonb_build_object('already_suspended', true, 'user_id', p_user_id);
  END IF;

  UPDATE public.licenses
  SET status = 'suspended', updated_at = now()
  WHERE user_id = p_user_id;

  PERFORM public.log_admin_action(
    'account.suspend',
    'user',
    p_user_id::text,
    jsonb_build_object(
      'reason', v_reason,
      'stripe_dispute_id', p_stripe_dispute_id,
      'stripe_payment_intent_id', p_payment_intent_id,
      'local_transaction_id', p_local_transaction_id,
      'amount_cents', p_amount_cents,
      'previous_license_status', v_prev_status,
      'suspension_event_id', v_event_id,
      'source', 'stripe_webhook'
    )
  );

  RETURN jsonb_build_object(
    'already_suspended', false,
    'user_id', p_user_id,
    'suspension_event_id', v_event_id,
    'previous_license_status', v_prev_status
  );
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

-- Production EXECUTE grants (proacl, 2026-10-12).
REVOKE ALL ON FUNCTION public.suspend_account_for_dispute(uuid, text, text, text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_account_for_dispute(uuid, text, text, text, integer, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.admin_update_license(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_license(uuid, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.reinstate_suspended_account(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reinstate_suspended_account(uuid, text) TO authenticated, service_role;

-- Production prosrc md5s (2026-10-12) of every body a control depends on.
SELECT pg_temp.check('venue: ' || v.fn || ' body = production', md5(p.prosrc) = v.md5, v.fn || ' md5 ' || coalesce(md5(p.prosrc), '<missing>'))
  FROM (VALUES ('suspend_account_for_dispute', '1975ad506d88edc75b3ba9835d03eac9'),
               ('admin_update_license',        'ab793576ab168fec56e30d428cfc0514'),
               ('reinstate_suspended_account', '8c3026b70a4c7a67d248f15640f3dc78'),
               ('admin_suspend_user',          'c626b20ccdd9e6fc2595b3b33ca07bc6'),
               ('admin_unsuspend_user',        '25b70a3e30d2f029a920844097342248'),
               ('log_admin_action',            'df1ef32e483bab95212c7525be8c5fb2'),
               ('has_internal_role',           'e05a0db9fcbbb8d19bc8c17cc9e24ed7')) v(fn, md5)
  LEFT JOIN pg_proc p ON p.proname = v.fn AND p.pronamespace = 'public'::regnamespace;
