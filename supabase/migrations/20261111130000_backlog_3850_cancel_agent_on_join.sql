-- BACKLOG-3850: end the personal Agent plan when the member joins a brokerage.
--
-- Plan pm_comments d443fb5b, SR review 989c8798 (R2, R10), rulings 35b3b3ab and 89ef80a7.
--
-- 1. public._billing_enqueue_agent_cancel_on_join(p_user, p_org, p_member): one billing_outbox row
--    of kind cancel_agent_on_brokerage_join per stripe_customers row of the user (one per mode).
--    organization_id stays NULL (the row is about the user); the payload carries the brokerage, the
--    member row and the customer id seen at enqueue (F3: the handler refuses when it changed).
--    The dedupe key carries clock_timestamp(), so a later join (reactivation) gets its own row.
--    Two EXCEPTION levels, as 20261013170000 (3878): a join never fails because of billing.
-- 2. public._retire_personal_membership(): the 20261016100100 body plus GET DIAGNOSTICS after
--    the DELETE; the enqueue runs only when a personal membership row was actually removed, so
--    an INSERT followed by UPDATEs in one transaction enqueues once.
--
-- The trigger (20261016100100:243-247) is unchanged and is asserted below.
-- WARNING: supabase/tests/backlog-3851/rollback-3851*.sql replace _retire_personal_membership with
-- older bodies and would silently remove this enqueue if ever run. Use rollback-3850.sql here.
-- Rollback: supabase/tests/backlog-3850/rollback-3850.sql. Harness: supabase/tests/backlog-3850/.

-- Pre-check: the body being replaced is 20261016100100:206-241 (prod and keepr-test, 2026-11-10).
DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public._retire_personal_membership()'::regprocedure;
  IF v IS DISTINCT FROM 'a3201c3a731a968397bebe5ccc1b1421'
     AND v IS DISTINCT FROM 'f33aaeeb64a174056620abf5179b91b4' THEN
    RAISE EXCEPTION 'BACKLOG-3850: _retire_personal_membership md5 % is not the expected body', v;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._billing_enqueue_agent_cancel_on_join(p_user uuid, p_org uuid, p_member uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cust  record;
  v_stamp text;
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;
  v_stamp := (floor(extract(epoch FROM clock_timestamp()) * 1000000))::bigint::text;

  FOR v_cust IN
    SELECT sc.stripe_mode, sc.stripe_customer_id FROM public.stripe_customers sc WHERE sc.user_id = p_user
  LOOP
    BEGIN
      INSERT INTO public.billing_outbox (stripe_mode, kind, user_id, dedupe_key, payload, run_after)
      VALUES (v_cust.stripe_mode, 'cancel_agent_on_brokerage_join', p_user,
              'join-cancel:' || v_cust.stripe_mode || ':' || p_user::text || ':' || v_stamp,
              jsonb_build_object('brokerage_organization_id', p_org,
                                 'member_id', p_member,
                                 'stripe_customer_id', v_cust.stripe_customer_id),
              now())
      ON CONFLICT (dedupe_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'BACKLOG-3850: join cancel row not enqueued for user % (%): % %',
        p_user, v_cust.stripe_mode, SQLSTATE, SQLERRM;
    END;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'BACKLOG-3850: join cancel enqueue failed for user %: % %', p_user, SQLSTATE, SQLERRM;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid) TO service_role;
COMMENT ON FUNCTION public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid) IS
  'BACKLOG-3850: enqueue cancel_agent_on_brokerage_join (one row per stripe_customers mode) when a personal membership is retired at a brokerage join. Called only by _retire_personal_membership.';

CREATE OR REPLACE FUNCTION public._retire_personal_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows integer;
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
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- BACKLOG-3850: only the fire that retired the personal row ends the Agent plan.
  IF v_rows > 0 THEN
    PERFORM public._billing_enqueue_agent_cancel_on_join(NEW.user_id, NEW.organization_id, NEW.id);
  END IF;

  RETURN NULL;
END;
$function$;

-- Post-check: body, ACLs and the unchanged trigger.
-- POSTCHECK BEGIN
DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public._retire_personal_membership()'::regprocedure;
  IF v IS DISTINCT FROM 'f33aaeeb64a174056620abf5179b91b4' THEN
    RAISE EXCEPTION 'BACKLOG-3850: _retire_personal_membership md5 % after apply', v;
  END IF;
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)'::regprocedure;
  IF v IS DISTINCT FROM '15e5b413e5269afc588ddbbb627cccf2' THEN
    RAISE EXCEPTION 'BACKLOG-3850: _billing_enqueue_agent_cancel_on_join md5 % after apply', v;
  END IF;
  IF has_function_privilege('anon', 'public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._retire_personal_membership()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._retire_personal_membership()', 'EXECUTE') THEN
    RAISE EXCEPTION 'BACKLOG-3850: a client role can execute a 3850 function';
  END IF;
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
       WHERE t.tgrelid = 'public.organization_members'::regclass AND t.tgname = 'retire_personal_membership')
     IS DISTINCT FROM 'CREATE TRIGGER retire_personal_membership AFTER INSERT OR UPDATE OF user_id, organization_id, license_status ON public.organization_members FOR EACH ROW WHEN ((new.user_id IS NOT NULL)) EXECUTE FUNCTION _retire_personal_membership()' THEN
    RAISE EXCEPTION 'BACKLOG-3850: retire_personal_membership trigger is not the expected one';
  END IF;
END
$guard$;
-- POSTCHECK END
