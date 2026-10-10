-- BACKLOG-3882: auto_provision_it_admin accepts only a tenant the caller signed in with.
--
-- 1. Pre-check: abort unless auto_provision_it_admin's body is the production
--    body (md5 b0541c6347baf9457cf949f5ec5be1e5, = the BACKLOG-3096 body) or
--    this migration's body (md5 a88466cc17f1f28a9824ec62c73a2589).
-- 2. auto_provision_it_admin raises SQLSTATE 42501 unless auth.identities has
--    a provider 'azure' row for auth.uid() whose custom_claims.tid equals
--    p_tenant_id (case-insensitive, trimmed). The personal-Microsoft-account
--    tenant is refused the same way. The organization is created / looked up
--    with the identity's tid. Everything else, including the BACKLOG-3096 row
--    lock and first-user-wins block, is the production body unchanged.
--    Signature, return shape, SECURITY DEFINER and search_path are unchanged.
-- 3. EXECUTE on auto_provision_it_admin is revoked from PUBLIC and anon;
--    authenticated and service_role keep it.
-- 4. EXECUTE on auto_provision_google_it_admin is revoked from PUBLIC, anon
--    and authenticated. Its body is not changed; service_role keeps EXECUTE.
--
-- Re-running this file is a no-op. Rollback: supabase/tests/backlog-3882/rollback-3882.sql

DO $pre$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('b0541c6347baf9457cf949f5ec5be1e5', 'a88466cc17f1f28a9824ec62c73a2589') THEN
    RAISE EXCEPTION '3882 pre-check: auto_provision_it_admin body differs from the expected one (md5 %)', v_md5;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.auto_provision_it_admin(
  p_tenant_id TEXT,
  p_org_name TEXT,
  p_org_slug TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_provision_it_admin(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_provision_it_admin(text, text, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.auto_provision_google_it_admin(text, text, text) FROM PUBLIC, anon, authenticated;
