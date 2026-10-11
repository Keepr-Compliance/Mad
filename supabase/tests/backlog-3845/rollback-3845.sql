-- BACKLOG-3845 rollback. Restores the pre-3845 state of every object
-- 20261011100000_backlog_3845_billing_foundation.sql creates or changes.
-- Run by hand on founder go, in one transaction. Tested by the harness
-- (control k30-rollback), which also proves the refusals below.
--
-- Refuses (raises, nothing changed) when rolling back would lose or
-- mis-read data:
--   * any stripe_mode='test' row in stripe_customers / payment_intents
--     (the PK goes back to user_id alone and the column is dropped);
--   * any row in billing_subscriptions or billing_outbox;
--   * any organization_plans override carrying paid_through or
--     source='stripe' (the restored resolvers ignore paid_through, so an
--     expired Stripe grant would read as Unlimited forever).
-- organizations.is_test is dropped: re-apply the is_test data step after a
-- re-apply of the migration.
BEGIN;

DO $rb$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.stripe_customers WHERE stripe_mode <> 'live';
  IF n > 0 THEN RAISE EXCEPTION 'BACKLOG-3845 rollback: % non-live stripe_customers row(s); purge them first', n; END IF;
  SELECT count(*) INTO n FROM public.payment_intents WHERE stripe_mode <> 'live';
  IF n > 0 THEN RAISE EXCEPTION 'BACKLOG-3845 rollback: % non-live payment_intents row(s); purge them first', n; END IF;
  SELECT count(*) INTO n FROM public.billing_subscriptions;
  IF n > 0 THEN RAISE EXCEPTION 'BACKLOG-3845 rollback: billing_subscriptions holds % row(s)', n; END IF;
  SELECT count(*) INTO n FROM public.billing_outbox;
  IF n > 0 THEN RAISE EXCEPTION 'BACKLOG-3845 rollback: billing_outbox holds % row(s)', n; END IF;
  SELECT count(*) INTO n
    FROM public.organization_plans op, jsonb_each(COALESCE(op.feature_overrides, '{}'::jsonb)) e
   WHERE jsonb_typeof(e.value) = 'object'
     AND (e.value ? 'paid_through' OR e.value ->> 'source' = 'stripe');
  IF n > 0 THEN RAISE EXCEPTION 'BACKLOG-3845 rollback: % override(s) carry paid_through or source=stripe', n; END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.grant_unlimited_from_subscription(uuid, timestamptz, text);
DROP FUNCTION IF EXISTS public.revoke_unlimited_from_subscription(uuid, text);
DROP FUNCTION IF EXISTS public.billing_outbox_claim(text, integer);
DROP TABLE IF EXISTS public.billing_outbox;
DROP TABLE IF EXISTS public.billing_subscriptions;

DROP TRIGGER IF EXISTS guard_stripe_mode_is_test ON public.stripe_customers;
DROP TRIGGER IF EXISTS guard_stripe_mode_is_test ON public.payment_intents;
DROP FUNCTION IF EXISTS public._guard_stripe_mode_is_test();

ALTER POLICY stripe_customers_select_own ON public.stripe_customers
  USING ((((SELECT auth.uid()) = user_id)) OR has_internal_role((SELECT auth.uid())));

ALTER TABLE public.stripe_customers DROP CONSTRAINT IF EXISTS stripe_customers_pkey;
ALTER TABLE public.stripe_customers ADD CONSTRAINT stripe_customers_pkey PRIMARY KEY (user_id);
ALTER TABLE public.stripe_customers DROP CONSTRAINT IF EXISTS stripe_customers_stripe_mode_ck;
ALTER TABLE public.stripe_customers DROP COLUMN IF EXISTS stripe_mode;
ALTER TABLE public.payment_intents DROP CONSTRAINT IF EXISTS payment_intents_stripe_mode_ck;
ALTER TABLE public.payment_intents DROP COLUMN IF EXISTS stripe_mode;

