-- BACKLOG-3851 M3 (PR-2c): a SCIM-origin INSERT into a full brokerage is refused.
--
-- 1. Pre-check: abort unless public._enforce_member_seat_limit()'s body is the M1 body
--    (md5 36378addf67c120c00e4aa5a4afeb662, production and keepr-test) or this file's
--    body (md5 2080be6b61fb35e5e3b933bf88f71c00; a second apply is a no-op).
-- 2. public.member_origin_joins_unlicensed(text) (IMMUTABLE, SECURITY INVOKER,
--    search_path ''): true for 'jit' and 'directory_sync'; false for 'scim', 'manual',
--    'invite', NULL and any other value. EXECUTE revoked from PUBLIC and anon; granted to
--    authenticated and service_role.
-- 3. public._enforce_member_seat_limit(): CREATE OR REPLACE, one condition changes. The
--    'unassigned' rewrite of an over-limit INSERT now applies only when
--    member_origin_joins_unlicensed(NEW.provisioned_by) (was member_origin_is_idp).
--    A 'scim' INSERT into a full organization therefore raises seat_limit_reached
--    (SQLSTATE P0001) like every other non-rewritten write. The first-member rule, the
--    lock, the count, the timestamps, the signature, SECURITY DEFINER, VOLATILE,
--    search_path, the ACL, the trigger and its column list are unchanged.
-- 4. member_origin_is_idp(text) is unchanged ('scim' is still an identity-provider origin).
--
-- Apply as one transaction. No BEGIN/COMMIT here.
-- Rollback: supabase/tests/backlog-3851/rollback-3851-m3.sql

DO $pre$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public._enforce_member_seat_limit()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('36378addf67c120c00e4aa5a4afeb662', '2080be6b61fb35e5e3b933bf88f71c00') THEN
    RAISE EXCEPTION 'BACKLOG-3851 M3 pre-check: _enforce_member_seat_limit body differs from the expected one (md5 %)', v_md5;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.member_origin_joins_unlicensed(p_provisioned_by text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(p_provisioned_by IN ('jit', 'directory_sync'), false);
$function$;
REVOKE ALL ON FUNCTION public.member_origin_joins_unlicensed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_origin_joins_unlicensed(text) TO authenticated, service_role;

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

  IF TG_OP = 'INSERT' AND public.member_origin_joins_unlicensed(NEW.provisioned_by) THEN
    NEW.license_status := 'unassigned';
    NEW.license_assigned_at := NULL;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'seat_limit_reached' USING ERRCODE = 'P0001',
    DETAIL = 'organization_id=' || NEW.organization_id::text;
END;
$function$;
