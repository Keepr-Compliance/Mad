-- BACKLOG-3846 (billing epic BACKLOG-3648) + BACKLOG-3136.
--
-- 1. Unsuspend re-grant. When a licence goes from 'suspended' to 'active', and
--    the user's Agent subscription in their mode is still paid (status active or
--    trialing, current_period_end in the future, not paused), Unlimited is
--    granted again with paid_through = current_period_end + 2 h (the value every
--    webhook grant writes). One AFTER UPDATE OF status trigger on licenses covers
--    every writer (admin_unsuspend_user, reinstate_suspended_account,
--    admin_update_license). A refused or failed re-grant is a WARNING and never
--    aborts the unsuspend.
--
-- 2. Audit actor for service-role callers (BACKLOG-3136). log_admin_action
--    wrote auth.uid() into admin_audit_logs.actor_id, which is NOT NULL, so a
--    service-role caller (suspend_account_for_dispute, run by the Stripe
--    webhook) raised. actor_id becomes nullable; log_admin_action now refuses a
--    caller that is neither a signed-in user nor the service role, and anon /
--    PUBLIC lose EXECUTE (the NOT NULL was what stopped anon before).
--
-- Requires 20261011230913 (billing_subscriptions, grant_unlimited_from_subscription).
-- Harness: supabase/tests/backlog-3846/ (every run rolled back).
-- Rollback: supabase/tests/backlog-3846/rollback-3846.sql.

-- ---------------------------------------------------------------------------
-- 0. Preconditions.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_src text;
BEGIN
  IF to_regclass('public.billing_subscriptions') IS NULL
     OR to_regprocedure('public.grant_unlimited_from_subscription(uuid,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-3846: needs migration 20261011230913 (billing foundation) first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.log_admin_action(text,text,text,jsonb,inet,text)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-3846: public.log_admin_action(text,text,text,jsonb,inet,text) does not exist';
  END IF;
  -- Production body as read on 2026-10-12, or this migration's own body (second apply).
  IF md5(v_src) <> 'df1ef32e483bab95212c7525be8c5fb2' AND v_src NOT LIKE '%BACKLOG-3136%' THEN
    RAISE EXCEPTION 'BACKLOG-3846: log_admin_action body changed (md5 %); re-review before applying', md5(v_src);
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. BACKLOG-3136: a service-role audit row has no actor.
-- ---------------------------------------------------------------------------
ALTER TABLE public.admin_audit_logs ALTER COLUMN actor_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.log_admin_action(
  p_action text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb DEFAULT NULL::jsonb,
  p_ip_address inet DEFAULT NULL::inet,
  p_user_agent text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  -- BACKLOG-3136: actor_id is NULL only for the service role (system actions
  -- such as a Stripe dispute suspension). Anyone else must be signed in.
  IF auth.uid() IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'log_admin_action: a signed-in user or the service role is required'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.admin_audit_logs (
    actor_id, action, target_type, target_id, metadata, ip_address, user_agent
  )
  VALUES (
    auth.uid(), p_action, p_target_type, p_target_id, p_metadata, p_ip_address, p_user_agent
  );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.log_admin_action(text, text, text, jsonb, inet, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_admin_action(text, text, text, jsonb, inet, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Unsuspend re-grant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._billing_on_licence_unsuspend()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_org_id  uuid;
  v_is_test boolean;
  v_mode    text;
  v_cpe     timestamptz;
  v_result  jsonb;
BEGIN
  SELECT o.id, o.is_test INTO v_org_id, v_is_test
    FROM public.organizations o
   WHERE o.personal_owner_user_id = NEW.user_id;
  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;
  v_mode := CASE WHEN v_is_test IS TRUE THEN 'test' ELSE 'live' END;

  -- Still paid: open, period not over, and not paused (a paused subscription
  -- stays 'active' while its period rolls forward unpaid).
  SELECT bs.current_period_end INTO v_cpe
    FROM public.billing_subscriptions bs
   WHERE bs.user_id = NEW.user_id
     AND bs.stripe_mode = v_mode
     AND bs.status IN ('active', 'trialing')
     AND bs.current_period_end > now()
     AND bs.paused = false
   ORDER BY bs.current_period_end DESC
   LIMIT 1;
  IF v_cpe IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_result := public.grant_unlimited_from_subscription(NEW.user_id, v_cpe + interval '2 hours', v_mode);
    IF v_result ->> 'status' IS DISTINCT FROM 'granted' THEN
      RAISE WARNING 'BACKLOG-3846: unsuspend re-grant not applied for user %: %', NEW.user_id, v_result;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'BACKLOG-3846: unsuspend re-grant failed for user %: % %', NEW.user_id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;
REVOKE EXECUTE ON FUNCTION public._billing_on_licence_unsuspend() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS billing_regrant_on_unsuspend ON public.licenses;
CREATE TRIGGER billing_regrant_on_unsuspend
  AFTER UPDATE OF status ON public.licenses
  FOR EACH ROW
  WHEN (OLD.status = 'suspended' AND NEW.status = 'active')
  EXECUTE FUNCTION public._billing_on_licence_unsuspend();
