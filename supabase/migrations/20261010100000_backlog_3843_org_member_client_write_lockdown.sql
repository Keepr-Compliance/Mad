-- BACKLOG-3843: client-role write limits on organizations and organization_members.
-- 1. organizations: a BEFORE UPDATE guard. Client roles (authenticated, anon) may
--    change only retention_years, jit_provisioning_enabled,
--    graph_admin_consent_granted, graph_admin_consent_at and updated_at.
-- 2. organization_members, UPDATE: an organization admin may change only role,
--    invitation_token, invitation_expires_at and updated_at; an invitee may claim
--    only a pending invite.
-- 3. organization_members, INSERT: a client role may insert only an unclaimed
--    pending invite created by the caller, within the organization's seat limit.
-- Roles other than authenticated/anon (service_role, postgres, and SECURITY
-- DEFINER functions, which run as their owner) are not limited.

-- ---------------------------------------------------------------------------
-- 1. organizations
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_organization_client_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_free text[] := ARRAY['retention_years', 'jit_provisioning_enabled',
                         'graph_admin_consent_granted', 'graph_admin_consent_at',
                         'updated_at'];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Compared by value: re-sending an unchanged column passes; a column added
  -- to the table later is not client-writable until it is listed above.
  IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION 'This organization setting cannot be changed from a client session'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_organization_client_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_organization_client_update ON public.organizations;

CREATE TRIGGER guard_organization_client_update
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.guard_organization_client_update();

-- ---------------------------------------------------------------------------
-- 2 + 3. organization_members
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_invite_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
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

DROP TRIGGER IF EXISTS guard_invite_acceptance ON public.organization_members;

CREATE TRIGGER guard_invite_acceptance
  BEFORE INSERT OR UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_invite_acceptance();
