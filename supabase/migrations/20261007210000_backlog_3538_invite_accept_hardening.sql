-- BACKLOG-3538: invite-accept leftovers after BACKLOG-3679.
-- 1. guard_invite_acceptance: an invitee's accept stores joined_at = now().
-- 2. claim_pending_invite(): EXECUTE removed from PUBLIC and anon.
-- 3. handle_new_user_invitation_link(): dropped.

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

-- CREATE OR REPLACE keeps the ACL; restated so this file carries its own grants.
REVOKE EXECUTE ON FUNCTION public.guard_invite_acceptance() FROM PUBLIC, anon, authenticated;

DO $do$
BEGIN
  IF to_regprocedure('public.claim_pending_invite()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.claim_pending_invite() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.claim_pending_invite() TO authenticated, service_role;
  END IF;
END
$do$;

-- 3. handle_new_user_invitation_link() has no trigger and no dependent object in
-- production. A database rebuilt by replaying 20260122_b2b_broker_portal.sql
-- (line 564) also has the trigger on_auth_user_created_link_invitations on
-- auth.users, which production does not have; how that trigger was removed from
-- production is UNTRACED. In such a database this plain DROP fails on the
-- dependency, on purpose.
DROP FUNCTION IF EXISTS public.handle_new_user_invitation_link();