ALTER TABLE public.organizations DROP COLUMN IF EXISTS is_test;

-- Pre-3845 resolver bodies, verbatim (production md5 51401252..., 8500027b..., 84add903...).
CREATE OR REPLACE FUNCTION public.get_org_features(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_plan RECORD;
  v_has_plan BOOLEAN := false;
  v_result JSONB := '{}';
  v_feature RECORD;
  v_plan_feature RECORD;
  v_override JSONB;
  v_enabled BOOLEAN;
  v_value TEXT;
  v_source TEXT;
  v_blocked BOOLEAN;
BEGIN
  -- Verify caller is a member of the organization
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid() AND organization_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('error', 'not_authorized', 'features', '[]'::jsonb);
  END IF;

  -- Get org's plan
  SELECT op.*, p.name as plan_name, p.tier as plan_tier INTO v_org_plan
  FROM public.organization_plans op
  JOIN public.plans p ON p.id = op.plan_id
  WHERE op.organization_id = p_org_id;

  v_has_plan := FOUND;

  -- Iterate all features
  FOR v_feature IN SELECT * FROM public.feature_definitions ORDER BY sort_order, key
  LOOP
    v_enabled := v_feature.default_value = 'true';
    v_value := v_feature.default_value;
    v_source := 'default';
    v_blocked := false;

    IF v_has_plan THEN
      -- Check per-org override first
      v_override := v_org_plan.feature_overrides -> v_feature.key;
      v_blocked := v_override IS NOT NULL
                   AND public._override_above_tier(v_feature.key, v_feature.min_tier, v_org_plan.plan_tier, v_override);
      IF v_override IS NOT NULL AND NOT v_blocked THEN
        v_enabled := COALESCE((v_override ->> 'enabled')::boolean, true);
        v_value := COALESCE(v_override ->> 'value', v_feature.default_value);
        v_source := 'override';
      ELSE
        -- Check plan-level feature
        SELECT * INTO v_plan_feature
        FROM public.plan_features pf
        WHERE pf.plan_id = v_org_plan.plan_id
          AND pf.feature_id = v_feature.id;

        IF FOUND THEN
          v_enabled := v_plan_feature.enabled;
          v_value := COALESCE(v_plan_feature.value, v_feature.default_value);
          v_source := 'plan';
        END IF;
      END IF;
    END IF;

    v_result := v_result || jsonb_build_object(
      v_feature.key, jsonb_build_object(
        'enabled', v_enabled,
        'value', v_value,
        'value_type', v_feature.value_type,
        'name', v_feature.name,
        'source', v_source
      ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'plan_name', COALESCE(v_org_plan.plan_name, 'none'),
    'plan_tier', COALESCE(v_org_plan.plan_tier, 'none'),
    'features', v_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.broker_get_org_features(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_plan RECORD;
  v_has_plan BOOLEAN := false;
  v_result JSONB := '{}';
  v_feature RECORD;
  v_plan_feature RECORD;
  v_override JSONB;
  v_enabled BOOLEAN;
  v_value TEXT;
  v_source TEXT;
  v_blocked BOOLEAN;
BEGIN
  -- Only require authentication (no org membership check)
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object(
      'org_id', p_org_id,
      'plan_name', 'none',
      'plan_tier', 'none',
      'features', '{}'::jsonb,
      'error', 'not_authenticated'
    );
  END IF;

  -- Get org's plan
  SELECT op.*, p.name as plan_name, p.tier as plan_tier INTO v_org_plan
  FROM public.organization_plans op
  JOIN public.plans p ON p.id = op.plan_id
  WHERE op.organization_id = p_org_id;

  v_has_plan := FOUND;

  -- Iterate all features
  FOR v_feature IN SELECT * FROM public.feature_definitions ORDER BY sort_order, key
  LOOP
    v_enabled := v_feature.default_value = 'true';
    v_value := v_feature.default_value;
    v_source := 'default';
    v_blocked := false;

    IF v_has_plan THEN
      v_override := v_org_plan.feature_overrides -> v_feature.key;
      v_blocked := v_override IS NOT NULL
                   AND public._override_above_tier(v_feature.key, v_feature.min_tier, v_org_plan.plan_tier, v_override);
      IF v_override IS NOT NULL AND NOT v_blocked THEN
        v_enabled := COALESCE((v_override ->> 'enabled')::boolean, true);
        v_value := COALESCE(v_override ->> 'value', v_feature.default_value);
        v_source := 'override';
      ELSE
        SELECT * INTO v_plan_feature
        FROM public.plan_features pf
        WHERE pf.plan_id = v_org_plan.plan_id
          AND pf.feature_id = v_feature.id;

        IF FOUND THEN
          v_enabled := v_plan_feature.enabled;
          v_value := COALESCE(v_plan_feature.value, v_feature.default_value);
          v_source := 'plan';
        END IF;
      END IF;
    END IF;

    v_result := v_result || jsonb_build_object(
      v_feature.key, jsonb_build_object(
        'enabled', v_enabled,
        'value', v_value,
        'value_type', v_feature.value_type,
        'name', v_feature.name,
        'source', v_source
      ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'plan_name', COALESCE(v_org_plan.plan_name, 'none'),
    'plan_tier', COALESCE(v_org_plan.plan_tier, 'none'),
    'features', v_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_feature_access(p_org_id uuid, p_feature_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_feature RECORD;
  v_plan_feature RECORD;
  v_org_plan RECORD;
  v_override JSONB;
  v_result_enabled BOOLEAN;
  v_result_value TEXT;
  v_blocked BOOLEAN := false;
BEGIN
  -- 0. Verify caller is a member of the organization
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid() AND organization_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'not_authorized');
  END IF;

  -- 1. Get the feature definition
  SELECT * INTO v_feature
  FROM public.feature_definitions
  WHERE key = p_feature_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'unknown_feature', 'feature_key', p_feature_key);
  END IF;

  -- 2. Get the org's plan
  SELECT op.*, p.tier INTO v_org_plan
  FROM public.organization_plans op
  JOIN public.plans p ON p.id = op.plan_id
  WHERE op.organization_id = p_org_id;

  IF NOT FOUND THEN
    -- No plan assigned: use feature default
    RETURN jsonb_build_object(
      'allowed', v_feature.default_value = 'true',
      'value', v_feature.default_value,
      'source', 'default'
    );
  END IF;

  -- 3. Check for per-org override
  v_override := v_org_plan.feature_overrides -> p_feature_key;
  v_blocked := v_override IS NOT NULL
               AND public._override_above_tier(p_feature_key, v_feature.min_tier, v_org_plan.tier, v_override);
  IF v_override IS NOT NULL AND NOT v_blocked THEN
    v_result_enabled := COALESCE((v_override ->> 'enabled')::boolean, true);
    v_result_value := COALESCE(v_override ->> 'value', v_feature.default_value);
    RETURN jsonb_build_object(
      'allowed', v_result_enabled,
      'value', v_result_value,
      'source', 'override'
    );
  END IF;

  -- 4. Check plan-level feature
  SELECT * INTO v_plan_feature
  FROM public.plan_features pf
  WHERE pf.plan_id = v_org_plan.plan_id
    AND pf.feature_id = v_feature.id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', v_plan_feature.enabled,
      'value', COALESCE(v_plan_feature.value, v_feature.default_value),
      'source', 'plan'
    ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END;
  END IF;

  -- 5. Feature not explicitly in plan: use default
  RETURN jsonb_build_object(
    'allowed', v_feature.default_value = 'true',
    'value', v_feature.default_value,
    'source', 'default'
  ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END;
END;
$function$;

DROP FUNCTION IF EXISTS public._override_effective(jsonb);

COMMIT;
