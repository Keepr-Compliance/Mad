-- BACKLOG-3962 PR4a: who auto-joins a brokerage at sign-in (JIT), and the brokerage's switch that
-- stops people on its verified domain from starting their own Keepr account.
--
-- jit_join_organization(text, text)   replaced; still granted to authenticated
--   After the identity and fresh-sign-in checks (unchanged), in this order:
--     1. the brokerage is resolved: Microsoft by tenant (as before); Google by the brokerage that
--        holds a VERIFIED domain claim equal to the Workspace domain (organizations.google_domain
--        is no longer read: nothing writes it);
--     2. a row in that brokerage                       -> success, already_member (as before);
--     3. a row in any other brokerage, any status      -> already_placed;
--     4. any licences row or any organization_members row (a personal account, or a former
--        member)                                        -> existing_account. Only a brand-new
--        person is joined automatically; an existing account moves through domain capture;
--     5. no brokerage, or no VERIFIED claim at that brokerage equal to the domain of the
--        account's own email (for Google, the Workspace domain must also equal it)
--                                                       -> domain_not_verified;
--     6. the org toggle, plan feature and billing gates, then the insert (as before).
--   Step 4 comes before step 5 so an existing account learns nothing about which domains are
--   verified.
--
-- jit_join_organization(text)          dropped (the old one-argument form; server role only, no
--   caller in the repo). IF EXISTS: a database where it is already gone applies cleanly.
--
-- domain_claims.block_solo_signups     new, default false. Only a VERIFIED claim with it on
--   blocks anything; when the claim stops being verified the block stops with it.
--
-- _solo_signup_block_org(uuid) -> text internal (no client role; SECURITY INVOKER: it runs with
--   the rights of the definer functions that call it, and a client could not read auth.users
--   through it even if it were granted)
--   The name of the brokerage whose verified claim, with block_solo_signups on, equals the
--   domain of the user's own auth email (exact match, as _normalize_claim_domain stores it; a
--   subdomain is not the domain). NULL when the user is exempt: a row in any brokerage, any
--   status, or an unclaimed invitation for the user's email that has not expired (the predicate
--   of _ensure_personal_organization_for).
--
-- create_active_individual_license(uuid)   replaced; ACL kept (postgres, authenticated, server role)
--   Before creating a NEW licence row: if the user named by p_user_id (never the caller) is
--   blocked, raise P0001 'domain_managed' with the brokerage name in DETAIL. Only the server role
--   is exempt; staff calling it for another user are gated on that user's email.
--
-- ensure_personal_organization()           replaced; ACL kept
--   A caller with no licences row and no personal organization, on a blocked domain, gets
--   {status: 'domain_managed', organization_name}. Licence holders are unchanged.
--   _ensure_personal_organization_for (and the deactivated-member revert that calls it) unchanged.
--
-- domain_claim_set_block_solo(uuid, boolean) -> jsonb   granted to authenticated
--   An admin of the claim's organization turns the switch on (verified claims only) or off.
--
-- caller_domain_managed() -> jsonb         granted to authenticated
--   {blocked, organization_name, domain} for the caller's OWN account only, with the same answer
--   as the licence gate (a licence holder is never blocked). It takes no argument: a domain-to-
--   brokerage lookup for any domain would tell anyone which brokerage verified it.
--
-- Rollback: supabase/tests/backlog-3962/rollback-3962-pr4a.sql.
-- Harness: supabase/tests/backlog-3962/controls-pr4a.sql (compose-pr4a.py).

DO $guard$
BEGIN
  IF to_regclass('public.domain_claims') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: public.domain_claims does not exist (20261112100000 first)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.domain_claims'::regclass
                AND attname = 'block_solo_signups' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: domain_claims.block_solo_signups already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('_solo_signup_block_org', 'domain_claim_set_block_solo', 'caller_domain_managed')) THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: a new function already exists';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.jit_join_organization(text, text)'))
     IS DISTINCT FROM 'b8823ca1ec3a9d31daa353ad5116b611' THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: jit_join_organization(text, text) is not the body this replaces';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.create_active_individual_license(uuid)'))
     IS DISTINCT FROM '444a6fb65e16149252aa5aae5abb7dfb' THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: create_active_individual_license(uuid) is not the body this replaces';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.ensure_personal_organization()'))
     IS DISTINCT FROM 'd3440c655d21cecd796854f162954a7c' THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: ensure_personal_organization() is not the body this replaces';
  END IF;
END
$guard$;

ALTER TABLE public.domain_claims ADD COLUMN block_solo_signups boolean NOT NULL DEFAULT false;

