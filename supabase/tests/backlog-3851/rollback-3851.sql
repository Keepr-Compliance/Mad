-- BACKLOG-3851 rollback: undoes M2 (20261016100100) and M1 (20261015152446).
-- Runs after M1 alone or after M1 + M2. One transaction; run with psql, not as a migration.
-- Order (plan §4, R7):
--   1. the two new triggers out first, so nothing below fires them;
--   2. the retire trigger back to its production column list;
--   3. the six replaced functions back to production's bodies, verbatim (read 2026-10-14,
--      ledger 20261014152904); CREATE OR REPLACE keeps their ACLs;
--   4. 'unassigned' rows -> 'suspended' (ids printed first);
--   5. the status CHECK re-created under the same name without 'unassigned';
--   6. the seven new functions dropped;
--   7. license_assigned_at KEPT (data; harmless to every production reader).
--
-- NOT undone (R7d): personal organizations attached by the M2 revert trigger (or by the
-- desktop self-heal after M2) stay. After the rollback those users hold a suspended
-- brokerage row AND a personal row. If the production broker portal at that moment does
-- not yet read two rows (PR-2a not deployed on main), ALSO run step 8 below, which lists
-- and then retires those personal memberships.
BEGIN;

-- 1.
DROP TRIGGER IF EXISTS revert_deactivated_member ON public.organization_members;
DROP TRIGGER IF EXISTS seat_limit_enforce ON public.organization_members;

-- 2.
DROP TRIGGER IF EXISTS retire_personal_membership ON public.organization_members;
CREATE TRIGGER retire_personal_membership
  AFTER INSERT OR UPDATE OF user_id, organization_id ON public.organization_members
  FOR EACH ROW WHEN (new.user_id IS NOT NULL)
  EXECUTE FUNCTION public._retire_personal_membership();

-- 3.
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

    -- Same rule as the invite form: active + pending members must stay below max_seats.
    SELECT o.max_seats INTO v_max_seats FROM public.organizations o WHERE o.id = NEW.organization_id;
    IF v_max_seats IS NOT NULL AND v_max_seats > 0 THEN
      SELECT count(*) INTO v_used
        FROM public.organization_members m
       WHERE m.organization_id = NEW.organization_id
         AND m.license_status IN ('active', 'pending');
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
      SELECT count(*) INTO v_member_count
      FROM organization_members
      WHERE organization_id = p_organization_id
        AND license_status IN ('active', 'pending');

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
  -- 0. Verify caller is a member of the organization
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid() AND organization_id = p_org_id
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

CREATE OR REPLACE FUNCTION public._ensure_personal_organization_for(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email   text;
  v_plan_id uuid;
  v_org_id  uuid;
  v_created boolean := false;
  v_rows    integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_user');
  END IF;

  -- One ensure / retirement at a time per user.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 3364));

  -- Any membership in a non-personal organization, whatever its status.
  IF EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = p_user_id
      AND o.personal_owner_user_id IS NULL
  ) THEN
    RETURN jsonb_build_object('status', 'has_membership');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.licenses WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'no_license');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'no_user');
  END IF;

  -- An unclaimed invite that has not expired: the invite decides. Same email
  -- source, match and expiry rule as public.claim_pending_invite.
  SELECT COALESCE(
           NULLIF(TRIM(email), ''),
           NULLIF(TRIM(raw_user_meta_data->>'email'), ''),
           raw_user_meta_data->>'mail',
           raw_user_meta_data->>'preferred_username'
         )
    INTO v_email
    FROM auth.users
   WHERE id = p_user_id;

  IF v_email IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE user_id IS NULL
      AND LOWER(TRIM(invited_email)) = LOWER(TRIM(v_email))
      AND (invitation_expires_at IS NULL OR invitation_expires_at >= NOW())
  ) THEN
    RETURN jsonb_build_object('status', 'pending_invite');
  END IF;

  SELECT id
    INTO v_plan_id
    FROM public.plans
   WHERE tier = 'individual'
     AND is_default
     AND is_active
   ORDER BY sort_order, created_at, id
   LIMIT 1;

  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_default_plan');
  END IF;

  INSERT INTO public.organizations
    (name, slug, max_seats, jit_provisioning_enabled, default_member_role, personal_owner_user_id)
  VALUES
    ('Personal', 'personal-' || replace(p_user_id::text, '-', ''), 1, false, 'agent', p_user_id)
  ON CONFLICT (personal_owner_user_id) WHERE personal_owner_user_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_org_id;

  IF v_org_id IS NOT NULL THEN
    v_created := true;
  ELSE
    SELECT id INTO v_org_id
      FROM public.organizations
     WHERE personal_owner_user_id = p_user_id;
  END IF;

  -- Attach only to an organization that holds no other membership row.
  IF EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = v_org_id
      AND user_id IS DISTINCT FROM p_user_id
  ) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  INSERT INTO public.organization_plans (organization_id, plan_id)
  VALUES (v_org_id, v_plan_id)
  ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO public.organization_members
    (organization_id, user_id, role, license_status, joined_at, provisioned_by)
  VALUES
    (v_org_id, p_user_id, 'agent', 'active', NOW(), NULL)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_created THEN 'created'
                   WHEN v_rows > 0 THEN 'attached'
                   ELSE 'exists' END,
    'organization_id', v_org_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._retire_personal_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE id = NEW.organization_id
      AND personal_owner_user_id IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 3364));

  DELETE FROM public.organization_members m
   USING public.organizations o
   WHERE m.organization_id = o.id
     AND o.personal_owner_user_id IS NOT NULL
     AND m.user_id = NEW.user_id;

  RETURN NULL;
END;
$function$;

-- 4.
DO $rb$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.organization_members WHERE license_status = 'unassigned' ORDER BY id LOOP
    RAISE NOTICE 'rollback-3851: unassigned -> suspended: member %', r.id;
  END LOOP;
END $rb$;
UPDATE public.organization_members SET license_status = 'suspended' WHERE license_status = 'unassigned';

-- 5.
ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_license_status_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_license_status_check
  CHECK (license_status IN ('pending', 'active', 'suspended', 'expired'));

-- 6.
DROP FUNCTION IF EXISTS public._revert_deactivated_member_to_paygo();
DROP FUNCTION IF EXISTS public._enforce_member_seat_limit();
DROP FUNCTION IF EXISTS public.set_member_license(uuid, text);
DROP FUNCTION IF EXISTS public.member_row_holds_seat(text, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.member_origin_is_idp(text);
DROP FUNCTION IF EXISTS public.member_status_is_deactivated(text);
DROP FUNCTION IF EXISTS public.member_status_holds_seat(text);

-- 7. license_assigned_at kept.

-- 8. ONLY if the production portal does not read two membership rows (see header):
-- SELECT m.id, m.user_id FROM public.organization_members m
--   JOIN public.organizations o ON o.id = m.organization_id AND o.personal_owner_user_id = m.user_id
--  WHERE EXISTS (SELECT 1 FROM public.organization_members b JOIN public.organizations bo ON bo.id = b.organization_id
--                 WHERE b.user_id = m.user_id AND bo.personal_owner_user_id IS NULL);
-- DELETE FROM public.organization_members m USING public.organizations o
--  WHERE o.id = m.organization_id AND o.personal_owner_user_id = m.user_id
--    AND EXISTS (SELECT 1 FROM public.organization_members b JOIN public.organizations bo ON bo.id = b.organization_id
--                 WHERE b.user_id = m.user_id AND bo.personal_owner_user_id IS NULL);

COMMIT;
