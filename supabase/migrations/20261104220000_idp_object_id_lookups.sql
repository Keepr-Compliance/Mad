-- BACKLOG-4034: look up Keepr accounts by the Entra tenant id + object id that Supabase Auth
-- stores on the azure identity (auth.identities.identity_data -> 'custom_claims' ->> 'tid' / 'oid').
--
-- Two lookups for the directory-sync and scim Edge Functions (service_role only):
--   idp_object_ids_for_users(uuid[], text)  one row per given user with an azure identity in the tenant
--   user_id_for_idp_object_id(text, text)   the single user with that (tenant, object id), else NULL
-- Both compare lower(btrim()) on tenant and object id, read auth.identities.identity_data only,
-- and return an id only when a public.users row with that id exists.
-- Idempotent; no transaction control inside (the runner wraps the file).

-- 1 ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_id_for_idp_object_id(p_tenant_id text, p_object_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tid text := lower(btrim(p_tenant_id));
  v_oid text := lower(btrim(p_object_id));
  v_ids uuid[];
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF v_tid IS NULL OR v_tid = '' OR v_oid IS NULL OR v_oid = '' THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(DISTINCT i.user_id) INTO v_ids
    FROM auth.identities i
   WHERE i.provider = 'azure'
     AND lower(btrim(i.identity_data -> 'custom_claims' ->> 'tid')) = v_tid
     AND lower(btrim(i.identity_data -> 'custom_claims' ->> 'oid')) = v_oid;

  IF cardinality(v_ids) = 1 THEN
    RETURN (SELECT u.id FROM public.users u WHERE u.id = v_ids[1]);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.user_id_for_idp_object_id(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_id_for_idp_object_id(text, text) TO service_role;

-- 2 ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.idp_object_ids_for_users(p_user_ids uuid[], p_tenant_id text)
 RETURNS TABLE(user_id uuid, object_id text)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tid text := lower(btrim(p_tenant_id));
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF v_tid IS NULL OR v_tid = '' OR p_user_ids IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (i.user_id)
         i.user_id,
         lower(btrim(i.identity_data -> 'custom_claims' ->> 'oid'))
    FROM auth.identities i
   WHERE i.provider = 'azure'
     AND i.user_id = ANY (p_user_ids)
     AND lower(btrim(i.identity_data -> 'custom_claims' ->> 'tid')) = v_tid
     AND NULLIF(btrim(i.identity_data -> 'custom_claims' ->> 'oid'), '') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = i.user_id)
   ORDER BY i.user_id, i.updated_at DESC NULLS LAST;
END;
$function$;

REVOKE ALL ON FUNCTION public.idp_object_ids_for_users(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idp_object_ids_for_users(uuid[], text) TO service_role;
