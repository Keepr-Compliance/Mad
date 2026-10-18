-- BACKLOG-3851 PR-2f rollback of M4 (20261018170000_backlog_3851_invite_without_license.sql).
-- Restores, verbatim, the four bodies M4 replaced:
--   guard_invite_acceptance            md5 630480367fd00fbb23173e990ab6c494 (M1 body)
--   accept_invitation(text, text)      md5 851f0b67ed7f31c99aecca5f557f60dc (3684 A body)
--   caller_has_pending_invite()        md5 93d54ab5f4f1d9c81347dcb66a698cd2 (3684 A body)
--   public_validate_invitation_token   md5 9501ad58da435df9c1ef142352ef267c
-- REFUSES while any unclaimed unlicensed invitation exists (user_id IS NULL AND
-- license_status = 'unassigned'): the restored accept_invitation cannot accept it, so it
-- would be stranded. Revoke those invitations first.
-- The name columns stay (rollback-m4a.sql removes them, after this file).
-- Order: rollback-m4 -> rollback-m4a; and rollback-m4 -> rollback-3684-b -> rollback-3684-a.
-- Run in one transaction (BEGIN; \i rollback-m4.sql; COMMIT;).

DO $pre$
DECLARE
  r record;
  v_md5 text;
  v_n integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.guard_invite_acceptance()', '630480367fd00fbb23173e990ab6c494', '3219e9d919260b2c5ac537efb3a57581'),
    ('public.accept_invitation(text,text)', '851f0b67ed7f31c99aecca5f557f60dc', '37ce05772d72d25439d5ef2bdd5a2d08'),
    ('public.caller_has_pending_invite()', '93d54ab5f4f1d9c81347dcb66a698cd2', '5fe92208a44700f75ab7553cf51df3aa'),
    ('public.public_validate_invitation_token(text)', '9501ad58da435df9c1ef142352ef267c', 'b5131a4dc978a10275b553123ea58e77')
  ) AS t(sig, old_md5, new_md5) LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL OR v_md5 NOT IN (r.old_md5, r.new_md5) THEN
      RAISE EXCEPTION '3851 rollback-m4: % is neither the M4 body nor the earlier one (md5 %)', r.sig, v_md5;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.organization_members
   WHERE user_id IS NULL AND license_status = 'unassigned';
  IF v_n > 0 THEN
    RAISE EXCEPTION '3851 rollback-m4: % unclaimed invitation(s) without a license exist; revoke them first', v_n;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.guard_invite_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_free text[] := ARRAY['user_id', 'joined_at', 'license_status', 'invitation_token', 'updated_at'];
  v_admin_free text[] := ARRAY['role', 'invitation_token', 'invitation_expires_at', 'updated_at'];
  v_max_seats integer;
  v_used integer;
