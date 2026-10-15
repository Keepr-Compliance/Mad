-- BACKLOG-3851 M1: brokerage license model.
--
-- 1. organization_members.license_status gains 'unassigned' (a member of the
--    brokerage who holds no seat). The CHECK keeps its name.
-- 2. organization_members.license_assigned_at: the time the member's licence last
--    became 'active'. Set by the seat trigger on every move into 'active', cleared on
--    every move out of it. Rows that were already active before this migration keep
--    NULL (no backfill).
-- 3. Status / origin helpers (IMMUTABLE or STABLE, SECURITY INVOKER, search_path ''):
--      member_status_holds_seat(text)                      'active' or 'pending'
--      member_status_is_deactivated(text)                  'suspended' or 'expired'
--      member_origin_is_idp(text)                          'jit', 'scim', 'directory_sync'
--      member_row_holds_seat(text, timestamptz, uuid)      active; or pending and
--                                                          (claimed, or the invite has
--                                                          not expired)
--    Unknown values and NULL return false.
-- 4. Seat trigger seat_limit_enforce -> _enforce_member_seat_limit(): for every role,
--    a row that starts holding a seat in a brokerage locks the organization row
--    (FOR NO KEY UPDATE), counts the seat holders, and is refused with
--    'seat_limit_reached' (SQLSTATE P0001) when the organization is full. Exceptions:
--      - an INSERT with an identity-provider origin is written as 'unassigned' instead;
--      - the first claimed member of an organization that has no access-granting
--        claimed member always gets a seat (may exceed max_seats by one).
--    Personal organizations and max_seats NULL or <= 0 have no limit.
-- 5. guard_invite_acceptance() and admin_invite_user(...): their early seat counts use
--    member_row_holds_seat (an expired, unclaimed invite no longer counts). Nothing
--    else in either body changes.
-- 6. set_member_license(uuid, text): assign / unassign / reactivate a member's licence.
--    Returns jsonb; errors not_authorized, seat_limit_reached, last_manager,
--    invalid_transition.
-- 7. get_org_features(uuid) and check_feature_access(uuid, text): the caller's
--    membership row must also pass member_status_grants_access.
--
-- Replaced functions are CREATE OR REPLACE (signature, ACL, SECURITY DEFINER flag,
-- search_path and volatility unchanged). Every new function states its grants and
-- revokes EXECUTE from PUBLIC and anon.
--
-- Apply as one transaction. No BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------
-- 0. Precondition: the replaced bodies are the ones this file was written against.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  bad text;
BEGIN
  -- old = production body (read 2026-10-14); new = this file's body (a second apply).
  SELECT string_agg(v.fn || ' actual=' || coalesce(md5(p.prosrc), '<missing>'), '; ')
    INTO bad
    FROM (VALUES
      ('guard_invite_acceptance', '9c8dc13e3fdece7c68e4d09870216efd', '630480367fd00fbb23173e990ab6c494'),
      ('admin_invite_user',       'ad6b30484ab22f96a6198d31d72572e1', 'ba6818a873bfb435f7bfb58b69e90a6e'),
      ('get_org_features',        '8a792fb4147390941f6b4ad1e6fec73e', 'ab7769fae1a97e4865a3522014b115b3'),
      ('check_feature_access',    'a23841f1c8528bd9e2544cb517f1c86c', '73144de764b464da3ebd0cac98ba141f')
    ) AS v(fn, old_md5, new_md5)
    LEFT JOIN pg_proc p ON p.proname = v.fn AND p.pronamespace = 'public'::regnamespace
   WHERE md5(p.prosrc) IS NULL OR md5(p.prosrc) NOT IN (v.old_md5, v.new_md5);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-3851 M1: a replaced function differs from the expected body: %', bad;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Status CHECK gains 'unassigned' (same name, same transaction)
-- ---------------------------------------------------------------------------
ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_license_status_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_license_status_check
  CHECK (license_status IN ('pending', 'active', 'suspended', 'expired', 'unassigned'));

