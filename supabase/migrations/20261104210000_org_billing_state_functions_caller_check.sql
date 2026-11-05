-- BACKLOG-4048: caller check inside org_billing_suspended(uuid) and org_billing_service_off(uuid).
--
-- Rule: both functions return an organization's billing state to its members (any licence
-- status), to users who submitted a transaction in it, to internal staff (any internal_roles
-- row) and to the service role. Every other caller gets false. A null organization gets false.
-- A session with no request role (no PostgREST request: cron, migrations, the database owner)
-- is treated as server-side and gets the real value.
--
-- Objects:
--  1. _org_billing_state_visible(uuid): new helper holding the rule above. SECURITY DEFINER,
--     search_path ''. EXECUTE for service_role only (the two functions call it as their owner).
--  2. org_billing_suspended(uuid), org_billing_service_off(uuid): same signature, same
--     STABLE SECURITY DEFINER search_path '', same privileges (authenticated + service_role;
--     not PUBLIC, not anon). The org_deals lookup is ANDed with the helper.
--
-- The submitter term relies on trigger status_history_append_only
-- (guard_status_history_append_only), which refuses a client statement that changes a
-- submission's organization_id or submitted_by (submission_owner_fields_locked).
--
-- Pins: both replaced bodies (md5 of the production body read 2026-11-04, or this file's own
-- body on a second apply). Any drift stops the migration before anything changes.
-- Rollback: supabase/tests/backlog-4048/rollback.sql.

-- 0. Pins
DO $pin$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.org_billing_suspended(uuid)');
  IF v_src IS NULL OR (md5(v_src) <> '22c2a8f2df610fef3fba55b9085939fc'
                       AND v_src NOT LIKE '%_org_billing_state_visible%') THEN
    RAISE EXCEPTION 'BACKLOG-4048: org_billing_suspended body changed (md5 %); re-review before applying',
      coalesce(md5(v_src), '<missing>');
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.org_billing_service_off(uuid)');
  IF v_src IS NULL OR (md5(v_src) <> '79c10d873c207522fbf08c0f8e02af64'
                       AND v_src NOT LIKE '%_org_billing_state_visible%') THEN
    RAISE EXCEPTION 'BACKLOG-4048: org_billing_service_off body changed (md5 %); re-review before applying',
      coalesce(md5(v_src), '<missing>');
  END IF;
END $pin$;

-- 1. The helper
CREATE OR REPLACE FUNCTION public._org_billing_state_visible(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT p_org IS NULL
      OR auth.role() IS NULL
      OR auth.role() = 'service_role'
      OR EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org AND m.user_id = (SELECT auth.uid()))
      OR EXISTS (SELECT 1 FROM public.transaction_submissions s
                  WHERE s.organization_id = p_org AND s.submitted_by = (SELECT auth.uid()))
      OR EXISTS (SELECT 1 FROM public.internal_roles r WHERE r.user_id = (SELECT auth.uid()));
$function$;

REVOKE ALL ON FUNCTION public._org_billing_state_visible(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_state_visible(uuid) TO service_role;
COMMENT ON FUNCTION public._org_billing_state_visible(uuid) IS
  'BACKLOG-4048: true for a null organization, a session with no request role, the service role, a member of the organization (any licence status), a user who submitted a transaction in it, or internal staff; false otherwise. Used by org_billing_suspended and org_billing_service_off.';

-- 2. The two state functions
CREATE OR REPLACE FUNCTION public.org_billing_suspended(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.org_deals d
                  WHERE d.organization_id = p_org AND d.status = 'suspended')
     AND public._org_billing_state_visible(p_org);
$function$;

REVOKE ALL ON FUNCTION public.org_billing_suspended(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_billing_suspended(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.org_billing_suspended(uuid) IS
  'BACKLOG-3853/4048: the only suspension predicate. Returns the state to members, submitters, staff and the service role; false otherwise. Executable by authenticated because RLS policies call it.';

CREATE OR REPLACE FUNCTION public.org_billing_service_off(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.org_deals d
                  WHERE d.organization_id = p_org AND d.status IN ('suspended', 'canceled'))
     AND public._org_billing_state_visible(p_org);
$function$;

REVOKE ALL ON FUNCTION public.org_billing_service_off(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_billing_service_off(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.org_billing_service_off(uuid) IS
  'BACKLOG-4019/4048: suspended or canceled; submission and review gates read this. Returns the state to members, submitters, staff and the service role; false otherwise.';
