-- BACKLOG-3513 PR-3f (migration 20261112220000, Reassign) DB controls. Venue: keepr-test ONLY, where
-- 20261112200000 and 20261112210000 are committed. Composed by compose.py: tracking off, 20261112220000
-- twice (the second apply proves the pin's second-run branch), the PR-2 prelude (fixtures; call_as =
-- SET LOCAL ROLE authenticated + jwt claims), then this file. ONE call, ONE transaction ending in
-- RAISE: nothing persists. Output: RAISE 'P3513B_RESULT {total, pass, fail, reds}'.
--
-- Fixtures used from the PR-2 prelude (O1 = 101, has an ACTIVE it_admin, user 4):
--   users 1 B1 broker, 2 B2 broker, 3 A1 admin, 4 I1 it_admin, 5 G1 agent, 6 G2 agent, 7 G3 agent,
--         8 suspended agent, 10 broker O2, 14 no membership
--   409 'Report nine' owner 8 (suspended), 410 'Report ten' owner NULL, 401 'Report one' owner G1
--   (active), 416 in T (broker_reports off) owner NULL
-- Added here (ids from the same fx()):
--   org 107 O5 Enterprise, NO active it_admin: 20 admin, 21 broker, 22 agent, 23 agent SUSPENDED,
--          24 it_admin SUSPENDED;  25 it_admin ACTIVE in T (105, broker_reports off)
--   420 'Report twenty' O5 owner 23 (suspended), 421 'Report twenty-one' O5 owner 22 (active)
--   402-style access: 409, 410, 416, 420, 421 set to general_access 'organization' so every active
--   member has a level (def_get answers) — eligibility must not come from the level.

CREATE FUNCTION pg_temp.setup2() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p3513b-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM unnest(ARRAY[20, 21, 22, 23, 24, 25]) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p3513b-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P3513B user ' || x
    FROM unnest(ARRAY[20, 21, 22, 23, 24, 25]) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
  INSERT INTO public.organizations (id, name, slug, plan, is_test, personal_owner_user_id, max_seats)
  VALUES (pg_temp.fx(107), 'P3513B Five', 'p3513b-o5', 'enterprise', true, NULL, 0);
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  SELECT pg_temp.fx(107), pg_temp.fx(u), r, s FROM (VALUES
    (20, 'admin', 'active'), (21, 'broker', 'active'), (22, 'agent', 'active'),
    (23, 'agent', 'suspended'), (24, 'it_admin', 'suspended')) AS v(u, r, s);
  -- an active it_admin of T (broker_reports off), so the feature check is the only refusal there
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  VALUES (pg_temp.fx(105), pg_temp.fx(25), 'it_admin', 'active');
  DELETE FROM public.organization_plans WHERE organization_id = pg_temp.fx(107);
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  VALUES (pg_temp.fx(107), (SELECT id FROM public.plans WHERE name = 'Enterprise'), '{}');
  INSERT INTO public.broker_report_definitions (id, organization_id, dataset_key, name, owner_user_id, created_by)
  VALUES (pg_temp.fx(420), pg_temp.fx(107), 'submissions', 'Report twenty', pg_temp.fx(23), pg_temp.fx(23)),
         (pg_temp.fx(421), pg_temp.fx(107), 'submissions', 'Report twenty-one', pg_temp.fx(22), pg_temp.fx(22));
  UPDATE public.broker_report_definitions SET general_access = 'organization'
   WHERE id IN (pg_temp.fx(401), pg_temp.fx(409), pg_temp.fx(410), pg_temp.fx(416), pg_temp.fx(420), pg_temp.fx(421));
  -- the new owner-to-be of 409 already holds a person grant (must be removed on reassign)
  INSERT INTO public.broker_report_definition_grants (definition_id, principal_type, principal_user_id, level)
  VALUES (pg_temp.fx(409), 'user', pg_temp.fx(7), 'editor');
END $b$;

-- reassign_available for user u on def d, or the error
CREATE FUNCTION pg_temp.ra(u int, def int) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE s text;
BEGIN
  s := pg_temp.call_as(u, format('SELECT public.broker_report_def_get(%L::uuid)', pg_temp.fx(def)));
  RETURN CASE WHEN s LIKE 'ERR%' THEN s ELSE coalesce(s::jsonb ->> 'reassign_available', 'absent')
              || CASE WHEN s::jsonb ? 'take_over_available' THEN '+take_over_key' ELSE '' END END;
