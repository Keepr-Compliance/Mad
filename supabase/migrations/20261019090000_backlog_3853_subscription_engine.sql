-- BACKLOG-3853 PR-2: brokerage subscription engine (DB part).
--
-- 1. _billing_enqueue_org_work - AFTER trigger on org_deals. Every writer of a deal enqueues
--    in its own transaction:
--      - INSERT, or an UPDATE that changes version, while the deal is active / canceling /
--        suspended -> billing_outbox kind sync_org_subscription (one row per deal version).
--      - status changes to 'suspended' -> kind notify_org_suspended (one row per suspension).
--    Reinstate enqueues nothing (founder B4: no reinstated email).
-- 2. Per-organization sync lease on org_billing_stripe (sync_lease_holder, sync_lease_until)
--    with _billing_org_sync_lease / _billing_org_sync_release. The drain makes several Stripe
--    calls across separate requests, so a transaction lock cannot cover them; two drain runs
--    can overlap. A lease is at least 90 seconds (the drain function runs at most 60).
-- 3. _billing_apply_org_subscription (PR-1 body replaced, same signature):
--      - a write with no event time (the drain persisting ids) writes ONLY the customer and
--        subscription ids; it never touches status, period end, cancel flag or the cursor;
--      - cancel_at_period_end changes only when the caller sends it;
--      - the cursor never moves backwards (GREATEST).
-- 4. org_billing_stripe.last_invoice_paid_event_created + _billing_record_invoice_paid:
--    the webhook records each invoice.paid. _billing_auto_reinstate (PR-1 body replaced, same
--    signature) now also needs a paid invoice recorded after the suspension began, so a
--    non-payment suspension never lifts without a payment.
-- 5. admin_update_plan_feature refuses every write to the billing-owned key
--    'account_suspended' (enable or disable). Only the billing code sets it.
--
-- CREATE OR REPLACE and ADD COLUMN IF NOT EXISTS only. Three function bodies are replaced;
-- the pre-check requires each to be the known prior body (or this file's, on a re-run).
-- Rollback: supabase/tests/backlog-3853/rollback-3853-pr2.sql

DO $pre$
DECLARE
  v_md5 text;
  v_src text;
BEGIN
  -- Each replaced body must be the known prior body, or already this file's (re-run).
  SELECT md5(pg_get_functiondef(oid)), prosrc INTO v_md5, v_src FROM pg_proc
   WHERE oid = to_regprocedure('public._billing_apply_org_subscription(uuid,text,jsonb,bigint)');
  IF v_md5 IS NULL OR (v_md5 <> '77ae57bdd4991e7e53779d77b001e6c9' AND v_src NOT LIKE '%IF p_event_created IS NULL THEN%') THEN
    RAISE EXCEPTION '3853 PR-2 pre-check: _billing_apply_org_subscription is not the PR-1 body (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef(oid)), prosrc INTO v_md5, v_src FROM pg_proc
   WHERE oid = to_regprocedure('public._billing_auto_reinstate(uuid,text)');
  IF v_md5 IS NULL OR (v_md5 <> 'a6f4f1c229b0cb87ec9e893b596ffc9a' AND v_src NOT LIKE '%no_payment_since_suspension%') THEN
    RAISE EXCEPTION '3853 PR-2 pre-check: _billing_auto_reinstate is not the PR-1 body (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef(oid)), prosrc INTO v_md5, v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.admin_update_plan_feature(uuid,uuid,boolean,text)');
  IF v_md5 IS NULL OR (v_md5 <> '4dd46d3624eb46e3e45616b857dc13d3' AND v_src NOT LIKE '%feature_not_editable%') THEN
    RAISE EXCEPTION '3853 PR-2 pre-check: admin_update_plan_feature is not the known body (md5 %)', v_md5;
  END IF;
  IF to_regclass('public.billing_outbox') IS NULL OR to_regclass('public.org_deals') IS NULL THEN
    RAISE EXCEPTION '3853 PR-2 pre-check: billing_outbox or org_deals is missing';
  END IF;
END $pre$;

-- =====================================================================================
-- 1. Columns on the Stripe mirror
-- =====================================================================================

ALTER TABLE public.org_billing_stripe
  ADD COLUMN IF NOT EXISTS sync_lease_holder uuid,
  ADD COLUMN IF NOT EXISTS sync_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_invoice_paid_event_created bigint;
