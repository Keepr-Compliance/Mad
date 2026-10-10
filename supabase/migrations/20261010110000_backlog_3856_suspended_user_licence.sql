-- BACKLOG-3856: a licence created for a suspended user is created suspended.
-- Body transcribed from the live production definition (prosrc md5
-- f5f432e32c93707a74002363b99bd18c, identical to the BACKLOG-3611 file).
-- Only change: the inserted status follows public.users.status. Identity guard,
-- ON CONFLICT DO NOTHING (an existing row is returned untouched), return type,
-- SECURITY DEFINER, search_path and EXECUTE grants are unchanged.
-- create_trial_license delegates to this function and is covered by it.

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
$function$
;

REVOKE EXECUTE ON FUNCTION public.create_active_individual_license(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO authenticated, service_role;
