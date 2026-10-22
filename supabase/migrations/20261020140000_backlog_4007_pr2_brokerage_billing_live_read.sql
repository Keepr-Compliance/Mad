-- BACKLOG-4007 PR-2 fix-up: admin_get_brokerage_billing_live()
--
-- Returns the brokerage billing switch (public._billing_brokerage_live(), the value
-- admin_get_org_billing reports as billing_live and the org page uses to decide whether the
-- Billing card shows). Create Organization reads it to decide whether to ask for Max Seats:
-- while the switch is off, staff set seats on create; once it is on, the deal sets them.
--
-- Callable by internal staff only (has_internal_role). Read-only.
-- CREATE OR REPLACE only.
-- Apply order: after 20261018230000 (which creates _billing_brokerage_live).

DO $pre$
BEGIN
  IF to_regprocedure('public._billing_brokerage_live()') IS NULL THEN
    RAISE EXCEPTION '4007 PR-2 pre-check: public._billing_brokerage_live() is missing';
  END IF;
  IF to_regprocedure('public.has_internal_role(uuid)') IS NULL THEN
    RAISE EXCEPTION '4007 PR-2 pre-check: public.has_internal_role(uuid) is missing';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.admin_get_brokerage_billing_live()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(public.has_internal_role(v_uid), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN public._billing_brokerage_live();
END
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_get_brokerage_billing_live() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_brokerage_billing_live() TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_get_brokerage_billing_live() IS
  'BACKLOG-4007: brokerage billing switch for internal staff (Create Organization shows Max Seats only while it is off).';