DROP FUNCTION IF EXISTS public.jit_join_organization(text);

-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public._solo_signup_block_org(p_user uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_email text;
  v_domain text;
  v_name text;
BEGIN
  IF p_user IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT btrim(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user;
  IF v_email IS NULL OR v_email = '' THEN
    RETURN NULL;
  END IF;
  v_domain := public._normalize_claim_domain(substring(v_email FROM '@([^@]+)$'));
  IF v_domain IS NULL THEN
    RETURN NULL;
  END IF;

  -- Exempt: a row in any brokerage, whatever its status.
  IF EXISTS (SELECT 1 FROM public.organization_members m
               JOIN public.organizations o ON o.id = m.organization_id
              WHERE m.user_id = p_user AND o.personal_owner_user_id IS NULL) THEN
    RETURN NULL;
  END IF;
  -- Exempt: an unclaimed invitation that has not expired (same predicate as
  -- _ensure_personal_organization_for).
  IF EXISTS (SELECT 1 FROM public.organization_members
              WHERE user_id IS NULL
                AND lower(btrim(invited_email)) = lower(v_email)
                AND (invitation_expires_at IS NULL OR invitation_expires_at >= now())) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(nullif(btrim(o.name), ''), 'Your brokerage') INTO v_name
    FROM public.domain_claims c
    JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.domain = v_domain
     AND c.status = 'verified'
     AND c.block_solo_signups
     AND o.personal_owner_user_id IS NULL
   ORDER BY c.verified_at, c.id
   LIMIT 1;
  RETURN v_name;
END
$function$;

REVOKE EXECUTE ON FUNCTION public._solo_signup_block_org(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.caller_domain_managed()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
  v_domain text;
BEGIN
  IF v_uid IS NULL OR EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = v_uid) THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;
  v_name := public._solo_signup_block_org(v_uid);
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;
  SELECT lower(substring(btrim(u.email) FROM '@([^@]+)$')) INTO v_domain FROM auth.users u WHERE u.id = v_uid;
  RETURN jsonb_build_object('blocked', true, 'organization_name', v_name, 'domain', v_domain);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.caller_domain_managed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_domain_managed() TO authenticated;

-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.domain_claim_set_block_solo(p_claim uuid, p_on boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.domain_claims;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_claim IS NULL OR p_on IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_input');
  END IF;
  SELECT * INTO v_row FROM public.domain_claims c WHERE c.id = p_claim FOR UPDATE;
  -- Not found and not yours read the same.
  IF NOT FOUND OR NOT public.is_org_admin(v_uid, v_row.organization_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF p_on AND v_row.status <> 'verified' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_verified');
  END IF;
  UPDATE public.domain_claims
     SET block_solo_signups = p_on, updated_at = now()
   WHERE id = v_row.id;
  RETURN jsonb_build_object('success', true, 'claim_id', v_row.id, 'block_solo_signups', p_on);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.domain_claim_set_block_solo(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.domain_claim_set_block_solo(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_active_individual_license(p_user_id uuid)
 RETURNS licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_license public.licenses; v_key text; v_user_status text; v_block text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND (auth.uid() IS NULL
          OR (p_user_id IS DISTINCT FROM auth.uid() AND NOT (public.has_internal_role(auth.uid())
                                                    AND public.has_permission(auth.uid(), 'licenses.edit')))) THEN
    RAISE EXCEPTION 'Not allowed for this user' USING ERRCODE = '42501';
  END IF;
  -- BACKLOG-3962 PR4a: a NEW licence for a person on a brokerage domain that blocks solo
  -- sign-ups is refused. Keyed on p_user_id (staff call this for other people); only the server
  -- role is exempt.
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = p_user_id) THEN
    v_block := public._solo_signup_block_org(p_user_id);
    IF v_block IS NOT NULL THEN
      RAISE EXCEPTION 'domain_managed' USING ERRCODE = 'P0001', DETAIL = v_block;
    END IF;
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

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_personal_organization()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
  v_block text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'not_authenticated');
  END IF;
  -- BACKLOG-3962 PR4a: someone with no licence and no personal organization, on a brokerage
  -- domain that blocks solo sign-ups. Licence holders are never stopped here.
  IF NOT EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = v_uid)
     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.personal_owner_user_id = v_uid) THEN
    v_block := public._solo_signup_block_org(v_uid);
    IF v_block IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'domain_managed', 'organization_name', v_block);
    END IF;
  END IF;
  v_res := public._ensure_personal_organization_for(v_uid);
  -- BACKLOG-3860: free trial for a new solo agent. Own sub-transaction: a failure
  -- rolls back only the trial and never blocks the personal organization.
  IF v_res ->> 'status' = 'created' THEN
    BEGIN
      PERFORM public._start_solo_trial_for(v_uid);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ensure_personal_organization: solo trial not started for % (%: %)',
        v_uid, SQLSTATE, SQLERRM;
    END;
  END IF;
  RETURN v_res;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jit_join_organization(p_provider_type text, p_identifier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ident text := lower(btrim(coalesce(p_identifier, '')));
  v_sid text := nullif(auth.jwt() ->> 'session_id', '');
  v_org public.organizations%ROWTYPE;
  v_role text;
  v_existing text;
  v_provider text;
  v_claim text;
  v_oauth_id text;
  v_identity_at timestamptz;
  v_signin_at timestamptz;
  v_email_domain text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_provider_type = 'azure_ad' THEN
    IF v_ident = '9188040d-6c67-4c5b-b112-36a304b66dad' THEN -- pii-allow-uuid: Microsoft's public personal-account tenant constant
      RETURN jsonb_build_object('success', false, 'error', 'consumer_tenant');
    END IF;
    v_provider := 'azure';
    v_claim := 'tid';
  ELSIF p_provider_type = 'google_workspace' THEN
    IF v_ident IN ('', 'gmail.com', 'googlemail.com') THEN
      RETURN jsonb_build_object('success', false, 'error', 'consumer_domain');
    END IF;
    v_provider := 'google';
    v_claim := 'hd';
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'unsupported_provider');
  END IF;

  -- The tenant / domain must be one the caller's own Microsoft / Google identity carries.
  -- identity_data is written by the auth server from the provider token, never by the user.
  SELECT i.provider_id, i.updated_at INTO v_oauth_id, v_identity_at
    FROM auth.identities i
   WHERE i.user_id = v_uid AND i.provider = v_provider
     AND lower(i.identity_data -> 'custom_claims' ->> v_claim) = v_ident
   ORDER BY i.updated_at DESC
   LIMIT 1;
  IF v_oauth_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'identity_mismatch');
  END IF;

  -- ... and that identity must come from an OAuth sign-in made in THIS session within the last
  -- 15 minutes: a password session, or a long-lived session refreshed after the person left the
  -- tenant, does not count. The auth server writes the identity just before the session's
  -- 'oauth' claim, so the identity must be no older than that claim minus 60 seconds.
  SELECT max(c.updated_at) INTO v_signin_at
    FROM auth.mfa_amr_claims c
    JOIN auth.sessions s ON s.id = c.session_id
   WHERE c.session_id::text = v_sid
     AND s.user_id = v_uid
     AND c.authentication_method = 'oauth'
     AND c.updated_at > now() - interval '15 minutes';
  IF v_signin_at IS NULL
     OR v_identity_at IS NULL
     OR v_identity_at < v_signin_at - interval '60 seconds' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reauth_required');
  END IF;

  -- BACKLOG-3962 PR4a: Microsoft by tenant; Google by the brokerage holding a VERIFIED claim on
  -- the Workspace domain. May find nothing; that is answered at step 5, after the account checks.
  IF v_provider = 'azure' THEN
    SELECT * INTO v_org FROM public.organizations o
     WHERE o.personal_owner_user_id IS NULL
       AND lower(o.microsoft_tenant_id) = v_ident
     ORDER BY o.created_at
     LIMIT 1;
  ELSE
    SELECT o.* INTO v_org FROM public.organizations o
      JOIN public.domain_claims c ON c.organization_id = o.id
     WHERE o.personal_owner_user_id IS NULL
       AND c.status = 'verified'
       AND c.domain = v_ident
     ORDER BY c.verified_at, c.id
     LIMIT 1;
  END IF;

  IF v_org.id IS NOT NULL THEN
    SELECT m.role INTO v_existing FROM public.organization_members m
     WHERE m.organization_id = v_org.id AND m.user_id = v_uid;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'organization_id', v_org.id, 'role', v_existing, 'already_member', true);
    END IF;
  END IF;

  -- A row in another brokerage, whatever its status.
  IF EXISTS (SELECT 1 FROM public.organization_members m
               JOIN public.organizations o ON o.id = m.organization_id
              WHERE m.user_id = v_uid AND o.personal_owner_user_id IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_placed');
  END IF;

  -- Only a brand-new person joins automatically: no licence and no membership of any kind.
  IF EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = v_uid)
     OR EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_uid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'existing_account');
  END IF;

  -- The brokerage must hold a VERIFIED claim equal to the domain of the account's own email
  -- (exact match); for Google the Workspace domain must be that same domain.
  SELECT public._normalize_claim_domain(substring(btrim(u.email) FROM '@([^@]+)$')) INTO v_email_domain
    FROM auth.users u WHERE u.id = v_uid;
  IF v_org.id IS NULL
     OR v_email_domain IS NULL
     OR (v_provider = 'google' AND v_email_domain IS DISTINCT FROM v_ident)
     OR NOT EXISTS (SELECT 1 FROM public.domain_claims c
                     WHERE c.organization_id = v_org.id
                       AND c.status = 'verified'
                       AND c.domain = v_email_domain) THEN
    RETURN jsonb_build_object('success', false, 'error', 'domain_not_verified');
  END IF;

  -- Both gates: the org's own toggle (client-writable) AND the plan feature (staff-set).
  IF NOT coalesce(v_org.jit_provisioning_enabled, false)
     OR NOT public._org_feature_allowed(v_org.id, 'jit_provisioning') THEN
    RETURN jsonb_build_object('success', false, 'error', 'jit_disabled');
  END IF;
  IF public._billing_org_join_blocked(v_org.id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_setup_pending');
  END IF;

  -- Auto-join never grants admin (BACKLOG-3096).
  v_role := CASE WHEN v_org.default_member_role IN ('agent', 'broker') THEN v_org.default_member_role ELSE 'agent' END;

  INSERT INTO public.users (id, email, oauth_provider, oauth_id, provisioning_source, jit_provisioned, jit_provisioned_at)
  SELECT v_uid, u.email, v_provider, v_oauth_id, 'jit', true, now() FROM auth.users u WHERE u.id = v_uid
  ON CONFLICT (id) DO UPDATE SET
    provisioning_source = CASE WHEN public.users.provisioning_source = 'manual' THEN 'jit' ELSE public.users.provisioning_source END,
    jit_provisioned = true,
    jit_provisioned_at = coalesce(public.users.jit_provisioned_at, now());

  -- The seat trigger turns an over-limit JIT join into 'unassigned' (BACKLOG-3851).
  INSERT INTO public.organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by, provisioned_at)
  VALUES (v_org.id, v_uid, v_role, now(), 'active', 'jit', now());

  RETURN jsonb_build_object('success', true, 'organization_id', v_org.id, 'role', v_role, 'already_member', false);
