-- BACKLOG-3538 rollback. Restores the BACKLOG-3679 guard body, EXECUTE on
-- claim_pending_invite() for PUBLIC and anon, and handle_new_user_invitation_link()
-- as it was in production on 2026-10-07 (pg_get_functiondef md5
-- 7a729dffa5e5b01f4a680eb137d1d648).
BEGIN;

-- (1) guard: lines 43-87 of 20261003061523_backlog_3679_invite_accept_policy.sql, verbatim.
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

  RETURN NEW;
END;
$function$;

-- (2)
DO $do$
BEGIN
  IF to_regprocedure('public.claim_pending_invite()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.claim_pending_invite() TO PUBLIC, anon;
  END IF;
END
$do$;

-- (3)
CREATE OR REPLACE FUNCTION public.handle_new_user_invitation_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Link any pending invitations by email
  UPDATE public.organization_members
  SET
    user_id = NEW.id,
    joined_at = NOW(),
    license_status = 'active'
  WHERE invited_email = NEW.email
  AND user_id IS NULL;

  RETURN NEW;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.handle_new_user_invitation_link() TO PUBLIC, anon, authenticated, service_role;

COMMIT;
