-- BACKLOG-3611: license-writing functions act only on the caller's own user id.
-- Allowed: the caller's own id, an internal_roles caller, or service_role.
-- EXECUTE removed from PUBLIC and anon; authenticated and service_role keep it.

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

CREATE OR REPLACE FUNCTION public.increment_transaction_count(p_user_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_count INTEGER;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND (auth.uid() IS NULL
          OR (p_user_id IS DISTINCT FROM auth.uid() AND NOT public.has_internal_role(auth.uid()))) THEN
    RAISE EXCEPTION 'Not allowed for this user' USING ERRCODE = '42501';
  END IF;
  UPDATE public.licenses
  SET transaction_count = transaction_count + 1,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING transaction_count INTO v_new_count;

  RETURN COALESCE(v_new_count, 0);
END;
$function$
;

REVOKE EXECUTE ON FUNCTION public.create_active_individual_license(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.increment_transaction_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_transaction_count(uuid) TO authenticated, service_role;
