-- BACKLOG-3843 rollback: restores the state after BACKLOG-3538
-- (guard_invite_acceptance as in 20261007210000, BEFORE UPDATE only) and removes
-- the organizations guard. Run as postgres in one transaction.
BEGIN;

DROP TRIGGER IF EXISTS guard_organization_client_update ON public.organizations;
DROP FUNCTION IF EXISTS public.guard_organization_client_update();

CREATE OR REPLACE FUNCTION public.guard_invite_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_free text[] := ARRAY['user_id', 'joined_at', 'license_status', 'invitation_token', 'updated_at'];
BEGIN
  -- Only client roles are limited. service_role, postgres and SECURITY DEFINER
  -- functions (which run as their owner) pass unchanged.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- No client role moves a membership between organizations.
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'organization_id cannot be changed' USING ERRCODE = '42501';
  END IF;

  -- Organization admins edit members of their organization through
  -- organization_members_all_public; the organization and the member's
  -- user_id stay the same.
  IF v_uid IS NOT NULL
     AND public.is_org_admin(v_uid, OLD.organization_id)
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;

  -- Anyone else can only accept their own invite.
  IF v_uid IS NULL
     OR OLD.user_id IS NOT NULL
     OR NEW.user_id IS DISTINCT FROM v_uid
     OR (NEW.license_status IS DISTINCT FROM OLD.license_status AND NEW.license_status IS DISTINCT FROM 'active')
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
  BEFORE UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_invite_acceptance();

COMMIT;
