-- BACKLOG-3857: 'trial' is no longer a license type.
--
-- 1. Pre-check: abort if any licenses row has license_type 'trial', or if
--    admin_update_license is neither the expected prior body nor this one.
-- 2. licenses_license_type_check allows only 'individual' and 'team'.
-- 3. Defaults: license_type 'individual'; trial_status, trial_started_at and
--    trial_expires_at have no default (NULL).
-- 4. admin_update_license refuses license_type 'trial' with SQLSTATE 22023.
--    The function body is the production body (md5 7e27a1d38e49eec91def8d2cc584bf3e)
--    with only that guard added. Signature, SECURITY DEFINER and search_path
--    are unchanged.
-- 5. EXECUTE on admin_update_license is revoked from PUBLIC and anon; the
--    postgres, authenticated and service_role grants are kept.
--
-- create_trial_license is not changed.
-- Re-running this file is a no-op. Rollback: supabase/tests/backlog-3857/rollback-3857.sql

DO $pre$
DECLARE v_md5 text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.licenses WHERE license_type = 'trial') THEN
    RAISE EXCEPTION '3857 pre-check: % licenses row(s) have license_type trial',
      (SELECT count(*) FROM public.licenses WHERE license_type = 'trial');
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.admin_update_license(uuid,jsonb)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('7e27a1d38e49eec91def8d2cc584bf3e', 'ab793576ab168fec56e30d428cfc0514') THEN
    RAISE EXCEPTION '3857 pre-check: admin_update_license body differs from the expected one (md5 %)', v_md5;
  END IF;
END $pre$;

ALTER TABLE public.licenses DROP CONSTRAINT IF EXISTS licenses_license_type_check;
ALTER TABLE public.licenses ADD CONSTRAINT licenses_license_type_check
  CHECK (license_type = ANY (ARRAY['individual'::text, 'team'::text]));

ALTER TABLE public.licenses ALTER COLUMN license_type SET DEFAULT 'individual';
ALTER TABLE public.licenses ALTER COLUMN trial_status DROP DEFAULT;
ALTER TABLE public.licenses ALTER COLUMN trial_started_at DROP DEFAULT;
ALTER TABLE public.licenses ALTER COLUMN trial_expires_at DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.admin_update_license(p_license_id uuid, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_update_license(uuid, jsonb) FROM PUBLIC, anon;
