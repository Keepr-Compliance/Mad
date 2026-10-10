-- BACKLOG-3856 rollback: restores the pre-3856 body of
-- public.create_active_individual_license (BACKLOG-3611 text, prosrc md5
-- f5f432e32c93707a74002363b99bd18c). Grants are not changed by either file.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_active_individual_license(p_user_id uuid)
 RETURNS licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_license public.licenses; v_key text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND (auth.uid() IS NULL
          OR (p_user_id IS DISTINCT FROM auth.uid() AND NOT public.has_internal_role(auth.uid()))) THEN
    RAISE EXCEPTION 'Not allowed for this user' USING ERRCODE = '42501';
  END IF;
  v_key := 'IND-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.licenses (user_id, license_key, license_type, status, trial_status, trial_started_at, trial_expires_at, expires_at, max_devices, transaction_limit)
  VALUES (p_user_id, v_key, 'individual', 'active', NULL, NULL, NULL, NULL, 2, 99999)
  ON CONFLICT (user_id) DO NOTHING
  RETURNING * INTO v_license;
  IF v_license IS NULL THEN SELECT * INTO v_license FROM public.licenses WHERE user_id = p_user_id; END IF;
  RETURN v_license;
END;
$function$
;

DO $verify$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.create_active_individual_license(uuid)'::regprocedure)
     <> 'f5f432e32c93707a74002363b99bd18c' THEN
    RAISE EXCEPTION 'rollback verify: prosrc fingerprint differs';
  END IF;
END $verify$;

COMMIT;
