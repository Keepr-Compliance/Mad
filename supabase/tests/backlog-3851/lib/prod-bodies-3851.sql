-- BACKLOG-3851: bring the venue to production for every object lib/fingerprint-3851.sql reads
-- that the 3917/3938/3946 layers leave different. Bodies are production's pg_get_functiondef
-- output, read 2026-10-14 via Supabase MCP at ledger head 20261014152904. pins-3851.sql proves
-- the venue then equals production's fingerprint; a transcription slip fails there, not later.

-- organizations.is_test (production column the venue lacks).
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- CHECKs re-created in the form whose deparse equals production's (an IN list on varchar).
ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_license_status_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_license_status_check
  CHECK (license_status IN ('pending', 'active', 'suspended', 'expired'));
ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_role_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_role_check
  CHECK (role IN ('agent', 'broker', 'admin', 'it_admin'));

CREATE OR REPLACE FUNCTION public._override_effective(o jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_raw jsonb;
  v_s   text;
BEGIN
  v_raw := o -> 'paid_through';
  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(v_raw) <> 'string' THEN
    RETURN false;
  END IF;
  v_s := v_raw #>> '{}';
  IF v_s !~ '^\d{4}-\d{2}-\d{2}T' THEN
    RETURN false;
  END IF;
  IF NOT pg_input_is_valid(v_s, 'timestamptz') THEN
    RETURN false;
  END IF;
  RETURN v_s::timestamptz > now();
END
$function$
;
REVOKE ALL ON FUNCTION public._override_effective(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._override_effective(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.get_org_features(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_plan RECORD;
  v_has_plan BOOLEAN := false;
  v_result JSONB := '{}';
  v_feature RECORD;
  v_plan_feature RECORD;
  v_override JSONB;
  v_enabled BOOLEAN;
  v_value TEXT;
  v_source TEXT;
  v_blocked BOOLEAN;
BEGIN
  -- Verify caller is a member of the organization
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid() AND organization_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('error', 'not_authorized', 'features', '[]'::jsonb);
  END IF;

  -- Get org's plan
  SELECT op.*, p.name as plan_name, p.tier as plan_tier INTO v_org_plan
  FROM public.organization_plans op
  JOIN public.plans p ON p.id = op.plan_id
  WHERE op.organization_id = p_org_id;

  v_has_plan := FOUND;

  -- Iterate all features
  FOR v_feature IN SELECT * FROM public.feature_definitions ORDER BY sort_order, key
  LOOP
    v_enabled := v_feature.default_value = 'true';
    v_value := v_feature.default_value;
    v_source := 'default';
    v_blocked := false;

    IF v_has_plan THEN
      -- Check per-org override first
      v_override := v_org_plan.feature_overrides -> v_feature.key;
      -- BACKLOG-3845: an expired or malformed paid_through makes the override absent.
      IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN
        v_override := NULL;
      END IF;
      v_blocked := v_override IS NOT NULL
                   AND public._override_above_tier(v_feature.key, v_feature.min_tier, v_org_plan.plan_tier, v_override);
      IF v_override IS NOT NULL AND NOT v_blocked THEN
        v_enabled := COALESCE((v_override ->> 'enabled')::boolean, true);
        v_value := COALESCE(v_override ->> 'value', v_feature.default_value);
        v_source := 'override';
      ELSE
        -- Check plan-level feature
        SELECT * INTO v_plan_feature
        FROM public.plan_features pf
        WHERE pf.plan_id = v_org_plan.plan_id
          AND pf.feature_id = v_feature.id;

        IF FOUND THEN
          v_enabled := v_plan_feature.enabled;
          v_value := COALESCE(v_plan_feature.value, v_feature.default_value);
          v_source := 'plan';
        END IF;
      END IF;
    END IF;

    v_result := v_result || jsonb_build_object(
      v_feature.key, jsonb_build_object(
        'enabled', v_enabled,
        'value', v_value,
        'value_type', v_feature.value_type,
        'name', v_feature.name,
        'source', v_source
      ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'plan_name', COALESCE(v_org_plan.plan_name, 'none'),
    'plan_tier', COALESCE(v_org_plan.plan_tier, 'none'),
    'features', v_result
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_pending_invite()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_email TEXT;
  v_invite RECORD;
  v_existing_membership UUID;
  v_existing_role TEXT;
  v_provider TEXT;
  v_oauth_id TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Get user email with fallback chain (matches auto_provision_it_admin pattern)
  SELECT
    COALESCE(
      NULLIF(TRIM(email), ''),
      NULLIF(TRIM(raw_user_meta_data->>'email'), ''),
      raw_user_meta_data->>'mail',
      raw_user_meta_data->>'preferred_username'
    ),
    COALESCE(raw_app_meta_data->>'provider', 'email'),
    COALESCE(raw_user_meta_data->>'provider_id', v_user_id::text)
  INTO v_email, v_provider, v_oauth_id
  FROM auth.users
  WHERE id = v_user_id;

  IF v_email IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No email found');
  END IF;

  -- Find pending invite by email (case-insensitive)
  SELECT id, role, organization_id, invitation_expires_at
  INTO v_invite
  FROM organization_members
  WHERE LOWER(TRIM(invited_email)) = LOWER(TRIM(v_email))
  AND user_id IS NULL
  LIMIT 1;

  IF v_invite IS NULL THEN
    RETURN jsonb_build_object('success', false);
  END IF;

  -- Check expiry
  IF v_invite.invitation_expires_at IS NOT NULL
     AND v_invite.invitation_expires_at < NOW() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invitation has expired');
  END IF;

  -- Check for existing membership in this org (auto-provisioned duplicate)
  SELECT id, role INTO v_existing_membership, v_existing_role
  FROM organization_members
  WHERE user_id = v_user_id
  AND organization_id = v_invite.organization_id;

  IF v_existing_membership IS NOT NULL THEN
    -- User already has membership (auto-provisioned). Delete the unclaimed invite.
    DELETE FROM organization_members WHERE id = v_invite.id;
    RETURN jsonb_build_object(
      'success', true,
      'role', v_existing_role,
      'organization_id', v_invite.organization_id,
      'note', 'existing_membership_kept'
    );
  END IF;

  -- Ensure user record exists in public.users
  INSERT INTO users (id, email, oauth_provider, oauth_id)
  VALUES (v_user_id, v_email, v_provider, v_oauth_id)
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    updated_at = NOW();

  -- Claim the invite
  UPDATE organization_members
  SET
    user_id = v_user_id,
    license_status = 'active',
    joined_at = NOW(),
    invitation_token = NULL
  WHERE id = v_invite.id;

  RETURN jsonb_build_object(
    'success', true,
    'role', v_invite.role,
    'organization_id', v_invite.organization_id
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.auto_provision_it_admin(p_tenant_id text, p_org_name text, p_org_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_user_email TEXT;
  v_oauth_id TEXT;
  v_org_id UUID;
  v_slug TEXT;
  v_default_role TEXT;
  v_role TEXT;
  v_identity_tid TEXT;
BEGIN
  -- Get the authenticated user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- BACKLOG-3882: the tenant must be one the caller signed in with. Read from
  -- auth.identities (written by the auth server at OAuth sign-in), never from
  -- user metadata. The stored tenant is the identity's value.
  SELECT lower(i.identity_data->'custom_claims'->>'tid')
  INTO v_identity_tid
  FROM auth.identities i
  WHERE i.user_id = v_user_id
    AND i.provider = 'azure'
    AND lower(i.identity_data->'custom_claims'->>'tid') = lower(btrim(p_tenant_id))
  LIMIT 1;

  IF v_identity_tid IS NULL THEN
    RAISE EXCEPTION 'tenant does not match the signed-in identity' USING ERRCODE = '42501';
  END IF;

  IF v_identity_tid = '9188040d-6c67-4c5b-b112-36a304b66dad' THEN -- pii-allow-uuid: Microsoft's public personal-account tenant constant
    RAISE EXCEPTION 'personal Microsoft accounts cannot provision an organization' USING ERRCODE = '42501';
  END IF;

  p_tenant_id := v_identity_tid;

  -- Get user email with fallback chain (SR Engineer C1 fix)
  -- Microsoft may not populate auth.users.email for external tenants
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

  -- Use user_id as fallback for oauth_id if not found
  IF v_oauth_id IS NULL THEN
    v_oauth_id := v_user_id::text;
  END IF;

  -- Try to create organization with ON CONFLICT for TOCTOU race (SR Engineer I3 fix)
  v_slug := p_org_slug;

  INSERT INTO organizations (name, slug, microsoft_tenant_id, plan, max_seats)
  VALUES (p_org_name, v_slug, p_tenant_id, 'trial', 10)
  ON CONFLICT (microsoft_tenant_id) DO NOTHING;

  -- Get the org ID (either just created or already existed)
  SELECT id INTO v_org_id
  FROM organizations
  WHERE microsoft_tenant_id = p_tenant_id;

  -- If org still not found, slug collision may have occurred (SR Engineer I2 fix)
  IF v_org_id IS NULL THEN
    v_slug := p_org_slug || '-' || substr(gen_random_uuid()::text, 1, 6);
    INSERT INTO organizations (name, slug, microsoft_tenant_id, plan, max_seats)
    VALUES (p_org_name, v_slug, p_tenant_id, 'trial', 10)
    ON CONFLICT (microsoft_tenant_id) DO NOTHING;

    SELECT id INTO v_org_id
    FROM organizations
    WHERE microsoft_tenant_id = p_tenant_id;
  END IF;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Failed to create organization');
  END IF;

  -- BACKLOG-3096: lock the organization row BEFORE reading its membership.
  --
  -- Without this, two employees opening /setup in the same second both read
  -- "zero claimed members" and both insert themselves as 'admin' -- the exact
  -- escalation this change exists to close. FOR UPDATE holds the row until
  -- commit, so the second caller blocks, then sees the first caller's row and
  -- resolves to the default role instead.
  --
  -- This one statement does double duty: it takes the lock AND reads the org's
  -- default member role, so there is no second trip to the table. Placing it
  -- before the member-exists check also means a same-user double-fire (a
  -- browser retry) sees the first transaction's row rather than colliding with
  -- the UNIQUE (organization_id, user_id) constraint.
  SELECT COALESCE(default_member_role, 'agent')
  INTO v_default_role
  FROM organizations
  WHERE id = v_org_id
  FOR UPDATE;

  -- Ensure user exists in public.users table with required columns
  INSERT INTO users (id, email, oauth_provider, oauth_id)
  VALUES (v_user_id, v_user_email, 'azure', v_oauth_id)
  ON CONFLICT (id) DO NOTHING;

  -- Check if membership already exists. Reading the role rather than testing
  -- for existence is the same guard -- organization_members.role is NOT NULL,
  -- so v_role IS NULL means "no row" and nothing else -- and it leaves the
  -- caller's ACTUAL role in v_role on the already-a-member path too, which the
  -- return value below needs.
  SELECT role INTO v_role
  FROM organization_members
  WHERE user_id = v_user_id AND organization_id = v_org_id;

  IF v_role IS NULL THEN
    -- BACKLOG-3096: first user wins. 'admin' only when this org has no CLAIMED
    -- member yet. user_id IS NOT NULL is load-bearing: pre-created white-glove
    -- orgs carry unclaimed invite rows (user_id IS NULL) and counting those
    -- would demote the org's own IT admin to 'agent' on arrival.
    v_role := CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM organization_members
                  WHERE organization_id = v_org_id
                    AND user_id IS NOT NULL
                ) THEN 'admin'
                ELSE v_default_role
              END;

    INSERT INTO organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by)
    VALUES (v_org_id, v_user_id, v_role, NOW(), 'active', 'jit');
  END IF;

  -- BACKLOG-3096: 'role' is new, and additive -- existing consumers read
  -- success/organization_id/user_id and are unaffected.
  --
  -- The /setup callback branches on it: only an admin can complete tenant-wide
  -- Microsoft consent, so only an admin continues to /setup/consent. Returning
  -- the role the function ACTUALLY wrote, rather than having the route re-query
  -- for it, means the callback and the database cannot disagree about which
  -- branch was taken -- there is one read, not two.
  RETURN jsonb_build_object(
    'success', true,
    'organization_id', v_org_id,
    'user_id', v_user_id,
    'role', v_role
  );
END;
$function$
;

-- jit_join_organization: production's body holds a constant UUID on a line that cannot carry
-- a comment without changing the body, so the body is built here with that constant
-- substituted in (one waived line below).
DO $jit$ BEGIN EXECUTE replace($body$CREATE OR REPLACE FUNCTION public.jit_join_organization(p_tenant_id text)
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
  IF p_tenant_id = '__CONSUMER_TENANT__' THEN
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
$function$$body$,
  '__CONSUMER_TENANT__', '9188040d-6c67-4c5b-b112-36a304b66dad'); END $jit$; -- pii-allow-uuid: Microsoft's public personal-account tenant constant


CREATE OR REPLACE FUNCTION public.auto_provision_google_it_admin(p_google_domain text, p_org_name text, p_org_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_user_email TEXT;
  v_oauth_id TEXT;
  v_org_id UUID;
  v_slug TEXT;
BEGIN
  -- Get the authenticated user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Get user email with full fallback chain (matching Azure RPC pattern)
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

  -- C2 fix: Guard against NULL email
  IF v_user_email IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Could not determine user email');
  END IF;

  -- Use user_id as fallback for oauth_id if not found
  IF v_oauth_id IS NULL THEN
    v_oauth_id := v_user_id::text;
  END IF;

  -- Try to create organization with ON CONFLICT for race condition safety
  v_slug := p_org_slug;

  INSERT INTO organizations (name, slug, google_domain, plan, max_seats)
  VALUES (p_org_name, v_slug, p_google_domain, 'trial', 10)
  ON CONFLICT (google_domain) DO NOTHING;

  -- Get the org ID (either just created or already existed)
  SELECT id INTO v_org_id
  FROM organizations
  WHERE google_domain = p_google_domain;

  -- If org still not found, slug collision may have occurred
  IF v_org_id IS NULL THEN
    v_slug := p_org_slug || '-' || substr(gen_random_uuid()::text, 1, 6);
    INSERT INTO organizations (name, slug, google_domain, plan, max_seats)
    VALUES (p_org_name, v_slug, p_google_domain, 'trial', 10)
    ON CONFLICT (google_domain) DO NOTHING;

    SELECT id INTO v_org_id
    FROM organizations
    WHERE google_domain = p_google_domain;
  END IF;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Failed to create organization');
  END IF;

  -- Ensure user exists in public.users table
  INSERT INTO users (id, email, oauth_provider, oauth_id)
  VALUES (v_user_id, v_user_email, 'google', v_oauth_id)
  ON CONFLICT (id) DO NOTHING;

  -- Check if membership already exists
  IF NOT EXISTS (
    SELECT 1 FROM organization_members
    WHERE user_id = v_user_id AND organization_id = v_org_id
  ) THEN
    -- C1 fix: Assign 'admin' role (matching Azure RPC after change_setup_role_to_admin migration)
    INSERT INTO organization_members (organization_id, user_id, role, joined_at)
    VALUES (v_org_id, v_user_id, 'admin', NOW());
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', v_org_id,
    'user_id', v_user_id
  );
END;
$function$
;

-- Production ACLs for the replaced bodies.
REVOKE ALL ON FUNCTION public.claim_pending_invite() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_pending_invite() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.auto_provision_it_admin(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_provision_it_admin(text, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.jit_join_organization(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.jit_join_organization(text) TO service_role;
REVOKE ALL ON FUNCTION public.auto_provision_google_it_admin(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_provision_google_it_admin(text, text, text) TO service_role;
DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keepr_agent') THEN  -- venue-only role
    EXECUTE 'REVOKE ALL ON FUNCTION public.auto_provision_it_admin(text, text, text) FROM keepr_agent';
  END IF;
END $do$;
