-- Rollback for BACKLOG-3853 PR-2 (20261019090000_backlog_3853_subscription_engine.sql).
-- Removes the trigger, the lease / paid-event functions and the three new columns, and restores
-- the three replaced bodies: _billing_apply_org_subscription and _billing_auto_reinstate to the
-- PR-1 text (20261018230000), admin_update_plan_feature to the body it had before (md5 4dd46d36).
-- billing_outbox rows of kinds sync_org_subscription / notify_org_suspended / notify_account_manager
-- stay; a drain without those handlers parks them as unknown kinds (alert outbox_unknown_kind).
-- After running it, delete the ledger row: DELETE FROM supabase_migrations.schema_migrations
-- WHERE version = '20261019090000';

DROP TRIGGER IF EXISTS _billing_enqueue_org_work ON public.org_deals;
DROP FUNCTION IF EXISTS public._billing_enqueue_org_work();
DROP FUNCTION IF EXISTS public._billing_org_sync_lease(uuid, text, uuid, integer);
DROP FUNCTION IF EXISTS public._billing_org_sync_release(uuid, text, uuid);
DROP FUNCTION IF EXISTS public._billing_record_invoice_paid(uuid, text, bigint);

-- <<PR1_APPLY
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
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    collection_method = coalesce(EXCLUDED.collection_method, s.collection_method),
    last_event_created = EXCLUDED.last_event_created,
    updated_at = now()
  WHERE s.last_event_created IS NULL OR EXCLUDED.last_event_created IS NULL
     OR EXCLUDED.last_event_created >= s.last_event_created;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'applied', v_rows = 1);
END
$function$;
-- PR1_APPLY>>

-- <<PR1_AUTO
CREATE OR REPLACE FUNCTION public._billing_auto_reinstate(p_org uuid, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_reason text;
  v_status text;
BEGIN
  SELECT d.suspended_reason INTO v_reason FROM public.org_deals d
   WHERE d.organization_id = p_org AND d.status = 'suspended' AND d.stripe_mode = p_mode;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_suspended');
  END IF;
  IF v_reason IS DISTINCT FROM 'non_payment' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_not_non_payment');
  END IF;
  SELECT s.status INTO v_status FROM public.org_billing_stripe s
   WHERE s.organization_id = p_org AND s.stripe_mode = p_mode;
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'subscription_not_active', 'status', v_status);
  END IF;
  RETURN public._billing_reinstate_org(p_org, 'auto: paid', NULL);
END
$function$;
-- PR1_AUTO>>

-- <<PF_BEFORE
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
-- PF_BEFORE>>

ALTER TABLE public.org_billing_stripe
  DROP COLUMN IF EXISTS sync_lease_holder,
  DROP COLUMN IF EXISTS sync_lease_until,
  DROP COLUMN IF EXISTS last_invoice_paid_event_created;

DO $post$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public._billing_apply_org_subscription(uuid,text,jsonb,bigint)')))
     IS DISTINCT FROM '77ae57bdd4991e7e53779d77b001e6c9'
  OR md5(pg_get_functiondef(to_regprocedure('public._billing_auto_reinstate(uuid,text)')))
     IS DISTINCT FROM 'a6f4f1c229b0cb87ec9e893b596ffc9a'
  OR md5(pg_get_functiondef(to_regprocedure('public.admin_update_plan_feature(uuid,uuid,boolean,text)')))
     IS DISTINCT FROM '4dd46d3624eb46e3e45616b857dc13d3' THEN
    RAISE EXCEPTION '3853 PR-2 rollback: a restored body does not match its prior md5';
  END IF;
  IF to_regprocedure('public._billing_org_sync_lease(uuid,text,uuid,integer)') IS NOT NULL
     OR to_regprocedure('public._billing_record_invoice_paid(uuid,text,bigint)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '_billing_enqueue_org_work') THEN
    RAISE EXCEPTION '3853 PR-2 rollback: an object is still present';
  END IF;
END $post$;
