-- BACKLOG-3938: the membership helpers answer only for the calling user, and
-- broker_get_org_features answers only for the organization's own members and
-- submitters.
--
-- 1. get_user_org_ids(uuid) and is_org_admin(uuid, uuid): the body adds
--    `AND user_uuid = (SELECT auth.uid())`. Every caller (the organization_members,
--    checklist_templates and checklist_template_items policies, and the
--    guard_invite_acceptance trigger) passes auth.uid(), so their results do not
--    change. The 3917 member_status_grants_access clause is kept. Signatures,
--    SECURITY DEFINER, search_path, volatility and grants are unchanged
--    (CREATE OR REPLACE keeps the ACL; nothing is revoked here).
-- 2. broker_get_org_features(uuid): after the existing authentication check it
--    returns error 'not_member' with no features unless the caller has an
--    organization_members row for the org (any license_status) or has submitted a
--    transaction_submissions row to it.
--    Rule: this RPC is an entitlement lookup, not an access gate. "Any membership
--    row, or a submitter" is a superset of what the caller can already see: their
--    own organization, and the organizations of the submissions row-level security
--    lets them read (transaction_submissions_select_public = own submission OR
--    can_review_submission). Status gating stays app-side in every consumer, each
--    of which checks member status before calling this RPC. A narrower rule would
--    fail the submitter's organization list as a whole.
--
-- Apply as one transaction. No BEGIN/COMMIT here.
-- Rollback: supabase/tests/backlog-3938/rollback-3938.sql

-- Intentionally callable by anon: existing grant kept unchanged; organization_members policies that apply TO public call it; the body answers only for auth.uid()
CREATE OR REPLACE FUNCTION public.get_user_org_ids(user_uuid uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT organization_id FROM organization_members
   WHERE user_id = user_uuid
     AND user_uuid = (SELECT auth.uid())
     AND public.member_status_grants_access(license_status);
$function$;

-- Intentionally callable by anon: existing grant kept unchanged; organization_members policies that apply TO public and the invite trigger call it; the body answers only for auth.uid()
CREATE OR REPLACE FUNCTION public.is_org_admin(user_uuid uuid, org_uuid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE user_id = user_uuid
    AND user_uuid = (SELECT auth.uid())
    AND organization_id = org_uuid
    AND role IN ('admin', 'it_admin')
    AND public.member_status_grants_access(license_status)
  );
$function$;

-- Intentionally callable by anon: existing grant kept unchanged; a signed-out caller gets not_authenticated as data
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
  -- Require authentication, then membership (BACKLOG-3938).
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object(
      'org_id', p_org_id,
      'plan_name', 'none',
      'plan_tier', 'none',
      'features', '{}'::jsonb,
      'error', 'not_authenticated'
    );
  END IF;

  -- BACKLOG-3938: the caller must hold a membership row in the organization (any
  -- status) or have submitted to it. Entitlement lookup, not an access gate: see header.
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id AND m.user_id = auth.uid())
     AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions s
                      WHERE s.organization_id = p_org_id AND s.submitted_by = auth.uid()) THEN
    RETURN jsonb_build_object(
      'org_id', p_org_id,
      'plan_name', 'none',
      'plan_tier', 'none',
      'features', '{}'::jsonb,
      'error', 'not_member'
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
      -- BACKLOG-3845: an expired or malformed paid_through makes the override absent.
      IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN
        v_override := NULL;
      END IF;
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
