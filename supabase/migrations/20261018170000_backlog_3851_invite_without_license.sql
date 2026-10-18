-- BACKLOG-3851 PR-2f M4: invite without a license.
--
-- An unlicensed invitation is an unclaimed row with license_status = 'unassigned' and
-- user_id IS NULL (token, expiry and invited_email as for any invitation). It holds no
-- seat (member_row_holds_seat already returns false for 'unassigned'; that function, the
-- seat trigger and the SCIM twin are NOT touched). Accepting it lands the row in the
-- same claimed-'unassigned' state that JIT, directory sync and Unassign produce.
--
-- CREATE OR REPLACE only, same signatures (BACKLOG-3947). No function is added or dropped.
--   F1 guard_invite_acceptance(): a client INSERT may be 'pending' or 'unassigned'; the
--      seat count runs only when the new row holds a seat; invited_first_name /
--      invited_last_name are editable by an org admin on an unclaimed row.
--   F2 accept_invitation(text, text): accepts 'pending' and 'unassigned' invitations; an
--      'unassigned' invitation stays 'unassigned' when claimed, a 'pending' one becomes
--      'active' as before; the invitation's names fill BLANK public.users names only
--      (never overwrite); the result gains 'license_status'.
--   F3 caller_has_pending_invite(): also true for an 'unassigned' invitation.
--   F4 public_validate_invitation_token(text): the result gains 'licensed'
--      (license_status IS DISTINCT FROM 'unassigned') and 'first_name'.
-- Grants: unchanged (CREATE OR REPLACE keeps the ACL); accept_invitation and
-- caller_has_pending_invite are re-stated as in 3684 A.
--
-- Pre-check (aborts on any difference):
--   - each of the four bodies is the expected current one or this file's (md5 below);
--   - 3684 B is in force: claim_pending_invite() not executable by authenticated, and
--     policies users_can_accept_invite (USING and WITH CHECK) and users_can_view_own_invite
--     (USING) are 'false'. Without B, claim_pending_invite (no status filter, sets
--     'active') would let an unlicensed invitee take a seat the admin withheld;
--   - M4a (20261017230000) is applied: both name columns exist as text.
-- Re-running this file is a no-op. Once this file is applied, 3684 A's own pre-check
-- aborts (accept_invitation no longer has A's body), so A is not re-runnable after M4.
--
-- Production order: 3684 A -> M4a -> release -> 3684 B -> M4 -> turn on the portal switch
-- NEXT_PUBLIC_INVITE_WITHOUT_LICENSE_ENABLED for production.
-- Rollback: supabase/tests/backlog-3851/pr2f/rollback-m4.sql (before rollback-3684-b.sql,
-- which refuses while M4 is in force).

DO $pre$
DECLARE
  r record;
  v_md5 text;
  v_qual text;
  v_check text;
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
      RAISE EXCEPTION '3851 M4 pre-check: % differs from the expected one (md5 %)', r.sig, v_md5;
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated', 'public.claim_pending_invite()', 'EXECUTE') THEN
    RAISE EXCEPTION '3851 M4 pre-check: 3684 B is not in force (authenticated can execute claim_pending_invite)';
  END IF;

  SELECT qual, with_check INTO v_qual, v_check FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'users_can_accept_invite';
  IF v_qual IS DISTINCT FROM 'false' OR v_check IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION '3851 M4 pre-check: 3684 B is not in force (users_can_accept_invite qual %, with_check %)', v_qual, v_check;
  END IF;

  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'users_can_view_own_invite';
  IF v_qual IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION '3851 M4 pre-check: 3684 B is not in force (users_can_view_own_invite qual %)', v_qual;
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organization_members'
     AND column_name IN ('invited_first_name', 'invited_last_name') AND data_type = 'text';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '3851 M4 pre-check: M4a (20261017230000, invite name columns) is not applied';
  END IF;
END $pre$;

-- F1 ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_invite_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_free text[] := ARRAY['user_id', 'joined_at', 'license_status', 'invitation_token', 'updated_at'];
  v_admin_free text[] := ARRAY['role', 'invitation_token', 'invitation_expires_at', 'invited_first_name', 'invited_last_name', 'updated_at'];
  v_max_seats integer;
  v_used integer;
BEGIN
  -- Only client roles are limited. service_role, postgres and SECURITY DEFINER
  -- functions (which run as their owner) pass unchanged.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- INSERT: the row-level policy already limits client inserts to admins of the
  -- row's organization. This fixes the row's shape: an unclaimed invite created by
  -- the caller (broker-portal inviteUser), licensed ('pending') or not ('unassigned').
  IF TG_OP = 'INSERT' THEN
    IF v_uid IS NULL
       OR NEW.user_id IS NOT NULL
       OR NOT COALESCE(NEW.license_status IN ('pending', 'unassigned'), false)
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
    -- BACKLOG-3851: an expired, unclaimed invite holds no seat; an invitation that
    -- holds no seat itself (unlicensed) is not counted against the limit.
    SELECT o.max_seats INTO v_max_seats FROM public.organizations o WHERE o.id = NEW.organization_id;
    IF v_max_seats IS NOT NULL AND v_max_seats > 0
       AND public.member_row_holds_seat(NEW.license_status, NEW.invitation_expires_at, NEW.user_id) THEN
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
  -- organization_members_all_public: the role, and an unclaimed invite's token,
  -- expiry and invited names. Licence status, user_id and every other column stay.
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

-- F2 ---------------------------------------------------------------------------------
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
  v_invite_status TEXT;
  v_new_status TEXT;
  v_first TEXT;
  v_last TEXT;
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

  -- BACKLOG-3851: a licensed ('pending') or an unlicensed ('unassigned') invitation.
  SELECT m.id, m.organization_id, m.role, m.invited_email, m.invitation_expires_at,
         m.license_status, NULLIF(btrim(m.invited_first_name), ''), NULLIF(btrim(m.invited_last_name), '')
  INTO v_member_id, v_org_id, v_role, v_invited_email, v_expires_at,
       v_invite_status, v_first, v_last
  FROM organization_members m
  JOIN organizations o ON o.id = m.organization_id
  WHERE m.invitation_token = p_token
    AND m.user_id IS NULL
    AND m.license_status IN ('pending', 'unassigned')
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

  -- BACKLOG-3851 S1: the names typed on the invitation fill blank first/last names only.
  -- (display_name is left alone: handle_new_user always sets it at sign-up.)
  IF v_first IS NOT NULL OR v_last IS NOT NULL THEN
    UPDATE users
    SET first_name = COALESCE(NULLIF(btrim(first_name), ''), v_first),
        last_name = COALESCE(NULLIF(btrim(last_name), ''), v_last)
    WHERE id = v_user_id;
  END IF;

  -- An unlicensed invitation stays unlicensed; a licensed one becomes active.
  v_new_status := CASE WHEN v_invite_status = 'unassigned' THEN 'unassigned' ELSE 'active' END;

  UPDATE organization_members
  SET user_id = v_user_id,
      license_status = v_new_status,
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
    'license_status', v_new_status,
    'tenant_linked', coalesce(v_tenant_linked, false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.accept_invitation(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text, text) TO authenticated, service_role;

-- F3 ---------------------------------------------------------------------------------
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
      AND m.license_status IN ('pending', 'unassigned')
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

-- F4 ---------------------------------------------------------------------------------
-- Grants unchanged: this function is called by the invite landing page before sign-in.
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
    om.user_id,
    om.license_status,
    om.invited_first_name
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

  -- 7. Return validated invite details. BACKLOG-3851: 'licensed' is false for an
  --    invitation without a license; 'first_name' is the name typed on the invitation.
  RETURN jsonb_build_object(
    'valid',      true,
    'email',      v_invite.invited_email,
    'org_name',   COALESCE(v_org_name, 'Unknown Organization'),
    'role',       v_invite.role,
    'licensed',   v_invite.license_status IS DISTINCT FROM 'unassigned',
    'first_name', NULLIF(btrim(v_invite.invited_first_name), '')
  );
END;
$function$;