END
$function$;

-- The name-based DROP above leaves this signature alone; restated so the file carries its grants.
REVOKE EXECUTE ON FUNCTION public.jit_join_organization(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jit_join_organization(text, text) TO authenticated;

-- POSTCHECK BEGIN
DO $post$
DECLARE
  f text;
BEGIN
  -- Client functions: authenticated yes, anon no, definer with an empty search_path.
  FOREACH f IN ARRAY ARRAY['public.caller_domain_managed()', 'public.domain_claim_set_block_solo(uuid, boolean)',
                           'public.jit_join_organization(text, text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962 PR4a: anon can execute %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962 PR4a: authenticated cannot execute %', f;
    END IF;
  END LOOP;
  -- Internal: no client role.
  f := 'public._solo_signup_block_org(uuid)';
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: a client role can execute %', f;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public._solo_signup_block_org(uuid)'::regprocedure
                   AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']) THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: _solo_signup_block_org is not SECURITY INVOKER with an empty search_path';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.caller_domain_managed()',
                           'public.domain_claim_set_block_solo(uuid, boolean)', 'public.jit_join_organization(text, text)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure
                     AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION 'BACKLOG-3962 PR4a: % is not SECURITY DEFINER with an empty search_path', f;
    END IF;
  END LOOP;
  -- Replaced functions keep their grants: authenticated and the server role, never anon.
  FOREACH f IN ARRAY ARRAY['public.create_active_individual_license(uuid)', 'public.ensure_personal_organization()'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure AND p.prosecdef) THEN
      RAISE EXCEPTION 'BACKLOG-3962 PR4a: % lost its grants or SECURITY DEFINER', f;
    END IF;
  END LOOP;
  IF to_regprocedure('public.jit_join_organization(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: jit_join_organization(text) still exists';
  END IF;
  IF has_table_privilege('anon', 'public.domain_claims', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'TRUNCATE')
     OR has_column_privilege('authenticated', 'public.domain_claims', 'block_solo_signups', 'UPDATE')
     OR has_column_privilege('anon', 'public.domain_claims', 'block_solo_signups', 'SELECT') THEN
    RAISE EXCEPTION 'BACKLOG-3962 PR4a: a client role can write or empty domain_claims';
  END IF;
END
$post$;
-- POSTCHECK END