BEGIN
  -- Only client roles are limited. service_role, postgres and SECURITY DEFINER
  -- functions (which run as their owner) pass unchanged.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- INSERT: the row-level policy already limits client inserts to admins of the
  -- row's organization. This fixes the row's shape: an unclaimed pending invite
  -- created by the caller (broker-portal inviteUser), within the seat limit.
  IF TG_OP = 'INSERT' THEN
    IF v_uid IS NULL
       OR NEW.user_id IS NOT NULL
       OR NEW.license_status IS DISTINCT FROM 'pending'
       OR NEW.joined_at IS NOT NULL
       OR NEW.invited_by IS DISTINCT FROM v_uid
       OR NEW.invited_email IS NULL
       OR NEW.provisioned_by IS DISTINCT FROM 'invite'
       OR NEW.provisioned_at IS NOT NULL
       OR NEW.scim_synced_at IS NOT NULL
       OR NEW.provisioning_metadata IS NOT NULL
       OR NEW.idp_groups IS NOT NULL
       OR NEW.group_sync_enabled IS DISTINCT FROM false
       OR NEW.last_invited_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'Only a pending invitation can be added from a client session'
        USING ERRCODE = '42501';
    END IF;

    -- Same rule as the invite form: seat-holding members must stay below max_seats.
    -- BACKLOG-3851: an expired, unclaimed invite holds no seat.
    SELECT o.max_seats INTO v_max_seats FROM public.organizations o WHERE o.id = NEW.organization_id;
    IF v_max_seats IS NOT NULL AND v_max_seats > 0 THEN
      SELECT count(*) INTO v_used
        FROM public.organization_members m
       WHERE m.organization_id = NEW.organization_id
         AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);
      IF v_used >= v_max_seats THEN
        RAISE EXCEPTION 'Organization has reached maximum seats' USING ERRCODE = '42501';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE. No client role moves a membership between organizations.
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'organization_id cannot be changed' USING ERRCODE = '42501';
  END IF;

  -- Organization admins edit members of their organization through
  -- organization_members_all_public: the role, and an unclaimed invite's token
  -- and expiry. Licence status, user_id and every other column stay as they are.
  IF v_uid IS NOT NULL
     AND public.is_org_admin(v_uid, OLD.organization_id)
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    IF (to_jsonb(NEW) - v_admin_free) IS DISTINCT FROM (to_jsonb(OLD) - v_admin_free) THEN
      RAISE EXCEPTION 'Only the role or invitation can be changed from a client session'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Anyone else can only accept their own pending invite.
  IF v_uid IS NULL
     OR OLD.user_id IS NOT NULL
     OR NEW.user_id IS DISTINCT FROM v_uid
     OR OLD.license_status IS DISTINCT FROM 'pending'
     OR NEW.license_status IS DISTINCT FROM 'active'
     OR (NEW.invitation_token IS DISTINCT FROM OLD.invitation_token AND NEW.invitation_token IS NOT NULL)
     OR (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free)
  THEN
    RAISE EXCEPTION 'Invite acceptance can only link the signed-in user' USING ERRCODE = '42501';
  END IF;

  -- BACKLOG-3538: the join date of an accepted invite is the server's time,
  -- never a client-supplied value.
  NEW.joined_at := now();

  RETURN NEW;
END;
$function$;

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

CREATE OR REPLACE FUNCTION public.public_validate_invitation_token(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invite RECORD;
  v_org_name TEXT;
BEGIN
  -- 1. Validate input
  IF p_token IS NULL OR trim(p_token) = '' THEN
    RETURN jsonb_build_object('valid', false, 'error', 'No token provided');
  END IF;

  -- 2. Look up the invitation by token
  SELECT
    om.id,
    om.invited_email,
    om.role,
    om.organization_id,
    om.invitation_expires_at,
    om.user_id
  INTO v_invite
  FROM organization_members om
  WHERE om.invitation_token = p_token;

  -- 3. Not found
  IF v_invite.id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'Invitation not found');
  END IF;

  -- 4. Already accepted (user_id is set when invite is claimed)
  IF v_invite.user_id IS NOT NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'This invitation has already been accepted');
  END IF;

  -- 5. Expired
  IF v_invite.invitation_expires_at IS NOT NULL
     AND v_invite.invitation_expires_at < now() THEN
    RETURN jsonb_build_object('valid', false, 'error', 'This invitation has expired');
  END IF;

  -- 6. Get organization name
  SELECT name INTO v_org_name
  FROM organizations
  WHERE id = v_invite.organization_id;

  -- 7. Return validated invite details
  RETURN jsonb_build_object(
    'valid',    true,
    'email',    v_invite.invited_email,
    'org_name', COALESCE(v_org_name, 'Unknown Organization'),
    'role',     v_invite.role
  );
END;
$function$;

DO $post$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.guard_invite_acceptance()', '630480367fd00fbb23173e990ab6c494'),
    ('public.accept_invitation(text,text)', '851f0b67ed7f31c99aecca5f557f60dc'),
    ('public.caller_has_pending_invite()', '93d54ab5f4f1d9c81347dcb66a698cd2'),
    ('public.public_validate_invitation_token(text)', '9501ad58da435df9c1ef142352ef267c')
  ) AS t(sig, md5) LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION '3851 rollback-m4 post-check: % md5 %', r.sig, v_md5;
    END IF;
  END LOOP;
END $post$;
