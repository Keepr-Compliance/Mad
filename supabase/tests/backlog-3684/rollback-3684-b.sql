-- BACKLOG-3684 rollback of file B (20261016075231). Restores, verbatim:
--   auto_provision_it_admin body of 20261016054316 (md5 0ca68b8cee9820322274e1f1a4817b0a);
--   EXECUTE on claim_pending_invite() for authenticated;
--   policy users_can_accept_invite USING + WITH CHECK, and users_can_view_own_invite USING,
--   as pg_policies printed them on production 2026-10-16.
-- File A's functions are left in place (rollback-3684-a.sql removes them).
--
-- BACKLOG-3851 PR-2f: REFUSES while 3851 M4 (20261018170000) is in force, i.e. while
-- accept_invitation does not have file A's body, or while any unclaimed invitation without
-- a license exists. Re-granting claim_pending_invite (no status filter, sets 'active') under
-- M4 would let an unlicensed invitee take a seat. Order: rollback-m4 -> this file -> rollback-3684-a.

DO $m4$
DECLARE
  v_n integer;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.accept_invitation(text,text)'))
       IS DISTINCT FROM '851f0b67ed7f31c99aecca5f557f60dc' THEN
    RAISE EXCEPTION '3684 rollback-b: accept_invitation is not file A''s body (3851 M4 in force?); run supabase/tests/backlog-3851/pr2f/rollback-m4.sql first';
  END IF;
  SELECT count(*) INTO v_n FROM public.organization_members
   WHERE user_id IS NULL AND license_status = 'unassigned';
  IF v_n > 0 THEN
    RAISE EXCEPTION '3684 rollback-b: % unclaimed invitation(s) without a license exist; revoke them first', v_n;
  END IF;
END $m4$;

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

GRANT EXECUTE ON FUNCTION public.claim_pending_invite() TO authenticated;

ALTER POLICY users_can_accept_invite ON public.organization_members
  USING (((user_id IS NULL) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> 'email'::text), ''::text)))) AND ((invitation_expires_at IS NULL) OR (invitation_expires_at > now()))))
  WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> 'email'::text), ''::text))))));

ALTER POLICY users_can_view_own_invite ON public.organization_members
  USING (((user_id IS NULL) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> 'email'::text), ''::text)))) AND ((invitation_expires_at IS NULL) OR (invitation_expires_at > now()))));
