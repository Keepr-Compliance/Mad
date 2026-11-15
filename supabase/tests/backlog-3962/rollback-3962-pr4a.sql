-- BACKLOG-3962 PR4a rollback: puts back what 20261112120000 replaced and removes what it added.
-- Bodies are the keepr-test bodies the migration pins (md5(prosrc) b8823ca1..., 444a6fb6...,
-- d3440c65...) and the one-argument jit_join_organization it dropped (ff35f6a6..., server role only).

DROP FUNCTION IF EXISTS public.caller_domain_managed();
DROP FUNCTION IF EXISTS public.domain_claim_set_block_solo(uuid, boolean);

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

  SELECT * INTO v_org FROM public.organizations o
   WHERE o.personal_owner_user_id IS NULL
     AND ((v_provider = 'azure' AND lower(o.microsoft_tenant_id) = v_ident)
          OR (v_provider = 'google' AND lower(o.google_domain) = v_ident))
   ORDER BY o.created_at
   LIMIT 1;
  IF v_org.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_found');
  END IF;

  SELECT m.role INTO v_existing FROM public.organization_members m
   WHERE m.organization_id = v_org.id AND m.user_id = v_uid;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'organization_id', v_org.id, 'role', v_existing, 'already_member', true);
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

CREATE OR REPLACE FUNCTION public.ensure_personal_organization()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'not_authenticated');
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

DROP FUNCTION IF EXISTS public._solo_signup_block_org(uuid);
ALTER TABLE public.domain_claims DROP COLUMN IF EXISTS block_solo_signups;

-- The old body carries Microsoft's consumer-tenant constant with no comment of its own; it is put
-- back at EXECUTE time so the restored prosrc is byte for byte the pinned one (ff35f6a6...).
DO $rb$
BEGIN
  EXECUTE replace($def$CREATE OR REPLACE FUNCTION public.jit_join_organization(p_tenant_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_id UUID;
  v_user_email TEXT;
  v_oauth_id TEXT;
  v_org_id UUID;
  v_org_role TEXT;
  v_jit_enabled BOOLEAN;
BEGIN
  -- Get the authenticated user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- Defense-in-depth: Block consumer tenant (personal Microsoft accounts)
  IF p_tenant_id = '__MS_CONSUMER_TENANT__' THEN
    RETURN jsonb_build_object('success', false, 'error', 'consumer_tenant');
  END IF;

  -- Look up organization by microsoft_tenant_id
  SELECT id, COALESCE(default_member_role, 'agent'), COALESCE(jit_provisioning_enabled, true)
  INTO v_org_id, v_org_role, v_jit_enabled
  FROM organizations
  WHERE microsoft_tenant_id = p_tenant_id;

  -- If org not found, return error
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_found');
  END IF;

  -- Check if user already has a membership (allow existing members regardless of JIT toggle)
  IF EXISTS (
    SELECT 1 FROM organization_members
    WHERE user_id = v_user_id AND organization_id = v_org_id
  ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'organization_id', v_org_id,
      'role', (SELECT role FROM organization_members WHERE user_id = v_user_id AND organization_id = v_org_id),
      'already_member', true
    );
  END IF;

  -- If JIT is disabled, reject new users (they must be invited or SCIM-provisioned)
  IF NOT v_jit_enabled THEN
    RETURN jsonb_build_object('success', false, 'error', 'jit_disabled');
  END IF;

  -- Get user email with fallback chain
  SELECT
    COALESCE(
      email,
      raw_user_meta_data->>'email',
      raw_user_meta_data->>'mail',
      raw_user_meta_data->>'preferred_username'
    ),
    raw_user_meta_data->>'provider_id'
  INTO v_user_email, v_oauth_id
  FROM auth.users
  WHERE id = v_user_id;

  IF v_oauth_id IS NULL THEN
    v_oauth_id := v_user_id::text;
  END IF;

  -- Ensure user exists in public.users table
  INSERT INTO users (id, email, oauth_provider, oauth_id, provisioning_source, jit_provisioned, jit_provisioned_at)
  VALUES (v_user_id, v_user_email, 'azure', v_oauth_id, 'jit', true, NOW())
  ON CONFLICT (id) DO UPDATE SET
    provisioning_source = CASE
      WHEN users.provisioning_source = 'manual' THEN 'jit'
      ELSE users.provisioning_source
    END,
    jit_provisioned = true,
    jit_provisioned_at = COALESCE(users.jit_provisioned_at, NOW());

  -- Create membership with org's default role
  INSERT INTO organization_members (
    organization_id, user_id, role, joined_at,
    license_status, provisioned_by, provisioned_at
  )
  VALUES (
    v_org_id, v_user_id, v_org_role, NOW(),
    'active', 'jit', NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', v_org_id,
    'role', v_org_role,
    'already_member', false
  );
END;
$function$$def$,
    '__MS_CONSUMER_TENANT__',
    '9188040d-6c67-4c5b-b112-36a304b66dad'); -- pii-allow-uuid: Microsoft's public personal-account tenant constant
END
$rb$;
REVOKE EXECUTE ON FUNCTION public.jit_join_organization(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jit_join_organization(text) TO service_role;
