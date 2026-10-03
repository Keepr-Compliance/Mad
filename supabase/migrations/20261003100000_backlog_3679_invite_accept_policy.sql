-- BACKLOG-3679: invite acceptance on organization_members.
--
-- 1. users_can_accept_invite is re-created for `authenticated`. It matches the
--    invite by the email claim in the caller's JWT (lower-cased, trimmed), only
--    while the row is unclaimed and unexpired, and its WITH CHECK requires the
--    new row to name the caller as user_id.
-- 2. users_can_view_own_invite lets a signed-in user read their own unclaimed,
--    unexpired invite row (the portal sign-in callback looks it up by email).
-- 3. guard_invite_acceptance (BEFORE UPDATE): a client-role update never
--    changes organization_id, and an organization admin's update keeps
--    user_id unchanged. Any other client-role update is limited to: user_id
--    set to the caller on an unclaimed row, joined_at, license_status -> 'active',
--    invitation_token -> NULL. Every other column must stay unchanged.
--    service_role and SECURITY DEFINER functions are not affected by the guard.

DROP POLICY IF EXISTS users_can_accept_invite ON public.organization_members;

CREATE POLICY users_can_accept_invite ON public.organization_members
  FOR UPDATE TO authenticated
  USING (
    user_id IS NULL
    AND invited_email IS NOT NULL
    AND lower(btrim(invited_email)) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
    AND (invitation_expires_at IS NULL OR invitation_expires_at > now())
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND invited_email IS NOT NULL
    AND lower(btrim(invited_email)) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
  );

DROP POLICY IF EXISTS users_can_view_own_invite ON public.organization_members;

CREATE POLICY users_can_view_own_invite ON public.organization_members
  FOR SELECT TO authenticated
  USING (
    user_id IS NULL
    AND invited_email IS NOT NULL
    AND lower(btrim(invited_email)) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
    AND (invitation_expires_at IS NULL OR invitation_expires_at > now())
  );

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

-- Trigger function: no client role calls it directly.
REVOKE EXECUTE ON FUNCTION public.guard_invite_acceptance() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_invite_acceptance ON public.organization_members;

CREATE TRIGGER guard_invite_acceptance
  BEFORE UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_invite_acceptance();
