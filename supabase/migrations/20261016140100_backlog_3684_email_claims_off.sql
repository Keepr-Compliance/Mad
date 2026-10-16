-- BACKLOG-3684 (file B of 2, subtractive): an invitation is no longer accepted by email alone.
--
-- Apply ONLY after the portal that calls public.accept_invitation is live (file A,
-- 20261016140000, must already be applied; the pre-check aborts otherwise).
--
-- 1. Pre-check, aborts on anything else:
--    auto_provision_it_admin md5 = 0ca68b8cee9820322274e1f1a4817b0a (20261016054316) or this
--    file's body; claim_pending_invite md5 = 96ae2f67bbe19d5091466ab0f123e9b5 with EXECUTE
--    held by {postgres, authenticated, service_role} or {postgres, service_role};
--    policies users_can_accept_invite (USING + WITH CHECK) and users_can_view_own_invite
--    (USING) equal to the production text read 2026-10-16 from pg_policies, or false;
--    accept_invitation, _invite_bind_tenant and caller_has_pending_invite present with
--    file A's bodies.
-- 2. auto_provision_it_admin(p_tenant_id, p_org_name, p_org_slug): same signature, return
--    type, SECURITY DEFINER and search_path. The caller's first membership in a
--    non-personal organization is the only target; without one the result is 'no_invite'
--    and nothing is written. 'membership_inactive', 'tenant_in_use', 'tenant_mismatch' and
--    the BACKLOG-3882 identity checks are unchanged; the bind runs through
--    public._invite_bind_tenant. No invitation is accepted here.
-- 3. claim_pending_invite(): EXECUTE withdrawn from authenticated. Body unchanged.
-- 4. Policy users_can_accept_invite: USING (false) WITH CHECK (false).
-- 5. Policy users_can_view_own_invite: USING (false).
--    (Names kept: earlier pins refer to them.)
--
-- Re-running this file is a no-op.
-- Rollback: supabase/tests/backlog-3684/rollback-3684-b.sql

DO $pre$
DECLARE
  v_md5 text;
  v_acl text;
  v_qual text;
  v_check text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('0ca68b8cee9820322274e1f1a4817b0a', '94030cf6be7b69e85d583916750e577f') THEN
    RAISE EXCEPTION '3684 B pre-check: auto_provision_it_admin body differs (md5 %)', v_md5;
  END IF;

  -- ACL compared as a sorted set: a re-grant (rollback) can change the entry order.
  SELECT md5(prosrc), (SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(proacl) a)
    INTO v_md5, v_acl FROM pg_proc
   WHERE oid = 'public.claim_pending_invite()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '96ae2f67bbe19d5091466ab0f123e9b5'
     OR v_acl IS NULL
     OR v_acl NOT IN ('authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres',
                      'postgres=X/postgres,service_role=X/postgres') THEN
    RAISE EXCEPTION '3684 B pre-check: claim_pending_invite differs (md5 %, acl %)', v_md5, v_acl;
  END IF;

  SELECT qual, with_check INTO v_qual, v_check FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'users_can_accept_invite';
  IF NOT ((v_qual = '((user_id IS NULL) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> ''email''::text), ''''::text)))) AND ((invitation_expires_at IS NULL) OR (invitation_expires_at > now())))'
           AND v_check = '((user_id = ( SELECT auth.uid() AS uid)) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> ''email''::text), ''''::text)))))')
          OR (v_qual = 'false' AND v_check = 'false')) THEN
    RAISE EXCEPTION '3684 B pre-check: users_can_accept_invite differs (qual %, with_check %)', v_qual, v_check;
  END IF;

  SELECT qual, with_check INTO v_qual, v_check FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'users_can_view_own_invite';
  IF v_check IS NOT NULL OR v_qual IS NULL
     OR v_qual NOT IN ('((user_id IS NULL) AND (invited_email IS NOT NULL) AND (lower(btrim(invited_email)) = lower(btrim(COALESCE((( SELECT auth.jwt() AS jwt) ->> ''email''::text), ''''::text)))) AND ((invitation_expires_at IS NULL) OR (invitation_expires_at > now())))', 'false') THEN
    RAISE EXCEPTION '3684 B pre-check: users_can_view_own_invite differs (qual %, with_check %)', v_qual, v_check;
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.accept_invitation(text,text)'))
       IS DISTINCT FROM '851f0b67ed7f31c99aecca5f557f60dc'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public._invite_bind_tenant(uuid,text)'))
       IS DISTINCT FROM 'fba28792ffecd1f21a98ba0c931b515f'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.caller_has_pending_invite()'))
       IS DISTINCT FROM '93d54ab5f4f1d9c81347dcb66a698cd2' THEN
    RAISE EXCEPTION '3684 B pre-check: file A (20261016140000) is not applied with its expected bodies';
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
  v_identity_tid TEXT;
  v_member_id UUID;
  v_org_id UUID;
  v_role TEXT;
  v_status TEXT;
  v_org_tenant TEXT;
  v_bind_error TEXT;
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
  -- auth.users.email for external tenants).
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

  -- The caller's first brokerage membership, any status. BACKLOG-3684: an invitation
  -- is accepted only through public.accept_invitation (its link), never here.
  SELECT m.id, m.organization_id, m.role, m.license_status
  INTO v_member_id, v_org_id, v_role, v_status
  FROM organization_members m
  JOIN organizations o ON o.id = m.organization_id
  WHERE m.user_id = v_user_id
    AND o.personal_owner_user_id IS NULL
  ORDER BY m.created_at, m.id
  LIMIT 1;

  IF v_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_invite');
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'membership_inactive');
  END IF;

  IF v_role IN ('admin', 'it_admin') THEN
    v_bind_error := public._invite_bind_tenant(v_org_id, p_tenant_id);
    IF v_bind_error IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', v_bind_error);
    END IF;
  END IF;

  SELECT o.microsoft_tenant_id
  INTO v_org_tenant
  FROM organizations o
  WHERE o.id = v_org_id;

  -- Ensure the caller has a public.users row (an existing row is left as it is).
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_user_id) THEN
    INSERT INTO users (id, email, oauth_provider, oauth_id)
    VALUES (v_user_id, v_user_email, 'azure', v_oauth_id);
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

REVOKE EXECUTE ON FUNCTION public.claim_pending_invite() FROM authenticated;

ALTER POLICY users_can_accept_invite ON public.organization_members USING (false) WITH CHECK (false);

ALTER POLICY users_can_view_own_invite ON public.organization_members USING (false);