COMMENT ON COLUMN public.org_billing_stripe.sync_lease_holder IS
  'BACKLOG-3853: billing_outbox row id that holds the per-organization Stripe sync lease.';
COMMENT ON COLUMN public.org_billing_stripe.last_invoice_paid_event_created IS
  'BACKLOG-3853: created time (epoch seconds) of the latest invoice.paid event. Auto-reinstate needs one after suspended_at.';

-- =====================================================================================
-- 2. Enqueue from every deal write
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._billing_enqueue_org_work()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (TG_OP = 'INSERT' OR OLD.version IS DISTINCT FROM NEW.version)
     AND NEW.status IN ('active', 'canceling', 'suspended') THEN
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload, run_after)
    VALUES (NEW.stripe_mode, 'sync_org_subscription', NEW.organization_id,
            'sync_org_subscription:' || NEW.stripe_mode || ':' || NEW.organization_id::text || ':v' || NEW.version::text,
            jsonb_build_object('organization_id', NEW.organization_id, 'deal_version', NEW.version),
            now())
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  IF NEW.status = 'suspended'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'suspended') THEN
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload, run_after)
    VALUES (NEW.stripe_mode, 'notify_org_suspended', NEW.organization_id,
            'notify_org_suspended:' || NEW.stripe_mode || ':' || NEW.organization_id::text || ':'
              || floor(extract(epoch FROM NEW.suspended_at))::bigint::text,
            jsonb_build_object('organization_id', NEW.organization_id,
                               'suspended_at_epoch', floor(extract(epoch FROM NEW.suspended_at))::bigint),
            now())
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN NULL;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_enqueue_org_work() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER _billing_enqueue_org_work
  AFTER INSERT OR UPDATE OF version, status ON public.org_deals
  FOR EACH ROW EXECUTE FUNCTION public._billing_enqueue_org_work();

-- =====================================================================================
-- 3. Per-organization sync lease
-- =====================================================================================

