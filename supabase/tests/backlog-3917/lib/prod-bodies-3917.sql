-- BACKLOG-3917 venue parity. The test venue's migration ledger is behind
-- production. run.sh layers the repo migrations that bring the objects this
-- harness reads to production's definitions (3673, 3759, 3843). The two
-- functions below come from 20261011230913_backlog_3845_billing_foundation.sql,
-- which is not layered whole; their bodies are production's (read 2026-10-13)
-- and preconditions-3917.sql checks every md5 against production.

CREATE OR REPLACE FUNCTION public._override_effective(o jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_raw jsonb;
  v_s   text;
BEGIN
  v_raw := o -> 'paid_through';
  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(v_raw) <> 'string' THEN
    RETURN false;
  END IF;
  v_s := v_raw #>> '{}';
  IF v_s !~ '^\d{4}-\d{2}-\d{2}T' THEN
    RETURN false;
  END IF;
  IF NOT pg_input_is_valid(v_s, 'timestamptz') THEN
    RETURN false;
  END IF;
  RETURN v_s::timestamptz > now();
END
$function$;
REVOKE ALL ON FUNCTION public._override_effective(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._override_effective(jsonb) TO service_role;

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
  -- BACKLOG-3845: an expired or malformed paid_through makes the override absent.
  IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN
    v_override := NULL;
  END IF;
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