END $b$;
CREATE FUNCTION pg_temp.q_re(def int, nu int) RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT public.broker_report_reassign(%L::uuid, %L::uuid)', pg_temp.fx(def), pg_temp.fx(nu))
$b$;
CREATE FUNCTION pg_temp.owner_of(def int) RETURNS int LANGUAGE sql AS $b$
  SELECT pg_temp.nx(owner_user_id) FROM public.broker_report_definitions WHERE id = pg_temp.fx(def)
$b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE
  r jsonb := '{}'::jsonb;
  s text;
  NF text := 'ERR P0001 Report not found';
  OK text := '{"success": true}';
BEGIN
  PERFORM pg_temp.setup();
  PERFORM pg_temp.setup2();

  -- ===== catalog =====
  r := r || jsonb_build_object('C_current_user', pg_temp.pass(
    pg_temp.call_as(1, 'SELECT to_jsonb(current_user::text)') = 'authenticated', 'not authenticated'));
  r := r || jsonb_build_object('C_take_over_gone', pg_temp.pass(
    to_regprocedure('public.broker_report_take_over(uuid)') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'broker_report_take_over'),
    'broker_report_take_over still exists'));
  s := pg_temp.call_as(4, format('SELECT public.broker_report_take_over(%L::uuid)', pg_temp.fx(410)));
  r := r || jsonb_build_object('C_take_over_not_callable', pg_temp.pass(s LIKE 'ERR 42883%', s));
  SELECT string_agg(x || '=' || (has_function_privilege('anon', to_regprocedure(x), 'EXECUTE'))::text || '/'
                    || (has_function_privilege('authenticated', to_regprocedure(x), 'EXECUTE'))::text || '/'
                    || (SELECT (prosecdef AND proconfig::text LIKE '%search_path=public%'
                                AND coalesce(proacl::text, '') NOT LIKE '%{=X%' AND coalesce(proacl::text, '') NOT LIKE '%,=X%')::text
                          FROM pg_proc WHERE oid = to_regprocedure(x)), ' ' ORDER BY x)
    INTO s FROM unnest(ARRAY['public.broker_report_reassign(uuid,uuid)', 'public.broker_report_reassign_candidates(uuid)',
                             'public.broker_report_def_get(uuid)', 'public._broker_report_reassign_eligible(uuid)']) x;
  r := r || jsonb_build_object('C_grants', pg_temp.pass(s =
    'public._broker_report_reassign_eligible(uuid)=false/false/true public.broker_report_def_get(uuid)=false/true/true '
    'public.broker_report_reassign_candidates(uuid)=false/true/true public.broker_report_reassign(uuid,uuid)=false/true/true', s));
  s := pg_temp.call_as(4, format('SELECT to_jsonb(public._broker_report_reassign_eligible(%L::uuid))', pg_temp.fx(410)));
  r := r || jsonb_build_object('C_eligible_private', pg_temp.pass(s LIKE 'ERR 42501%', s));
  s := pg_temp.call_as(4, pg_temp.q_re(410, 5), 'anon');
  r := r || jsonb_build_object('C_anon_refused', pg_temp.pass(s LIKE 'ERR 42501%', s));

  -- ===== reassign_available (def_get) =====
  r := r || jsonb_build_object('RA_it_admin_owner_suspended', pg_temp.pass(pg_temp.ra(4, 409) = 'true', pg_temp.ra(4, 409)));
  r := r || jsonb_build_object('RA_it_admin_owner_null', pg_temp.pass(pg_temp.ra(4, 410) = 'true', pg_temp.ra(4, 410)));
  r := r || jsonb_build_object('RA_it_admin_owner_active', pg_temp.pass(pg_temp.ra(4, 401) = 'false', pg_temp.ra(4, 401)));
  r := r || jsonb_build_object('RA_admin_when_it_admin_exists', pg_temp.pass(pg_temp.ra(3, 409) = 'false', pg_temp.ra(3, 409)));
  r := r || jsonb_build_object('RA_broker', pg_temp.pass(pg_temp.ra(1, 409) = 'false', pg_temp.ra(1, 409)));
  r := r || jsonb_build_object('RA_agent', pg_temp.pass(pg_temp.ra(5, 409) = 'false', pg_temp.ra(5, 409)));
  r := r || jsonb_build_object('RA_admin_no_active_it_admin', pg_temp.pass(pg_temp.ra(20, 420) = 'true', pg_temp.ra(20, 420)));
  r := r || jsonb_build_object('RA_admin_no_it_admin_owner_active', pg_temp.pass(pg_temp.ra(20, 421) = 'false', pg_temp.ra(20, 421)));
  r := r || jsonb_build_object('RA_broker_no_it_admin', pg_temp.pass(pg_temp.ra(21, 420) = 'false', pg_temp.ra(21, 420)));

  -- ===== candidates =====
  s := pg_temp.call_as(4, format('SELECT public.broker_report_reassign_candidates(%L::uuid)', pg_temp.fx(409)));
  r := r || jsonb_build_object('K_candidates_active_same_org', pg_temp.pass(s NOT LIKE 'ERR%' AND
    (SELECT jsonb_agg(pg_temp.nx((e ->> 'id')::uuid) ORDER BY pg_temp.nx((e ->> 'id')::uuid)) FROM jsonb_array_elements(s::jsonb) e)
      = '[1, 2, 3, 4, 5, 6, 7]' AND s NOT LIKE '%@%' AND s NOT LIKE '%"email"%', s));
  s := pg_temp.call_as(1, format('SELECT public.broker_report_reassign_candidates(%L::uuid)', pg_temp.fx(409)));
  r := r || jsonb_build_object('K_candidates_broker_refused', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(4, format('SELECT public.broker_report_reassign_candidates(%L::uuid)', pg_temp.fx(401)));
  r := r || jsonb_build_object('K_candidates_owner_active_refused', pg_temp.pass(s = NF, s));
  -- SR C1: a caller from ANOTHER organization (the O1 IT admin on O5's orphaned 420; O5 has no active
  -- IT admin, so only the caller's own membership refuses) and a non-member (user 14 on O1's 409)
  s := pg_temp.call_as(4, format('SELECT public.broker_report_reassign_candidates(%L::uuid)', pg_temp.fx(420)));
  r := r || jsonb_build_object('K_candidates_other_org_refused', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(14, format('SELECT public.broker_report_reassign_candidates(%L::uuid)', pg_temp.fx(409)));
  r := r || jsonb_build_object('K_candidates_nonmember_refused', pg_temp.pass(s = NF, s));

  -- ===== refusals (nothing changes, no audit row) =====
  r := r || jsonb_build_object('X_admin_when_it_admin_exists', pg_temp.ctl(3, pg_temp.q_re(409, 5), NF, '[]'));
  r := r || jsonb_build_object('X_broker', pg_temp.ctl(1, pg_temp.q_re(409, 5), NF, '[]'));
  r := r || jsonb_build_object('X_agent', pg_temp.ctl(5, pg_temp.q_re(409, 6), NF, '[]'));
  r := r || jsonb_build_object('X_owner_active', pg_temp.ctl(4, pg_temp.q_re(401, 6), NF, '[]'));
  r := r || jsonb_build_object('X_new_owner_other_org', pg_temp.ctl(4, pg_temp.q_re(409, 10), NF, '[]'));
  r := r || jsonb_build_object('X_new_owner_inactive', pg_temp.ctl(4, pg_temp.q_re(410, 8), NF, '[]'));
  r := r || jsonb_build_object('X_new_owner_nonmember', pg_temp.ctl(4, pg_temp.q_re(410, 14), NF, '[]'));
  r := r || jsonb_build_object('X_new_owner_is_current', pg_temp.ctl(4, pg_temp.q_re(409, 8), NF, '[]'));
  r := r || jsonb_build_object('X_feature_off', pg_temp.ctl(25, pg_temp.q_re(416, 13), NF, '[]'));
  r := r || jsonb_build_object('X_other_org_caller', pg_temp.ctl(4, pg_temp.q_re(420, 22), NF, '[]'));
  r := r || jsonb_build_object('X_broker_no_it_admin', pg_temp.ctl(21, pg_temp.q_re(420, 22), NF, '[]'));
  r := r || jsonb_build_object('X_suspended_it_admin', pg_temp.ctl(24, pg_temp.q_re(420, 22), NF, '[]'));
  r := r || jsonb_build_object('X_state_unchanged', pg_temp.pass(
    pg_temp.owner_of(409) = 8 AND pg_temp.owner_of(410) IS NULL AND pg_temp.owner_of(401) = 5 AND pg_temp.owner_of(420) = 23,
    format('409=%s 410=%s 401=%s 420=%s', pg_temp.owner_of(409), pg_temp.owner_of(410), pg_temp.owner_of(401), pg_temp.owner_of(420))));

  -- ===== successes =====
  -- it_admin gives 409 (owner suspended user 8) to agent G3, who already held editor
  r := r || jsonb_build_object('S_it_admin_reassigns', pg_temp.ctl(4, pg_temp.q_re(409, 7), OK,
    jsonb_build_array(pg_temp.ar(4, 'report_owner_changed', 409, 'Report nine',
      '{"via":"reassign","from":"P3513B user 8","to":"P3513B user 7","member":7}'))));
  r := r || jsonb_build_object('S_it_admin_after_state', pg_temp.pass(
    pg_temp.owner_of(409) = 7
    AND NOT EXISTS (SELECT 1 FROM public.broker_report_definition_grants WHERE definition_id = pg_temp.fx(409)
                     AND principal_type = 'user' AND principal_user_id = pg_temp.fx(7))
    AND pg_temp.lvl(7, 409) = 'owner' AND pg_temp.ra(4, 409) = 'false', 'owner=' || pg_temp.owner_of(409) || ' ra=' || pg_temp.ra(4, 409)));
  -- owner NULL -> from null
  r := r || jsonb_build_object('S_it_admin_owner_null', pg_temp.ctl(4, pg_temp.q_re(410, 2), OK,
    jsonb_build_array(pg_temp.ar(4, 'report_owner_changed', 410, 'Report ten',
      '{"via":"reassign","from":null,"to":"P3513B user 2","member":2}'))));
  -- admin in an org with no ACTIVE it_admin (the it_admin there is suspended)
  r := r || jsonb_build_object('S_admin_no_active_it_admin', pg_temp.ctl(20, pg_temp.q_re(420, 22), OK,
    jsonb_build_array(pg_temp.ar(20, 'report_owner_changed', 420, 'Report twenty',
      '{"via":"reassign","from":"P3513B user 23","to":"P3513B user 22","member":22}'))));
  -- the reader shows who, from, to and the report
  s := pg_temp.call_as(16, format('SELECT public.admin_get_org_activity(%L::uuid, 200)', pg_temp.fx(101)));
  r := r || jsonb_build_object('S_reader_output', pg_temp.pass(s NOT LIKE 'ERR%' AND
    (SELECT count(*) FROM jsonb_array_elements(s::jsonb) e
      WHERE e ->> 'action' = 'report_owner_changed' AND e -> 'detail' ->> 'via' = 'reassign'
        AND e -> 'detail' ->> 'report_name' = 'Report nine' AND e -> 'detail' ->> 'from' = 'P3513B user 8'
        AND e -> 'detail' ->> 'to' = 'P3513B user 7' AND e ->> 'actor_name' = 'P3513B user 4'
        AND e ->> 'subject_name' = 'P3513B user 7') = 1, left(s, 300)));

  -- ===== K2: the pin refuses an unknown def_get body =====
  BEGIN
    EXECUTE $q$CREATE OR REPLACE FUNCTION public.broker_report_def_get(p_def uuid) RETURNS jsonb
             LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS 'SELECT NULL::jsonb'$q$;
    EXECUTE $mg$__MIGRATION__$mg$;
    s := 'applied';
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL; ELSE s := SQLERRM; END IF;
  END;
  r := r || jsonb_build_object('K2_pin_refuses_unknown_def_get', pg_temp.pass(s LIKE '%broker_report_def_get(uuid) body changed%', s));

  -- ===== K4: rollback restores 210000 def_get + 200000 take_over, drops the new functions =====
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.broker_report_def_get(uuid)'))
         || '/' || coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.broker_report_take_over(uuid)')), 'none')
         || '/' || (has_function_privilege('authenticated', 'public.broker_report_take_over(uuid)', 'EXECUTE')
                    AND NOT has_function_privilege('anon', 'public.broker_report_take_over(uuid)', 'EXECUTE'))::text
         || '/' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                     AND proname IN ('broker_report_reassign', 'broker_report_reassign_candidates', '_broker_report_reassign_eligible'));
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL; ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K4_rollback', pg_temp.pass(
    s = 'cb8bc16c908873fb53cf0ff34b146b7b/b6b0d7843e1f1308f24c5cdd1af19406/true/0', s));

  RETURN r;
END $b$;

DO $drv$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P3513B_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
