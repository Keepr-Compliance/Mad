-- BACKLOG-4245 harness for 20261114140000_backlog_4245_beta_updates_feature.sql
--
-- Runs on keepr-test only, as ONE statement that always ends in RAISE
-- EXCEPTION, so nothing it does can commit. The exception text carries the
-- results (counts and booleans only; no ids, no row values).
--
-- What it proves, inside that one transaction:
--   P1 the pre-check passes (get_org_features is at the traced body)
--   P2 the migration's inserts, run twice, leave exactly one definition row
--      and one plan_features row per plan, all enabled false
--   P3 for every plan that has an organization with an access-granting
--      member, get_org_features (called as that member) returns
--      beta_updates.enabled = false
--   P4 an org-level override {"beta_updates":{"enabled":true}} on org X makes
--      get_org_features(X) return enabled = true (source override), while
--      another org Y still returns false
--
-- Usage: ~/.claude/bin/kt-sql supabase/tests/backlog-4245/harness-4245.sql
--        (expect HTTP 400 with "BACKLOG-4245 HARNESS RESULT" in the message)

set local pg_stat_statements.track = 'none';

DO $harness$
DECLARE
  v_md5 text;
  v_plans int;
  v_def_rows int;
  v_plan_rows int;
  v_plan_rows_on int;
  v_plans_probed int := 0;
  v_plans_false int := 0;
  v_plans_without_member int := 0;
  r record;
  v_member uuid;
  v_org uuid;
  v_res jsonb;
  v_x_org uuid;
  v_x_member uuid;
  v_y_org uuid;
  v_y_member uuid;
  v_x_enabled boolean;
  v_x_source text;
  v_y_enabled boolean;
  v_x_before boolean;
BEGIN
  -- P1: the migration's pre-check, inlined.
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p
   WHERE p.proname = 'get_org_features' AND p.pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM 'ab7769fae1a97e4865a3522014b115b3' THEN
    RAISE EXCEPTION 'BACKLOG-4245 HARNESS STOP: get_org_features md5 %', coalesce(v_md5, 'missing');
  END IF;

  -- P2: the migration's two inserts, twice.
  FOR i IN 1..2 LOOP
    INSERT INTO public.feature_definitions
      (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
    VALUES ('beta_updates', 'Beta versions',
      'Lets the desktop app receive Keepr beta versions for a user who turns on "Get beta versions". Off unless an organization override grants it (BACKLOG-4245).',
      'general', 'boolean', 'false', NULL, 166, false)
    ON CONFLICT (key) DO NOTHING;
    INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
    SELECT p.id, fd.id, false, 'false'
      FROM public.plans p CROSS JOIN public.feature_definitions fd
     WHERE fd.key = 'beta_updates'
    ON CONFLICT (plan_id, feature_id) DO NOTHING;
  END LOOP;

  SELECT count(*) INTO v_plans FROM public.plans;
  SELECT count(*) INTO v_def_rows FROM public.feature_definitions WHERE key = 'beta_updates';
  SELECT count(*), count(*) FILTER (WHERE pf.enabled) INTO v_plan_rows, v_plan_rows_on
    FROM public.plan_features pf JOIN public.feature_definitions fd ON fd.id = pf.feature_id
   WHERE fd.key = 'beta_updates';

  -- P3: every plan, through get_org_features as a member of an org on it.
  FOR r IN SELECT p.id AS plan_id FROM public.plans p LOOP
    SELECT op.organization_id, m.user_id INTO v_org, v_member
      FROM public.organization_plans op
      JOIN public.organization_members m ON m.organization_id = op.organization_id
     WHERE op.plan_id = r.plan_id
       AND public.member_status_grants_access(m.license_status)
       AND NOT (coalesce(op.feature_overrides, '{}'::jsonb) ? 'beta_updates')
     LIMIT 1;
    IF v_org IS NULL THEN
      v_plans_without_member := v_plans_without_member + 1;
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_member, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_member::text, true);
    v_res := public.get_org_features(v_org);
    v_plans_probed := v_plans_probed + 1;
    IF (v_res -> 'features' -> 'beta_updates' ->> 'enabled')::boolean IS FALSE THEN
      v_plans_false := v_plans_false + 1;
    END IF;
    v_org := NULL;
    v_member := NULL;
  END LOOP;

  -- P4: override on X, none on Y.
  SELECT op.organization_id, m.user_id INTO v_x_org, v_x_member
    FROM public.organization_plans op
    JOIN public.organization_members m ON m.organization_id = op.organization_id
   WHERE public.member_status_grants_access(m.license_status)
   ORDER BY op.organization_id
   LIMIT 1;
  SELECT op.organization_id, m.user_id INTO v_y_org, v_y_member
    FROM public.organization_plans op
    JOIN public.organization_members m ON m.organization_id = op.organization_id
   WHERE public.member_status_grants_access(m.license_status)
     AND op.organization_id <> v_x_org
   ORDER BY op.organization_id
   LIMIT 1;
  IF v_x_org IS NULL OR v_y_org IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-4245 HARNESS STOP: need two organizations with a member and a plan row';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x_member, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_x_member::text, true);
  v_x_before := (public.get_org_features(v_x_org) -> 'features' -> 'beta_updates' ->> 'enabled')::boolean;

  UPDATE public.organization_plans
     SET feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{"beta_updates":{"enabled":true}}'::jsonb
   WHERE organization_id = v_x_org;

  v_res := public.get_org_features(v_x_org);
  v_x_enabled := (v_res -> 'features' -> 'beta_updates' ->> 'enabled')::boolean;
  v_x_source := v_res -> 'features' -> 'beta_updates' ->> 'source';

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_y_member, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_y_member::text, true);
  v_y_enabled := (public.get_org_features(v_y_org) -> 'features' -> 'beta_updates' ->> 'enabled')::boolean;

  RAISE EXCEPTION 'BACKLOG-4245 HARNESS RESULT %', jsonb_build_object(
    'p1_md5_ok', true,
    'p2_plans', v_plans,
    'p2_definition_rows', v_def_rows,
    'p2_plan_rows', v_plan_rows,
    'p2_plan_rows_enabled', v_plan_rows_on,
    'p3_plans_probed', v_plans_probed,
    'p3_plans_false', v_plans_false,
    'p3_plans_without_member', v_plans_without_member,
    'p4_x_before_override', v_x_before,
    'p4_x_with_override', v_x_enabled,
    'p4_x_source', v_x_source,
    'p4_y_without_override', v_y_enabled
  )::text;
END
$harness$;