-- Take the lease when it is free, expired, or already held by p_holder. true = held now.
CREATE OR REPLACE FUNCTION public._billing_org_sync_lease(p_org uuid, p_mode text, p_holder uuid, p_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_rows integer;
BEGIN
  IF p_holder IS NULL OR p_seconds IS NULL OR p_seconds < 90 THEN
    RAISE EXCEPTION 'sync lease: holder required and at least 90 seconds';
  END IF;
  INSERT INTO public.org_billing_stripe AS s (organization_id, stripe_mode, sync_lease_holder, sync_lease_until, updated_at)
  VALUES (p_org, p_mode, p_holder, now() + make_interval(secs => p_seconds), now())
  ON CONFLICT (organization_id, stripe_mode) DO UPDATE SET
    sync_lease_holder = EXCLUDED.sync_lease_holder,
    sync_lease_until = EXCLUDED.sync_lease_until
  WHERE s.sync_lease_until IS NULL OR s.sync_lease_until < now() OR s.sync_lease_holder = EXCLUDED.sync_lease_holder;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_org_sync_lease(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_org_sync_lease(uuid, text, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public._billing_org_sync_release(p_org uuid, p_mode text, p_holder uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.org_billing_stripe SET sync_lease_holder = NULL, sync_lease_until = NULL
   WHERE organization_id = p_org AND stripe_mode = p_mode AND sync_lease_holder = p_holder;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_org_sync_release(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_org_sync_release(uuid, text, uuid) TO service_role;

-- =====================================================================================
-- 4. Subscription mirror writer (replaces the PR-1 body; same signature and grants)
-- =====================================================================================
-- p_event_created NULL = the drain persisting the ids it created or adopted: ids only.
-- Otherwise a webhook re-fetch: older events than the stored cursor are ignored.
CREATE OR REPLACE FUNCTION public._billing_apply_org_subscription(
  p_org uuid, p_mode text, p_fields jsonb, p_event_created bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_rows integer;
BEGIN
  IF p_event_created IS NULL THEN
    INSERT INTO public.org_billing_stripe AS s (organization_id, stripe_mode, stripe_customer_id, stripe_subscription_id, updated_at)
    VALUES (p_org, p_mode, p_fields ->> 'stripe_customer_id', p_fields ->> 'stripe_subscription_id', now())
    ON CONFLICT (organization_id, stripe_mode) DO UPDATE SET
      stripe_customer_id = coalesce(EXCLUDED.stripe_customer_id, s.stripe_customer_id),
      stripe_subscription_id = coalesce(EXCLUDED.stripe_subscription_id, s.stripe_subscription_id),
      updated_at = now();
    RETURN jsonb_build_object('success', true, 'applied', true);
  END IF;

  INSERT INTO public.org_billing_stripe AS s (organization_id, stripe_mode, stripe_customer_id, stripe_subscription_id,
    status, current_period_end, cancel_at_period_end, collection_method, last_event_created, updated_at)
  VALUES (p_org, p_mode, p_fields ->> 'stripe_customer_id', p_fields ->> 'stripe_subscription_id',
    p_fields ->> 'status', nullif(p_fields ->> 'current_period_end', '')::timestamptz,
    coalesce((p_fields ->> 'cancel_at_period_end')::boolean, false), p_fields ->> 'collection_method',
    p_event_created, now())
  ON CONFLICT (organization_id, stripe_mode) DO UPDATE SET
    stripe_customer_id = coalesce(EXCLUDED.stripe_customer_id, s.stripe_customer_id),
    stripe_subscription_id = coalesce(EXCLUDED.stripe_subscription_id, s.stripe_subscription_id),
    status = coalesce(EXCLUDED.status, s.status),
    current_period_end = coalesce(EXCLUDED.current_period_end, s.current_period_end),
    cancel_at_period_end = CASE WHEN p_fields ? 'cancel_at_period_end'
                                THEN EXCLUDED.cancel_at_period_end ELSE s.cancel_at_period_end END,
    collection_method = coalesce(EXCLUDED.collection_method, s.collection_method),
    last_event_created = GREATEST(s.last_event_created, EXCLUDED.last_event_created),
    updated_at = now()
  WHERE s.last_event_created IS NULL OR EXCLUDED.last_event_created >= s.last_event_created;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'applied', v_rows = 1);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_apply_org_subscription(uuid, text, jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_apply_org_subscription(uuid, text, jsonb, bigint) TO service_role;

-- =====================================================================================
-- 5. Payment evidence for auto-reinstate
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._billing_record_invoice_paid(p_org uuid, p_mode text, p_event_created bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF p_event_created IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'event_created_required');
  END IF;
  INSERT INTO public.org_billing_stripe AS s (organization_id, stripe_mode, last_invoice_paid_event_created, updated_at)
  VALUES (p_org, p_mode, p_event_created, now())
  ON CONFLICT (organization_id, stripe_mode) DO UPDATE SET
    last_invoice_paid_event_created = GREATEST(s.last_invoice_paid_event_created, EXCLUDED.last_invoice_paid_event_created),
    updated_at = now();
  RETURN jsonb_build_object('success', true);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_record_invoice_paid(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_record_invoice_paid(uuid, text, bigint) TO service_role;

-- Auto-reinstate after payment (Q2 a, SR R8; replaces the PR-1 body, same signature and grants):
-- only a 'non_payment' suspension, only when the mirrored subscription is active, and only when
-- an invoice.paid was recorded after the suspension began. The webhook also checks that no
-- open invoice is past due before calling. actor = NULL (system).
CREATE OR REPLACE FUNCTION public._billing_auto_reinstate(p_org uuid, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_reason text;
  v_suspended_at timestamptz;
  v_status text;
  v_paid bigint;
BEGIN
  SELECT d.suspended_reason, d.suspended_at INTO v_reason, v_suspended_at FROM public.org_deals d
   WHERE d.organization_id = p_org AND d.status = 'suspended' AND d.stripe_mode = p_mode;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_suspended');
  END IF;
  IF v_reason IS DISTINCT FROM 'non_payment' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_not_non_payment');
  END IF;
  SELECT s.status, s.last_invoice_paid_event_created INTO v_status, v_paid FROM public.org_billing_stripe s
   WHERE s.organization_id = p_org AND s.stripe_mode = p_mode;
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'subscription_not_active', 'status', v_status);
  END IF;
  IF v_paid IS NULL OR v_suspended_at IS NULL OR v_paid <= floor(extract(epoch FROM v_suspended_at))::bigint THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_payment_since_suspension');
  END IF;
  RETURN public._billing_reinstate_org(p_org, 'auto: paid', NULL);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_auto_reinstate(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_auto_reinstate(uuid, text) TO service_role;

-- =====================================================================================
-- 6. admin_update_plan_feature: 'account_suspended' is billing-owned (same signature and grants)
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.admin_update_plan_feature(p_plan_id uuid, p_feature_id uuid, p_enabled boolean, p_value text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin_id           UUID;
  v_has_perm           BOOLEAN;
  v_plan               RECORD;
  v_feature            RECORD;
  v_result             RECORD;
  v_unmet_deps         TEXT[];
  v_enabled_dependents TEXT[];
BEGIN
  v_admin_id := auth.uid();
  IF v_admin_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT public.has_permission(v_admin_id, 'plans.manage') INTO v_has_perm;
  IF NOT v_has_perm THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_permissions');
  END IF;

  SELECT * INTO v_plan FROM public.plans WHERE id = p_plan_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
  END IF;

  SELECT * INTO v_feature FROM public.feature_definitions WHERE id = p_feature_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'feature_not_found');
  END IF;

  -- BACKLOG-3853: billing owns this key (suspension); no plan may carry it, either way.
  IF v_feature.key = 'account_suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'feature_not_editable', 'feature_key', v_feature.key);
  END IF;

  IF p_enabled THEN
    IF v_feature.min_tier IS NOT NULL
       AND v_plan.tier != 'custom'
       AND public.tier_rank(v_plan.tier) < public.tier_rank(v_feature.min_tier) THEN
      RETURN jsonb_build_object(
        'success', false, 'error', 'tier_constraint_violation',
        'message', format('Feature "%s" requires %s tier or higher. Plan "%s" is %s tier.',
          v_feature.key, v_feature.min_tier, v_plan.name, v_plan.tier),
        'feature_key', v_feature.key, 'required_tier', v_feature.min_tier, 'plan_tier', v_plan.tier
      );
    END IF;

    SELECT array_agg(fd.depends_on_key) INTO v_unmet_deps
    FROM public.feature_dependencies fd
    WHERE fd.feature_key = v_feature.key
      AND NOT EXISTS (
        SELECT 1 FROM public.plan_features pf
        JOIN public.feature_definitions dep_fd ON dep_fd.id = pf.feature_id
        WHERE pf.plan_id = p_plan_id AND dep_fd.key = fd.depends_on_key AND pf.enabled = true
      );

    IF v_unmet_deps IS NOT NULL AND array_length(v_unmet_deps, 1) > 0 THEN
      RETURN jsonb_build_object(
        'success', false, 'error', 'dependency_violation',
        'message', format('Feature "%s" requires the following features to be enabled first: %s',
          v_feature.key, array_to_string(v_unmet_deps, ', ')),
        'feature_key', v_feature.key, 'unmet_dependencies', to_jsonb(v_unmet_deps)
      );
    END IF;
  END IF;

  IF NOT p_enabled THEN
    SELECT array_agg(fd.feature_key) INTO v_enabled_dependents
    FROM public.feature_dependencies fd
    WHERE fd.depends_on_key = v_feature.key
      AND EXISTS (
        SELECT 1 FROM public.plan_features pf
        JOIN public.feature_definitions dep_fd ON dep_fd.id = pf.feature_id
        WHERE pf.plan_id = p_plan_id AND dep_fd.key = fd.feature_key AND pf.enabled = true
      );

    IF v_enabled_dependents IS NOT NULL AND array_length(v_enabled_dependents, 1) > 0 THEN
      RETURN jsonb_build_object(
        'success', false, 'error', 'reverse_dependency_violation',
        'message', format('Cannot disable "%s" because the following enabled features depend on it: %s. Disable them first.',
          v_feature.key, array_to_string(v_enabled_dependents, ', ')),
        'feature_key', v_feature.key, 'dependent_features', to_jsonb(v_enabled_dependents)
      );
    END IF;
  END IF;

  INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
  VALUES (p_plan_id, p_feature_id, p_enabled, p_value)
  ON CONFLICT (plan_id, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled, value = EXCLUDED.value
  RETURNING id, plan_id, feature_id, enabled, value INTO v_result;

  PERFORM public.log_admin_action(
    'plan_feature.updated',
    'plan_feature',
    v_result.id::text,
    jsonb_build_object(
      'plan_id',     p_plan_id,
      'feature_id',  p_feature_id,
      'feature_key', v_feature.key,
      'enabled',     p_enabled,
      'value',       p_value
    )
  );

  RETURN jsonb_build_object(
    'success',    true,
    'id',         v_result.id,
    'plan_id',    v_result.plan_id,
    'feature_id', v_result.feature_id,
    'enabled',    v_result.enabled,
    'value',      v_result.value
  );
END;
$function$;