-- ---------------------------------------------------------------------------
-- 2. license_assigned_at
-- ---------------------------------------------------------------------------
ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS license_assigned_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_status_holds_seat(p_license_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(p_license_status IN ('active', 'pending'), false);
$function$;
REVOKE ALL ON FUNCTION public.member_status_holds_seat(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_status_holds_seat(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.member_status_is_deactivated(p_license_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(p_license_status IN ('suspended', 'expired'), false);
$function$;
REVOKE ALL ON FUNCTION public.member_status_is_deactivated(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_status_is_deactivated(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.member_origin_is_idp(p_provisioned_by text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(p_provisioned_by IN ('jit', 'scim', 'directory_sync'), false);
$function$;
REVOKE ALL ON FUNCTION public.member_origin_is_idp(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_origin_is_idp(text) TO authenticated, service_role;

-- An unclaimed invite holds a seat until it expires (same expiry rule as
-- claim_pending_invite: expired when invitation_expires_at < now()).
CREATE OR REPLACE FUNCTION public.member_row_holds_seat(p_license_status text, p_invitation_expires_at timestamptz, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    p_license_status = 'active'
    OR (p_license_status = 'pending'
        AND (p_user_id IS NOT NULL OR p_invitation_expires_at IS NULL OR p_invitation_expires_at >= now())),
    false);
$function$;
REVOKE ALL ON FUNCTION public.member_row_holds_seat(text, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_row_holds_seat(text, timestamptz, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Seat trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._enforce_member_seat_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_personal  boolean;
  v_max_seats integer;
  v_used      integer;
BEGIN
  -- Timestamp first, before any early return (a client INSERT cannot supply it).
  IF NEW.license_status = 'active' THEN
    IF TG_OP = 'UPDATE' AND OLD.license_status = 'active'
       AND OLD.organization_id = NEW.organization_id THEN
      NEW.license_assigned_at := OLD.license_assigned_at;
    ELSE
      NEW.license_assigned_at := now();
    END IF;
  ELSE
    NEW.license_assigned_at := NULL;
  END IF;

  IF NOT public.member_row_holds_seat(NEW.license_status, NEW.invitation_expires_at, NEW.user_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.organization_id = NEW.organization_id
     AND public.member_row_holds_seat(OLD.license_status, OLD.invitation_expires_at, OLD.user_id) THEN
    RETURN NEW;
  END IF;

  SELECT o.personal_owner_user_id IS NOT NULL INTO v_personal
    FROM public.organizations o WHERE o.id = NEW.organization_id;
  IF v_personal IS DISTINCT FROM false THEN
    RETURN NEW;  -- personal organization (or none: the foreign key refuses it)
  END IF;

  -- One seat writer per organization at a time. NO KEY UPDATE does not block
  -- foreign-key inserts that reference the organization.
  SELECT o.max_seats INTO v_max_seats
    FROM public.organizations o WHERE o.id = NEW.organization_id
    FOR NO KEY UPDATE;
  IF v_max_seats IS NULL OR v_max_seats <= 0 THEN
    RETURN NEW;
  END IF;

  -- Counted after the lock: a committed writer ahead of us is visible here.
  SELECT count(*) INTO v_used
    FROM public.organization_members m
   WHERE m.organization_id = NEW.organization_id
     AND m.id <> NEW.id
     AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);

  IF v_used < v_max_seats THEN
    RETURN NEW;
  END IF;

  -- The first claimed member of an organization with no access-granting claimed
  -- member always gets a seat (a pre-created organization full of invites must not
  -- lock out its own administrator).
  IF NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.organization_members m
     WHERE m.organization_id = NEW.organization_id
       AND m.id <> NEW.id
       AND m.user_id IS NOT NULL
       AND public.member_status_grants_access(m.license_status)
  ) THEN
    RAISE NOTICE 'seat_limit_first_member_over_limit organization_id=%', NEW.organization_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND public.member_origin_is_idp(NEW.provisioned_by) THEN
    NEW.license_status := 'unassigned';
    NEW.license_assigned_at := NULL;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'seat_limit_reached' USING ERRCODE = 'P0001',
    DETAIL = 'organization_id=' || NEW.organization_id::text;
END;
$function$;
REVOKE ALL ON FUNCTION public._enforce_member_seat_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._enforce_member_seat_limit() TO service_role;

DROP TRIGGER IF EXISTS seat_limit_enforce ON public.organization_members;
CREATE TRIGGER seat_limit_enforce
  BEFORE INSERT OR UPDATE OF license_status, organization_id, invitation_expires_at, user_id, license_assigned_at
  ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public._enforce_member_seat_limit();

-- ---------------------------------------------------------------------------
-- 5. Early seat counts on the invite paths follow the same seat rule
-- ---------------------------------------------------------------------------
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

CREATE OR REPLACE FUNCTION public.admin_invite_user(p_organization_id uuid DEFAULT NULL::uuid, p_email text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_invited_by uuid DEFAULT NULL::uuid, p_license_status text DEFAULT 'trial'::text, p_plan_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller_id uuid := auth.uid();
  v_token text;
  v_expires_at timestamptz;
  v_org_name text;
  v_existing_invite uuid;
  v_existing_user_id uuid;
  v_existing_member uuid;
  v_max_seats integer;
  v_member_count bigint;
  v_existing_org_id uuid;
  v_existing_org_name text;
BEGIN
  -- Auth checks
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT has_internal_role(v_caller_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_internal_user');
  END IF;

  IF NOT has_permission(v_caller_id, 'users.edit') THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_permissions');
  END IF;

  -- Validate email
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'email_required');
  END IF;

  -- Validate license_status
  IF p_license_status IS NOT NULL AND p_license_status NOT IN ('trial', 'active') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_license_status');
  END IF;

  -- Normalize email
  p_email := lower(trim(p_email));

  -- Generate token and expiry
  v_token := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + interval '7 days';

  -- ORG PATH
  IF p_organization_id IS NOT NULL THEN
    SELECT name, max_seats INTO v_org_name, v_max_seats
    FROM organizations WHERE id = p_organization_id;

    IF v_org_name IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'organization_not_found');
    END IF;

    -- Check duplicate within same org (existing check)
    SELECT id INTO v_existing_invite
    FROM organization_members
    WHERE organization_id = p_organization_id AND invited_email = p_email;

    IF v_existing_invite IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
        'existing_org_id', p_organization_id, 'existing_org_name', v_org_name);
    END IF;

    -- Check duplicate across OTHER orgs (pending invites only)
    SELECT om.organization_id, o.name INTO v_existing_org_id, v_existing_org_name
    FROM organization_members om
    JOIN organizations o ON o.id = om.organization_id
    WHERE om.invited_email = p_email AND om.license_status = 'pending'
    LIMIT 1;

    IF v_existing_org_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
        'existing_org_id', v_existing_org_id, 'existing_org_name', v_existing_org_name);
    END IF;

    -- Cross-table check — also check individual_invitations for pending invite
    SELECT id INTO v_existing_invite
    FROM individual_invitations
    WHERE invited_email = p_email AND accepted_at IS NULL;

    IF v_existing_invite IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
        'existing_org_id', null, 'existing_org_name', null);
    END IF;

    SELECT id INTO v_existing_user_id FROM users WHERE email = p_email;
    IF v_existing_user_id IS NOT NULL THEN
      SELECT id INTO v_existing_member
      FROM organization_members
      WHERE organization_id = p_organization_id AND user_id = v_existing_user_id;

      IF v_existing_member IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_member');
      END IF;
    END IF;

    IF v_max_seats IS NOT NULL THEN
      -- BACKLOG-3851: an expired, unclaimed invite holds no seat.
      SELECT count(*) INTO v_member_count
      FROM organization_members
      WHERE organization_id = p_organization_id
        AND public.member_row_holds_seat(license_status, invitation_expires_at, user_id);

      IF v_member_count >= v_max_seats THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat_limit_reached');
      END IF;
    END IF;

    INSERT INTO organization_members (
      organization_id, invited_email, role, license_status,
      invitation_token, invitation_expires_at, invited_by, invited_at,
      provisioned_by, provisioning_metadata
    ) VALUES (
      p_organization_id, p_email, COALESCE(p_role, 'agent'), 'pending',
      v_token, v_expires_at, p_invited_by, now(),
      'invite', jsonb_build_object('intended_license_status', p_license_status, 'plan_id', p_plan_id)
    );

    INSERT INTO admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_caller_id, 'invite_user', 'organization_member', p_organization_id,
      jsonb_build_object('email', p_email, 'role', p_role, 'org_name', v_org_name));

    RETURN jsonb_build_object('success', true, 'invitation_token', v_token, 'org_name', v_org_name);

  -- INDIVIDUAL PATH
  ELSE
    -- Check duplicate in individual_invitations (existing check)
    SELECT id INTO v_existing_invite
    FROM individual_invitations WHERE invited_email = p_email AND accepted_at IS NULL;

    IF v_existing_invite IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
        'existing_org_id', null, 'existing_org_name', null);
    END IF;

    -- Cross-table check — also check organization_members for pending invite
    SELECT om.organization_id, o.name INTO v_existing_org_id, v_existing_org_name
    FROM organization_members om
    JOIN organizations o ON o.id = om.organization_id
    WHERE om.invited_email = p_email AND om.license_status = 'pending'
    LIMIT 1;

    IF v_existing_org_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
        'existing_org_id', v_existing_org_id, 'existing_org_name', v_existing_org_name);
    END IF;

    INSERT INTO individual_invitations (
      invited_email, invitation_token, invitation_expires_at, invited_by,
      invited_at, license_status, plan_id
    ) VALUES (
      p_email, v_token, v_expires_at, p_invited_by,
      now(), COALESCE(p_license_status, 'trial'), p_plan_id
    );

    INSERT INTO admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_caller_id, 'invite_individual_user', 'user', v_caller_id,
      jsonb_build_object('email', p_email, 'license_status', p_license_status));

    RETURN jsonb_build_object('success', true, 'invitation_token', v_token, 'org_name', NULL);
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. set_member_license
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_license(p_member_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_org_id       uuid;
  v_personal     boolean;
  v_target       record;
  v_caller_role  text;
  v_new_status   text;
  v_managers     integer;
BEGIN
  IF v_uid IS NULL OR p_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('assign', 'unassign', 'reactivate') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_transition');
  END IF;

  SELECT m.organization_id INTO v_org_id
    FROM public.organization_members m WHERE m.id = p_member_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  -- Lock first: every count and status read below is taken under it.
  SELECT o.personal_owner_user_id IS NOT NULL INTO v_personal
    FROM public.organizations o WHERE o.id = v_org_id
    FOR NO KEY UPDATE;

  SELECT m.role INTO v_caller_role
    FROM public.organization_members m
   WHERE m.organization_id = v_org_id
     AND m.user_id = v_uid
     AND public.member_status_grants_access(m.license_status);
  IF v_caller_role IS NULL
     OR v_caller_role NOT IN ('broker', 'admin', 'it_admin')
     OR (p_action = 'reactivate' AND v_caller_role NOT IN ('admin', 'it_admin')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  SELECT m.id, m.user_id, m.role, m.license_status INTO v_target
    FROM public.organization_members m
   WHERE m.id = p_member_id AND m.organization_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_target.user_id = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized', 'reason', 'own_membership');
  END IF;
  IF v_target.role = 'it_admin' AND v_caller_role <> 'it_admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_personal IS DISTINCT FROM false OR v_target.user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_transition');
  END IF;

  IF p_action = 'assign' AND v_target.license_status = 'unassigned' THEN
    v_new_status := 'active';
  ELSIF p_action = 'unassign' AND v_target.license_status = 'active' THEN
    v_new_status := 'unassigned';
  ELSIF p_action = 'reactivate' AND public.member_status_is_deactivated(v_target.license_status) THEN
    v_new_status := 'active';
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'invalid_transition');
  END IF;

  IF v_new_status = 'unassigned' AND v_target.role IN ('broker', 'admin', 'it_admin') THEN
    SELECT count(*) INTO v_managers
      FROM public.organization_members m
     WHERE m.organization_id = v_org_id
       AND m.id <> v_target.id
       AND m.user_id IS NOT NULL
       AND m.role IN ('broker', 'admin', 'it_admin')
       AND public.member_status_grants_access(m.license_status);
    IF v_managers = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'last_manager');
    END IF;
  END IF;

  BEGIN
    UPDATE public.organization_members
       SET license_status = v_new_status
     WHERE id = v_target.id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'seat_limit_reached' THEN
      RETURN jsonb_build_object('success', false, 'error', 'seat_limit_reached', 'action', p_action);
    END IF;
    RAISE;
  END;

  RETURN jsonb_build_object('success', true, 'member_id', v_target.id, 'license_status', v_new_status);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_member_license(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_license(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Feature lookups require an access-granting membership
-- ---------------------------------------------------------------------------
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
  -- Verify caller is a member of the organization whose licence grants access
  -- (BACKLOG-3851: a deactivated or unassigned member gets not_authorized).
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid() AND organization_id = p_org_id
      AND public.member_status_grants_access(license_status)
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
$function$;

CREATE OR REPLACE FUNCTION public.check_feature_access(p_org_id uuid, p_feature_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_feature RECORD;
  v_plan_feature RECORD;
  v_org_plan RECORD;
  v_override JSONB;
  v_result_enabled BOOLEAN;
  v_result_value TEXT;
  v_blocked BOOLEAN := false;
BEGIN
  -- 0. Verify caller is a member of the organization whose licence grants access
  --    (BACKLOG-3851: a deactivated or unassigned member gets not_authorized).
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid() AND organization_id = p_org_id
      AND public.member_status_grants_access(license_status)
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'not_authorized');
  END IF;

  -- 1. Get the feature definition
  SELECT * INTO v_feature
  FROM public.feature_definitions
  WHERE key = p_feature_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'unknown_feature', 'feature_key', p_feature_key);
  END IF;

  -- 2. Get the org's plan
  SELECT op.*, p.tier INTO v_org_plan
  FROM public.organization_plans op
  JOIN public.plans p ON p.id = op.plan_id
  WHERE op.organization_id = p_org_id;

  IF NOT FOUND THEN
    -- No plan assigned: use feature default
    RETURN jsonb_build_object(
      'allowed', v_feature.default_value = 'true',
      'value', v_feature.default_value,
      'source', 'default'
    );
  END IF;

  -- 3. Check for per-org override
  v_override := v_org_plan.feature_overrides -> p_feature_key;
  -- BACKLOG-3845: an expired or malformed paid_through makes the override absent.
  IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN
    v_override := NULL;
  END IF;
  v_blocked := v_override IS NOT NULL
               AND public._override_above_tier(p_feature_key, v_feature.min_tier, v_org_plan.tier, v_override);
  IF v_override IS NOT NULL AND NOT v_blocked THEN
    v_result_enabled := COALESCE((v_override ->> 'enabled')::boolean, true);
    v_result_value := COALESCE(v_override ->> 'value', v_feature.default_value);
    RETURN jsonb_build_object(
      'allowed', v_result_enabled,
      'value', v_result_value,
      'source', 'override'
    );
  END IF;

  -- 4. Check plan-level feature
  SELECT * INTO v_plan_feature
  FROM public.plan_features pf
  WHERE pf.plan_id = v_org_plan.plan_id
    AND pf.feature_id = v_feature.id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', v_plan_feature.enabled,
      'value', COALESCE(v_plan_feature.value, v_feature.default_value),
      'source', 'plan'
    ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END;
  END IF;

  -- 5. Feature not explicitly in plan: use default
  RETURN jsonb_build_object(
    'allowed', v_feature.default_value = 'true',
    'value', v_feature.default_value,
    'source', 'default'
  ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END;
END;
$function$;
