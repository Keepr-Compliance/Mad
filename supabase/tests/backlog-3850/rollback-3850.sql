-- BACKLOG-3850 rollback: undo supabase/migrations/20261111130000_backlog_3850_cancel_agent_on_join.sql.
-- Restores _retire_personal_membership to 20261016100100:206-241 exactly (md5 a3201c3a) and drops
-- _billing_enqueue_agent_cancel_on_join. The trigger is untouched (the migration did not change it).
-- Rows of kind cancel_agent_on_brokerage_join already queued stay; with the portal handler gone
-- they park as unknown_kind. Run before removing the handler from the portal, never after.

DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public._retire_personal_membership()'::regprocedure;
  IF v IS DISTINCT FROM 'f33aaeeb64a174056620abf5179b91b4' AND v IS DISTINCT FROM 'a3201c3a731a968397bebe5ccc1b1421' THEN
    RAISE EXCEPTION 'BACKLOG-3850 rollback: _retire_personal_membership md5 % is neither the 3850 nor the 3851 body', v;
  END IF;
END
$guard$;

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

  -- BACKLOG-3851: a deactivated brokerage membership keeps the personal one.
  IF public.member_status_is_deactivated(NEW.license_status) THEN
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

DROP FUNCTION IF EXISTS public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid);

DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public._retire_personal_membership()'::regprocedure;
  IF v IS DISTINCT FROM 'a3201c3a731a968397bebe5ccc1b1421' THEN
    RAISE EXCEPTION 'BACKLOG-3850 rollback: md5 % after rollback', v;
  END IF;
  IF to_regprocedure('public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-3850 rollback: enqueue function still present';
  END IF;
END
$guard$;
