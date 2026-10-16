-- BACKLOG-3684 (file A of 2, additive): an invitation is accepted through its invitation link.
--
-- Adds three functions. Changes nothing that exists, so applying this file changes no
-- behaviour for anyone. File B (20261016075231) withdraws the email-only paths and must
-- be applied only after the portal that calls these functions is live.
--
-- 1. Pre-check: each of the three functions is absent, or present with exactly this
--    file's body (md5 below). Anything else aborts. Re-running this file is a no-op.
-- 2. public.accept_invitation(p_token text, p_tenant_id text DEFAULT NULL) RETURNS jsonb
--    SECURITY DEFINER. The caller accepts the invitation that p_token names when their
--    auth.users.email equals its invited_email (case-insensitive, trimmed; never user
--    metadata). In order, {success:false, error} with nothing written:
--      'not_authenticated' no auth.uid();
--      (p_tenant_id given) 42501 unless the tenant is one of the caller's azure
--                          identities, and 42501 for the personal-account tenant;
--      'already_placed'    the caller has any membership in a non-personal organization;
--      'invalid_invite'    no unclaimed pending row with this token in a non-personal
--                          organization (not found, used and replaced read the same);
--      'expired'           invitation_expires_at <= now();
--      'email_mismatch'    the caller's auth email is empty or differs;
--      (p_tenant_id given, role admin / it_admin) 'tenant_in_use' / 'tenant_mismatch'
--                          from public._invite_bind_tenant, before the row is claimed.
--    Otherwise: public.users gets a row only when the caller has none; the row is
--    claimed (user_id, 'active', joined_at now(), token cleared). Returns
--    {success:true, organization_id, user_id, role, tenant_linked}.
-- 3. public._invite_bind_tenant(p_org_id uuid, p_tenant_id text) RETURNS text: binds a
--    lower-cased tenant to an organization that has none. NULL = bound or already the same
--    tenant; else 'tenant_in_use' (another organization holds it, case-insensitive,
--    including a concurrent bind) or 'tenant_mismatch'. The same rule as
--    auto_provision_it_admin at 20261016054316. No client role may execute it.
-- 4. public.caller_has_pending_invite() RETURNS boolean: true when an unclaimed, pending,
--    unexpired invitation with a token, in a non-personal organization, is addressed to
--    the caller's auth email. Returns a boolean only.
-- 5. EXECUTE: accept_invitation and caller_has_pending_invite to authenticated and
--    service_role only; _invite_bind_tenant to no client role.
--
-- Rollback: supabase/tests/backlog-3684/rollback-3684-a.sql (after rollback-3684-b.sql).

DO $pre$
DECLARE
  r record;
  v_n integer;
  v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('accept_invitation', 'public.accept_invitation(text,text)', '851f0b67ed7f31c99aecca5f557f60dc'),
    ('_invite_bind_tenant', 'public._invite_bind_tenant(uuid,text)', 'fba28792ffecd1f21a98ba0c931b515f'),
    ('caller_has_pending_invite', 'public.caller_has_pending_invite()', '93d54ab5f4f1d9c81347dcb66a698cd2')
  ) AS t(name, sig, md5) LOOP
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.name;
    IF v_n = 0 THEN CONTINUE; END IF;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF v_n <> 1 OR v_md5 IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION '3684 A pre-check: % differs from the expected one (overloads %, md5 %)', r.name, v_n, v_md5;
    END IF;
  END LOOP;
END $pre$;

