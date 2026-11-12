-- BACKLOG-3513 orphans (migration 20261112210000) DB controls. Venue: keepr-test ONLY. Composed by
-- compose.py after 20261112200000 (twice), a ledger row for it, 20261112210000 (twice) and the PR-2
-- prelude (fixtures, pg_temp.call_as = SET LOCAL ROLE authenticated + jwt claims). ONE call, ONE
-- transaction ending in RAISE: nothing persists. Output: RAISE 'P3513B_RESULT {total, pass, fail, reds}'
-- (the PR-2 parse.py reads it). Order-dependent: comments name the state each control expects.
--
-- Fixture orphans (prelude): O1 409 'Report nine' owner 8 (suspended agent), 410 'Report ten' owner
-- NULL, 415 'Report fifteen' owner 8; T 416 owner NULL (broker_reports off). None has a grant.
-- Users: 1 B1 broker, 2 B2 broker, 3 A1 admin, 4 I1 it_admin, 5 G1 agent, 6 G2 agent (O1);
-- 10 broker O2; 13 broker T; 14 no membership.

CREATE FUNCTION pg_temp.orph(o int) RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT coalesce(jsonb_agg(jsonb_build_object(''n'', pg_temp.nx((e ->> ''id'')::uuid), ''s'', e ->> ''owner_state'', '
                '''l'', e -> ''level'', ''o'', e ->> ''owner_name'', ''k'', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(e) k))), ''[]'') '
                'FROM jsonb_array_elements(public.broker_report_orphans(%L::uuid)) e', pg_temp.fx(o))
$b$;
CREATE FUNCTION pg_temp.ids_of(s text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN s LIKE 'ERR%' THEN s
              ELSE (SELECT coalesce(jsonb_agg((x ->> 'n')::int), '[]')::text FROM jsonb_array_elements(s::jsonb) x) END
$b$;
CREATE FUNCTION pg_temp.toa(u int, def int) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE s text;
BEGIN
  s := pg_temp.call_as(u, format('SELECT public.broker_report_def_get(%L::uuid)', pg_temp.fx(def)));
  RETURN CASE WHEN s LIKE 'ERR%' THEN s ELSE coalesce(s::jsonb ->> 'take_over_available', 'absent') END;
END $b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE
  r jsonb := '{}'::jsonb;
  s text;
  NF text := 'ERR P0001 Report not found';
  KEYS text := '["dataset_key", "id", "level", "name", "owner_name", "owner_state"]';
  ORPH_B1 text := '[{"k": ["dataset_key", "id", "level", "name", "owner_name", "owner_state"], "l": null, "n": 415, "o": "P3513B user 8", "s": "deactivated"}, '
                  '{"k": ["dataset_key", "id", "level", "name", "owner_name", "owner_state"], "l": null, "n": 409, "o": "P3513B user 8", "s": "deactivated"}, '
                  '{"k": ["dataset_key", "id", "level", "name", "owner_name", "owner_state"], "l": null, "n": 410, "o": null, "s": "gone"}]';
BEGIN
  PERFORM pg_temp.setup();

  -- ===== catalog =====
  r := r || jsonb_build_object('C_current_user', pg_temp.pass(
    pg_temp.call_as(1, 'SELECT to_jsonb(current_user::text)') = 'authenticated', 'not authenticated'));
  s := (has_function_privilege('anon', 'public.broker_report_orphans(uuid)', 'EXECUTE'))::text || '/'
    || (has_function_privilege('authenticated', 'public.broker_report_orphans(uuid)', 'EXECUTE'))::text || '/'
    || (has_function_privilege('anon', 'public.broker_report_def_get(uuid)', 'EXECUTE'))::text || '/'
    || (has_function_privilege('authenticated', 'public.broker_report_def_get(uuid)', 'EXECUTE'))::text || '/'
    || (SELECT (prosecdef AND proconfig::text LIKE '%search_path=public%')::text FROM pg_proc WHERE oid = to_regprocedure('public.broker_report_orphans(uuid)')) || '/'
    || (SELECT (coalesce(proacl::text, '') NOT LIKE '%{=X%' AND coalesce(proacl::text, '') NOT LIKE '%,=X%')::text
          FROM pg_proc WHERE oid = to_regprocedure('public.broker_report_orphans(uuid)'));
  r := r || jsonb_build_object('C_grants', pg_temp.pass(s = 'false/true/false/true/true/true', s));
  s := (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.broker_report_def_get(uuid)'));
  r := r || jsonb_build_object('C_def_get_body', pg_temp.pass(s = 'cb8bc16c908873fb53cf0ff34b146b7b', s));
  s := pg_temp.call_as(1, format('SELECT public.broker_report_orphans(%L::uuid)', pg_temp.fx(101)), 'anon');
  r := r || jsonb_build_object('C_anon_refused', pg_temp.pass(s LIKE 'ERR 42501%', s));

  -- ===== O1: who sees the orphans of O1 (none of 409 / 410 / 415 is shared with anyone) =====
  r := r || jsonb_build_object('O1_broker_sees_all_three', pg_temp.pass(pg_temp.call_as(1, pg_temp.orph(101)) = ORPH_B1, pg_temp.call_as(1, pg_temp.orph(101))));
  r := r || jsonb_build_object('O1_admin_sees', pg_temp.pass(pg_temp.ids_of(pg_temp.call_as(3, pg_temp.orph(101))) = '[415, 409, 410]', pg_temp.call_as(3, pg_temp.orph(101))));
  r := r || jsonb_build_object('O1_it_admin_sees', pg_temp.pass(pg_temp.ids_of(pg_temp.call_as(4, pg_temp.orph(101))) = '[415, 409, 410]', pg_temp.call_as(4, pg_temp.orph(101))));
  s := pg_temp.call_as(5, pg_temp.orph(101));
  r := r || jsonb_build_object('O1_agent_refused', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(14, pg_temp.orph(101));
  r := r || jsonb_build_object('O1_nonmember_refused', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(10, pg_temp.orph(101));
  r := r || jsonb_build_object('O1_other_org_broker_refused', pg_temp.pass(s = NF, s));
  -- O2 has no orphan: its own broker gets an empty list, never O1's or T's
  s := pg_temp.call_as(10, pg_temp.orph(102));
  r := r || jsonb_build_object('O1_own_org_only', pg_temp.pass(s = '[]', s));
  s := pg_temp.call_as(13, pg_temp.orph(105));
  r := r || jsonb_build_object('O1_feature_off_refused', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(1, 'SELECT public.broker_report_orphans(NULL)');
  r := r || jsonb_build_object('O1_null_org_refused', pg_temp.pass(s = NF, s));

  -- ===== O2: the list carries no definition, filters or rows; a level is still needed to open =====
  s := pg_temp.call_as(1, pg_temp.orph(101));
  r := r || jsonb_build_object('O2_keys_only', pg_temp.pass(
    (SELECT bool_and((x -> 'k')::text = KEYS) FROM jsonb_array_elements(s::jsonb) x), s));
  s := pg_temp.call_as(1, format('SELECT public.broker_report_def_get(%L::uuid)', pg_temp.fx(410)));
  r := r || jsonb_build_object('O2_def_get_refused_without_level', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(1, pg_temp.q_rows(101, 410));
  r := r || jsonb_build_object('O2_rows_refused_without_level', pg_temp.pass(s = NF, s));

  -- ===== O3: take_over_available (the F18 test, for this caller) =====
  -- grants added as postgres: B2 viewer on 410, G2 editor on 409, I1 viewer on 415
  INSERT INTO public.broker_report_definition_grants (definition_id, principal_type, principal_user_id, level) VALUES
    (pg_temp.fx(410), 'user', pg_temp.fx(2), 'viewer'),
    (pg_temp.fx(409), 'user', pg_temp.fx(6), 'editor'),
    (pg_temp.fx(415), 'user', pg_temp.fx(4), 'viewer');
  s := pg_temp.call_as(2, pg_temp.orph(101));
  r := r || jsonb_build_object('O1_level_reported', pg_temp.pass(
    (SELECT x ->> 'l' FROM jsonb_array_elements(s::jsonb) x WHERE (x ->> 'n')::int = 410) = 'viewer'
    AND (SELECT x -> 'l' FROM jsonb_array_elements(s::jsonb) x WHERE (x ->> 'n')::int = 409) = 'null'::jsonb, s));
  s := pg_temp.toa(2, 410);
  r := r || jsonb_build_object('O3_viewer_broker_owner_gone', pg_temp.pass(s = 'true', s));
  s := pg_temp.toa(4, 415);
  r := r || jsonb_build_object('O3_viewer_it_admin_owner_deactivated', pg_temp.pass(s = 'true', s));
  s := pg_temp.toa(6, 409);
  r := r || jsonb_build_object('O3_agent_editor_false', pg_temp.pass(s = 'false', s));
  s := pg_temp.toa(2, 402);
  r := r || jsonb_build_object('O3_owner_active_false', pg_temp.pass(s = 'false', s));
  s := pg_temp.toa(3, 402);
  r := r || jsonb_build_object('O3_admin_editor_owner_active_false', pg_temp.pass(s = 'false', s));
  s := pg_temp.toa(1, 402);
  r := r || jsonb_build_object('O3_owner_false', pg_temp.pass(s = 'false', s));
  -- a non-grantee still cannot read the flag (no level, no def_get)
  s := pg_temp.toa(3, 410);
  r := r || jsonb_build_object('O3_no_level_no_flag', pg_temp.pass(s = NF, s));
  -- F18 unchanged: A1 (no grant) takes over 410 from the list; then it is A1's and no longer an orphan
  s := pg_temp.call_as(3, format('SELECT public.broker_report_take_over(%L::uuid)', pg_temp.fx(410)));
  r := r || jsonb_build_object('O3_non_grantee_takes_over', pg_temp.pass(s = '{"success": true}', s));
  s := pg_temp.lvl(3, 410) || '/' || pg_temp.toa(3, 410) || '/' || pg_temp.ids_of(pg_temp.call_as(1, pg_temp.orph(101)));
  r := r || jsonb_build_object('O3_after_take_over', pg_temp.pass(s = 'owner/false/[415, 409]', s));

  -- ===== K: pin and rollback (subtransactions; undone on exit) =====
  BEGIN
    DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261112200000';
    EXECUTE $mg$__MIGRATION__$mg$;
    s := 'APPLIED';
  EXCEPTION WHEN OTHERS THEN
    s := SQLERRM;
  END;
  r := r || jsonb_build_object('K1_pin_needs_ledger_row', pg_temp.pass(s LIKE '%20261112200000 must be applied first%', s));
  BEGIN
    EXECUTE 'CREATE OR REPLACE FUNCTION public._broker_report_person_name(p_user uuid) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT NULL::text $f$';
    EXECUTE $mg$__MIGRATION__$mg$;
    s := 'APPLIED';
  EXCEPTION WHEN OTHERS THEN
    s := SQLERRM;
  END;
  r := r || jsonb_build_object('K2_pin_refuses_changed_body', pg_temp.pass(s LIKE '%_broker_report_person_name(uuid) body changed%', s));
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.broker_report_def_get(uuid)'))
         || '/' || (to_regprocedure('public.broker_report_orphans(uuid)') IS NULL)::text
         || '/' || has_function_privilege('anon', 'public.broker_report_def_get(uuid)', 'EXECUTE')::text;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL; ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K3_rollback', pg_temp.pass(s = '28ce388e045b149e474fa2d8540e1586/true/false', s));

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
