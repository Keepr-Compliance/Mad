-- BACKLOG-3851 (PR-2 piece 1): /setup completes an invitation; it no longer creates an organization.
--
-- 1. Pre-check: abort unless auto_provision_it_admin's body is the production body
--    (md5 a88466cc17f1f28a9824ec62c73a2589, = the BACKLOG-3882 body) or this
--    migration's body (md5 0ca68b8cee9820322274e1f1a4817b0a).
-- 2. auto_provision_it_admin(p_tenant_id, p_org_name, p_org_slug): same signature,
--    return type, SECURITY DEFINER and search_path. p_org_name and p_org_slug are
--    accepted and ignored. The BACKLOG-3882 identity checks are unchanged.
--    The caller's target membership is, in order:
--      a. the caller's first membership in a non-personal organization (any status,
--         ordered by created_at, id), or
--      b. the caller's live unclaimed invite (user_id NULL, license_status 'pending',
--         invited_email = auth.users.email case-insensitive and trimmed, not expired,
--         non-personal organization; newest invited_at first).
--    Returns {success:false, error:...} with nothing written when:
--      'no_invite'           neither a nor b exists;
--      'membership_inactive' a exists and its license_status is not 'active';
--      'tenant_in_use'       the target role is admin / it_admin, the organization has
--                            no Microsoft tenant, and another organization holds the
--                            caller's tenant (case-insensitive), including a
--                            concurrent bind;
--      'tenant_mismatch'     the target role is admin / it_admin and the organization
--                            holds a different Microsoft tenant.
--    Otherwise: for admin / it_admin targets an organization with no tenant gets the
--    caller's tenant; public.users gets a row only when the caller has none; an invite
--    target is claimed (user_id = caller, 'active', joined_at now(), token cleared).
--    No organization is ever inserted. Returns {success:true, organization_id,
--    user_id, role, tenant_linked}.
-- 3. EXECUTE stays revoked from PUBLIC and anon; authenticated and service_role keep it.
--
-- Re-running this file is a no-op.
-- Rollback: supabase/tests/backlog-3851-setup/rollback-3851-setup.sql

DO $pre$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('a88466cc17f1f28a9824ec62c73a2589', '0ca68b8cee9820322274e1f1a4817b0a') THEN
    RAISE EXCEPTION '3851 setup pre-check: auto_provision_it_admin body differs from the expected one (md5 %)', v_md5;
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
  v_match_email TEXT;
  v_oauth_id TEXT;
  v_identity_tid TEXT;
  v_member_id UUID;
  v_org_id UUID;
  v_role TEXT;
  v_status TEXT;
  v_is_invite BOOLEAN := false;
  v_org_tenant TEXT;
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

  -- Email for the public.users row: the fallback chain (Microsoft may not populate
  -- auth.users.email for external tenants). Email for invite matching: auth.users.email only.
  SELECT
    COALESCE(
      email,
      raw_user_meta_data->>'email',
      raw_user_meta_data->>'mail',
      raw_user_meta_data->>'preferred_username'
    ),
    lower(btrim(email)),
    raw_user_meta_data->>'provider_id'
  INTO v_user_email, v_match_email, v_oauth_id
  FROM auth.users
  WHERE id = v_user_id;

  IF v_oauth_id IS NULL THEN
    v_oauth_id := v_user_id::text;
  END IF;

  -- Target a: the caller's first brokerage membership, any status.
  SELECT m.id, m.organization_id, m.role, m.license_status
  INTO v_member_id, v_org_id, v_role, v_status
  FROM organization_members m
  JOIN organizations o ON o.id = m.organization_id
  WHERE m.user_id = v_user_id
    AND o.personal_owner_user_id IS NULL
  ORDER BY m.created_at, m.id
  LIMIT 1;

  IF v_member_id IS NOT NULL THEN
    IF v_status IS DISTINCT FROM 'active' THEN
      RETURN jsonb_build_object('success', false, 'error', 'membership_inactive');
    END IF;
  ELSIF v_match_email IS NOT NULL AND v_match_email <> '' THEN
    -- Target b: the caller's live unclaimed invite.
    SELECT m.id, m.organization_id, m.role
    INTO v_member_id, v_org_id, v_role
    FROM organization_members m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id IS NULL
      AND m.license_status = 'pending'
      AND lower(btrim(m.invited_email)) = v_match_email
      AND (m.invitation_expires_at IS NULL OR m.invitation_expires_at > now())
      AND o.personal_owner_user_id IS NULL
    ORDER BY m.invited_at DESC NULLS LAST, m.id
    LIMIT 1
    FOR UPDATE OF m;

    v_is_invite := v_member_id IS NOT NULL;
  END IF;

  IF v_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_invite');
  END IF;

  SELECT o.microsoft_tenant_id
  INTO v_org_tenant
  FROM organizations o
  WHERE o.id = v_org_id
  FOR UPDATE;

  IF v_role IN ('admin', 'it_admin') THEN
    IF v_org_tenant IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM organizations o
        WHERE lower(o.microsoft_tenant_id) = p_tenant_id
          AND o.id <> v_org_id
      ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'tenant_in_use');
      END IF;

      BEGIN
        UPDATE organizations SET microsoft_tenant_id = p_tenant_id WHERE id = v_org_id;
      EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'error', 'tenant_in_use');
      END;
      v_org_tenant := p_tenant_id;
    ELSIF lower(v_org_tenant) IS DISTINCT FROM p_tenant_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'tenant_mismatch');
    END IF;
  END IF;

  -- Ensure the caller has a public.users row (an existing row is left as it is).
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_user_id) THEN
    INSERT INTO users (id, email, oauth_provider, oauth_id)
    VALUES (v_user_id, v_user_email, 'azure', v_oauth_id);
  END IF;

  IF v_is_invite THEN
    UPDATE organization_members
    SET user_id = v_user_id,
        license_status = 'active',
        joined_at = NOW(),
        invitation_token = NULL
    WHERE id = v_member_id
      AND user_id IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', v_org_id,
    'user_id', v_user_id,
    'role', v_role,
    'tenant_linked', lower(v_org_tenant) IS NOT DISTINCT FROM p_tenant_id
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_provision_it_admin(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_provision_it_admin(text, text, text) TO authenticated, service_role;
