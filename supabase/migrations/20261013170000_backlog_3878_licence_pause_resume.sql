-- BACKLOG-3878 PR-2 (billing epic BACKLOG-3648): pause an Agent plan while the
-- account is suspended, resume it on reinstatement.
--
-- One AFTER UPDATE OF status trigger on licenses covers every writer of
-- licenses.status (suspend_account_for_dispute, admin_suspend_user,
-- admin_unsuspend_user, reinstate_suspended_account, admin_update_license)
-- without touching their bodies. It only enqueues billing_outbox rows; the
-- broker portal's drain runs them (lib/billing/suspension.ts), converging from
-- the licence and from Stripe:
--   -> 'suspended'            : one 'pause_agent_subscription' row
--   'suspended' -> 'active'   : one 'resume_agent_subscription' row
-- per stripe_customers row of the user (one per Stripe mode; SR R6: keyed on
-- the customer, not on the billing_subscriptions mirror, which lags the
-- webhook). A reinstatement to anything other than 'active' enqueues nothing:
-- that plan stays paused and support decides.
--
-- dedupe_key: '<pause|resume>:<mode>:<user>:<clock_timestamp in microseconds>'.
-- clock_timestamp, not updated_at: update_licenses_updated_at sets now(), which
-- is fixed for a transaction, so two cycles in one transaction would share a
-- key and the second would be dropped.
--
-- A failure to enqueue is a WARNING and never aborts the licence update (a
-- suspension must always land); the nightly reconcile catches a missed pause
-- (SR R7).
--
-- Coexists with billing_regrant_on_unsuspend (BACKLOG-3846): both fire on the
-- same update; neither reads what the other writes.
--
-- Requires 20261011230913 (billing_outbox, stripe_customers).
-- Harness: supabase/tests/backlog-3878/ (every run rolled back).
-- Rollback: supabase/tests/backlog-3878/rollback-3878.sql.

DO $pre$
BEGIN
  IF to_regclass('public.billing_outbox') IS NULL OR to_regclass('public.stripe_customers') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-3878: needs migration 20261011230913 (billing foundation) first';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public._billing_on_licence_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_kind   text;
  v_prefix text;
  v_stamp  text;
  v_cust   record;
BEGIN
  IF NEW.status = 'suspended' AND OLD.status IS DISTINCT FROM 'suspended' THEN
    v_kind := 'pause_agent_subscription';
    v_prefix := 'pause';
  ELSIF OLD.status = 'suspended' AND NEW.status = 'active' THEN
    v_kind := 'resume_agent_subscription';
    v_prefix := 'resume';
  ELSE
    RETURN NULL;
  END IF;
  v_stamp := (floor(extract(epoch FROM clock_timestamp()) * 1000000))::bigint::text;

  FOR v_cust IN
    SELECT sc.stripe_mode FROM public.stripe_customers sc WHERE sc.user_id = NEW.user_id
  LOOP
    BEGIN
      INSERT INTO public.billing_outbox (stripe_mode, kind, user_id, dedupe_key, payload, run_after)
      VALUES (v_cust.stripe_mode, v_kind, NEW.user_id,
              v_prefix || ':' || v_cust.stripe_mode || ':' || NEW.user_id::text || ':' || v_stamp,
              jsonb_build_object('licence_id', NEW.id, 'from', OLD.status, 'to', NEW.status),
              now())
      ON CONFLICT (dedupe_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'BACKLOG-3878: % row not enqueued for user % (%): % %',
        v_kind, NEW.user_id, v_cust.stripe_mode, SQLSTATE, SQLERRM;
    END;
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'BACKLOG-3878: licence % billing enqueue failed: % %', NEW.user_id, SQLSTATE, SQLERRM;
  RETURN NULL;
END
$fn$;
REVOKE EXECUTE ON FUNCTION public._billing_on_licence_suspension() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS billing_pause_resume_on_licence_status ON public.licenses;
CREATE TRIGGER billing_pause_resume_on_licence_status
  AFTER UPDATE OF status ON public.licenses
  FOR EACH ROW
  WHEN ((OLD.status IS DISTINCT FROM 'suspended' AND NEW.status = 'suspended')
        OR (OLD.status = 'suspended' AND NEW.status = 'active'))
  EXECUTE FUNCTION public._billing_on_licence_suspension();