CREATE OR REPLACE FUNCTION public._invite_bind_tenant(
  p_org_id UUID,
  p_tenant_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_org_tenant TEXT;
BEGIN
  SELECT o.microsoft_tenant_id
  INTO v_org_tenant
  FROM organizations o
  WHERE o.id = p_org_id
  FOR UPDATE;

  IF v_org_tenant IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM organizations o
      WHERE lower(o.microsoft_tenant_id) = p_tenant_id
        AND o.id <> p_org_id
    ) THEN
      RETURN 'tenant_in_use';
    END IF;

    BEGIN
      UPDATE organizations SET microsoft_tenant_id = p_tenant_id WHERE id = p_org_id;
    EXCEPTION WHEN unique_violation THEN
      RETURN 'tenant_in_use';
    END;
  ELSIF lower(v_org_tenant) IS DISTINCT FROM p_tenant_id THEN
    RETURN 'tenant_mismatch';
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._invite_bind_tenant(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.accept_invitation(
  p_token TEXT,
  p_tenant_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id UUID;
  v_identity_tid TEXT;
  v_user_email TEXT;
  v_match_email TEXT;
  v_provider TEXT;
  v_oauth_id TEXT;
  v_member_id UUID;
  v_org_id UUID;
  v_role TEXT;
  v_invited_email TEXT;
  v_expires_at TIMESTAMPTZ;
  v_bind_error TEXT;
  v_tenant_linked BOOLEAN := false;
  v_rows INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- /setup path only: the tenant must be one the caller signed in with (BACKLOG-3882).
  IF p_tenant_id IS NOT NULL THEN
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
  END IF;

  -- A caller already in a brokerage (any status) accepts nothing here.
  IF EXISTS (
    SELECT 1
    FROM organization_members m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = v_user_id
      AND o.personal_owner_user_id IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_placed');
  END IF;

  SELECT m.id, m.organization_id, m.role, m.invited_email, m.invitation_expires_at
  INTO v_member_id, v_org_id, v_role, v_invited_email, v_expires_at
  FROM organization_members m
  JOIN organizations o ON o.id = m.organization_id
  WHERE m.invitation_token = p_token
    AND m.user_id IS NULL
    AND m.license_status = 'pending'
    AND o.personal_owner_user_id IS NULL
  LIMIT 1
  FOR UPDATE OF m;

  IF v_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_invite');
  END IF;

  IF v_expires_at IS NOT NULL AND v_expires_at <= now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'expired');
  END IF;

  -- Email for matching: auth.users.email only. Email for the public.users row: the
  -- fallback chain (Microsoft may not populate auth.users.email for external tenants).
  SELECT
    lower(btrim(email)),
    COALESCE(
      email,
      raw_user_meta_data->>'email',
      raw_user_meta_data->>'mail',
      raw_user_meta_data->>'preferred_username'
    ),
    raw_app_meta_data->>'provider',
    raw_user_meta_data->>'provider_id'
  INTO v_match_email, v_user_email, v_provider, v_oauth_id
  FROM auth.users
  WHERE id = v_user_id;

  IF v_match_email IS NULL OR v_match_email = ''
     OR v_match_email IS DISTINCT FROM lower(btrim(v_invited_email)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'email_mismatch');
  END IF;

  IF v_identity_tid IS NOT NULL AND v_role IN ('admin', 'it_admin') THEN
    v_bind_error := public._invite_bind_tenant(v_org_id, v_identity_tid);
    IF v_bind_error IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', v_bind_error);
    END IF;
  END IF;

  IF v_identity_tid IS NOT NULL THEN
    SELECT lower(o.microsoft_tenant_id) IS NOT DISTINCT FROM v_identity_tid
    INTO v_tenant_linked
    FROM organizations o
    WHERE o.id = v_org_id;
  END IF;

  -- Ensure the caller has a public.users row (an existing row is left as it is).
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_user_id) THEN
    INSERT INTO users (id, email, oauth_provider, oauth_id)
    VALUES (
      v_user_id,
      v_user_email,
      CASE WHEN v_provider IN ('google', 'azure', 'email') THEN v_provider ELSE 'unknown' END,
      COALESCE(v_oauth_id, v_user_id::text)
    );
  END IF;

  UPDATE organization_members
  SET user_id = v_user_id,
      license_status = 'active',
      joined_at = NOW(),
      invitation_token = NULL
  WHERE id = v_member_id
    AND user_id IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_invite');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', v_org_id,
    'user_id', v_user_id,
    'role', v_role,
    'tenant_linked', coalesce(v_tenant_linked, false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.accept_invitation(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.caller_has_pending_invite()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM organization_members m
    JOIN organizations o ON o.id = m.organization_id
    JOIN auth.users u ON u.id = auth.uid()
    WHERE m.user_id IS NULL
      AND m.license_status = 'pending'
      AND m.invitation_token IS NOT NULL
      AND o.personal_owner_user_id IS NULL
      AND u.email IS NOT NULL
      AND btrim(u.email) <> ''
      AND lower(btrim(m.invited_email)) = lower(btrim(u.email))
      AND (m.invitation_expires_at IS NULL OR m.invitation_expires_at > now())
  )
$function$;

REVOKE ALL ON FUNCTION public.caller_has_pending_invite() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_has_pending_invite() TO authenticated, service_role;
