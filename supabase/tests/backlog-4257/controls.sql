-- BACKLOG-4257 PR A DB controls: _learn_pilot_signals_invalid, the schema-2 branch of
-- _learn_pilot_report_invalid, learn_pilot_report_submit with schema 1 and 2, grants, rollback.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). Composed by compose.py into ONE call:
--   rollback-4257 -> 4257 migration twice -> THIS block -> backlog-4219/controls.sql (plain, not
--   --with-migration), all one transaction ending in the 4219 RAISE, so nothing persists.
-- This block runs inside a subtransaction that it rolls back itself; it leaves only a temp table
-- pg_temp.p4257_result (r = control map, i = info) that the 4219 block folds into P4219_RESULT.
-- Placeholders (__X__) are filled by compose.py from build.py. Fixtures are invented:
--   ids 00000000-0000-4257-8000-<n>, emails p4257-<n>@example.test
--   u1 member of org X (brokerage, active; autodetect_eval on)   u5 signed in, no org

DO $k4257$
DECLARE
  v jsonb;
  d text;
BEGIN
  BEGIN
    EXECUTE $f$CREATE FUNCTION pg_temp.k_fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
      SELECT ('00000000-0000-4257-8000-' || lpad(n::text, 12, '0'))::uuid
    $b$$f$;

    EXECUTE $f$CREATE FUNCTION pg_temp.k_pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
      SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 300) END
    $b$$f$;

    -- one statement as a role; jsonb result as text, '"ok"' for non-SELECT, 'ERR <state> <msg>' on error
    EXECUTE $f$CREATE FUNCTION pg_temp.k_call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
    DECLARE j jsonb;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
        PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
        PERFORM set_config('request.jwt.claim.role', r, true);
        EXECUTE format('SET LOCAL ROLE %I', r);
        IF q ~* '^\s*(select|with)\M' THEN EXECUTE q INTO j; ELSE EXECUTE q; j := '"ok"'::jsonb; END IF;
        EXECUTE 'RESET ROLE';
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claim.role', '', true);
        RETURN coalesce(j::text, 'null');
      EXCEPTION WHEN OTHERS THEN
        EXECUTE 'RESET ROLE';
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claim.role', '', true);
        RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100);
      END;
    END $b$$f$;

    EXECUTE $f$CREATE FUNCTION pg_temp.k_sub(u uuid, p jsonb) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.k_call_as(u, format('SELECT to_jsonb(public.learn_pilot_report_submit(%L::jsonb)::text)', p))
    $b$$f$;

    -- 'ERR <state> DETAIL=<detail>' when submit raises, else 'none'
    EXECUTE $f$CREATE FUNCTION pg_temp.k_det(u uuid, p jsonb) RETURNS text LANGUAGE plpgsql AS $b$
    DECLARE dd text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
        SET LOCAL ROLE authenticated;
        PERFORM public.learn_pilot_report_submit(p);
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        RETURN 'none';
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS dd = PG_EXCEPTION_DETAIL;
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        RETURN 'ERR ' || SQLSTATE || ' DETAIL=' || coalesce(dd, '');
      END;
    END $b$$f$;

    -- a text[] path from a jsonb array of strings
    EXECUTE $f$CREATE FUNCTION pg_temp.k_path(j jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $b$
      SELECT ARRAY(SELECT jsonb_array_elements_text(j))
    $b$$f$;

    EXECUTE $f$CREATE FUNCTION pg_temp.k_run() RETURNS jsonb LANGUAGE plpgsql AS $b$
    DECLARE
      r jsonb := '{}'::jsonb;
      info jsonb := '{}'::jsonb;
      s text; s2 text; k text; p jsonb; x jsonb; n int; n2 int; pth text[]; bad text;
      u1 uuid := pg_temp.k_fx(1); u5 uuid := pg_temp.k_fx(5); oX uuid := pg_temp.k_fx(31);
      pl_team uuid := (SELECT id FROM public.plans WHERE name = 'Team');
      fixture1 jsonb := $pj$__FIXTURE__$pj$::jsonb;
      rep2 jsonb := $pj$__REP2__$pj$::jsonb;
      max2 jsonb := $pj$__MAX2__$pj$::jsonb;
      obj_paths jsonb := $pj$__OBJ_PATHS__$pj$::jsonb;
      key_paths jsonb := $pj$__KEY_PATHS__$pj$::jsonb;
      int_paths jsonb := $pj$__INT_PATHS__$pj$::jsonb;
      bool_paths jsonb := $pj$__BOOL_PATHS__$pj$::jsonb;
      md5_4219 text := '__MD5_4219__';
      INVALID text := 'ERR 22023 Invalid report';
      anon_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'anon');
      auth_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'authenticated');
      expected_private text[] := ARRAY['_learn_pilot_census_invalid', '_learn_pilot_counts_ok', '_learn_pilot_int_ok',
                                       '_learn_pilot_report_invalid', '_learn_pilot_signals_invalid'];
    BEGIN
      -- ===== fixtures =====
      INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      SELECT pg_temp.k_fx(i), 'p4257-' || i || '@example.test', 'authenticated', 'authenticated',
             '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
        FROM unnest(ARRAY[1, 5]) i;
      INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
      SELECT pg_temp.k_fx(i), 'p4257-' || i || '@example.test', 'email', pg_temp.k_fx(i)::text, 'P4257 user ' || i
        FROM unnest(ARRAY[1, 5]) i
      ON CONFLICT (id) DO NOTHING;
      SET LOCAL session_replication_role = replica;
      INSERT INTO public.organizations (id, name, slug) VALUES (oX, 'P4257 X', 'p4257-x');
      INSERT INTO public.organization_members (organization_id, user_id, role, license_status, created_at)
        VALUES (oX, u1, 'agent', 'active', now());
      INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
        VALUES (oX, pl_team, '{"autodetect_eval":{"enabled":true}}');
      SET LOCAL session_replication_role = origin;

      r := r || jsonb_build_object('4257_K0_fixtures', pg_temp.k_pass(
        pl_team IS NOT NULL
        AND pg_temp.k_call_as(u1, format('SELECT public.check_feature_access(%L, ''autodetect_eval'')->''allowed''', oX)) = 'true'
        AND public._learn_pilot_report_invalid(fixture1) IS NULL
        AND public._learn_pilot_report_invalid(rep2) IS NULL
        AND fixture1->'schema' = '1'::jsonb AND rep2->'schema' = '2'::jsonb
        AND jsonb_array_length(obj_paths) > 100 AND jsonb_array_length(int_paths) > 500,
        'fixture=' || coalesce(public._learn_pilot_report_invalid(fixture1), 'VALID')
        || ' rep2=' || coalesce(public._learn_pilot_report_invalid(rep2), 'VALID')
        || ' obj=' || jsonb_array_length(obj_paths) || ' int=' || jsonb_array_length(int_paths)));

      -- ===== R1a: the committed REAL 2.49 fixture (pilotReport-real-4219.json .report) is accepted and stored as sent =====
      s := pg_temp.k_sub(u1, fixture1);
      r := r || jsonb_build_object('4257_R1a_real_fixture_accepted', pg_temp.k_pass(
        s = '""' AND (SELECT count(*) = 1 AND bool_and(report = fixture1) FROM public.learn_pilot_reports WHERE user_id = u1),
        s));
      DELETE FROM public.learn_pilot_reports WHERE user_id = u1;

      -- ===== R1c: one schema-1 report passes; one malformed (extra top-level key) is refused 22023 =====
      s := pg_temp.k_sub(u1, fixture1);
      s2 := pg_temp.k_sub(u1, fixture1 || '{"extra": 1}');
      r := r || jsonb_build_object('4257_R1c_schema1_pass_malformed_22023', pg_temp.k_pass(
        s = '""' AND s2 LIKE INVALID || '%', s || ' | ' || s2));
      DELETE FROM public.learn_pilot_reports WHERE user_id = u1;

      -- ===== S0: a valid schema 2 is accepted and stored as sent =====
      s := pg_temp.k_sub(u1, rep2);
      r := r || jsonb_build_object('4257_S0_schema2_accepted', pg_temp.k_pass(
        s = '""' AND (SELECT count(*) = 1 AND bool_and(report = rep2) FROM public.learn_pilot_reports WHERE user_id = u1),
        s));
      DELETE FROM public.learn_pilot_reports WHERE user_id = u1;

      -- ===== S1: every object node of signals refuses one extra key; every key missing is refused;
      --       every leaf of the wrong type or out of range is refused; a free-text key is refused =====
      bad := ''; n := 0;
      FOR x IN SELECT e FROM jsonb_array_elements(obj_paths) e LOOP
        pth := pg_temp.k_path(x);
        n := n + 1;
        IF public._learn_pilot_report_invalid(jsonb_set(rep2, pth || ARRAY['zz_extra'], '1')) IS NULL THEN
          bad := bad || 'extra@' || array_to_string(pth, '.') || ' ';
        END IF;
        IF public._learn_pilot_report_invalid(jsonb_set(rep2, pth || ARRAY['agent@x.example'], '0')) IS NULL THEN
          bad := bad || 'freetext@' || array_to_string(pth, '.') || ' ';
        END IF;
      END LOOP;
      FOR x IN SELECT e FROM jsonb_array_elements(key_paths) e LOOP
        pth := pg_temp.k_path(x);
        n := n + 1;
        IF public._learn_pilot_report_invalid(rep2 #- pth) IS NULL THEN
          bad := bad || 'missing@' || array_to_string(pth, '.') || ' ';
        END IF;
      END LOOP;
      FOR x IN SELECT e FROM jsonb_array_elements(int_paths) e LOOP
        pth := pg_temp.k_path(x);
        FOREACH k IN ARRAY ARRAY['-1', '1.5', '"1"', '10000001', 'null', 'true', '{}'] LOOP
          n := n + 1;
          IF public._learn_pilot_report_invalid(jsonb_set(rep2, pth, k::jsonb)) IS NULL THEN
            bad := bad || 'int' || k || '@' || array_to_string(pth, '.') || ' ';
          END IF;
        END LOOP;
      END LOOP;
      FOR x IN SELECT e FROM jsonb_array_elements(bool_paths) e LOOP
        pth := pg_temp.k_path(x);
        FOREACH k IN ARRAY ARRAY['1', '"false"', 'null'] LOOP
          n := n + 1;
          IF public._learn_pilot_report_invalid(jsonb_set(rep2, pth, k::jsonb)) IS NULL THEN
            bad := bad || 'bool' || k || '@' || array_to_string(pth, '.') || ' ';
          END IF;
        END LOOP;
      END LOOP;
      s := pg_temp.k_det(u1, jsonb_set(rep2, '{signals,zz_extra}', '1'));
      info := info || jsonb_build_object('S1_cases', n);
      r := r || jsonb_build_object('4257_S1_signals_exact_every_level', pg_temp.k_pass(
        bad = '' AND n > 4000 AND s = 'ERR 22023 DETAIL=signals: keys'
        AND (SELECT count(*) FROM public.learn_pilot_reports WHERE user_id = u1) = 0,
        'n=' || n || ' submit=' || s || ' bad=' || left(bad, 250)));

      DELETE FROM public.learn_pilot_reports WHERE user_id = u1;

      -- ===== S2: a schema 2 still gets every schema-1 check on the rest of the report =====
      bad := '';
      FOR k, p IN SELECT * FROM (VALUES
          ('top_unknown_key', rep2 || '{"extra": 1}'),
          ('top_missing_key', rep2 - 'missed'),
          ('nested_unknown_key', jsonb_set(rep2, '{cleanup,extra}', '1')),
          ('negative', jsonb_set(rep2, '{found}', '-1')),
          ('float', jsonb_set(rep2, '{detections}', '1.5')),
          ('app_version_text', jsonb_set(rep2, '{app_version}', '"2.47.0 agent@x.example"')),
          ('provider_domain', jsonb_set(rep2, '{census,learn_questions,mailboxes,0,provider}', '"yahoo.com"')),
          ('sender_rules_version_0', jsonb_set(rep2, '{sender_rules_version}', '0')),
          ('census_missing', rep2 - 'census')) t(name, rep)
      LOOP
        IF public._learn_pilot_report_invalid(p) IS NULL THEN bad := bad || k || ' '; END IF;
      END LOOP;
      s := pg_temp.k_det(u1, rep2 || '{"extra": 1}');
      r := r || jsonb_build_object('4257_S2_schema2_base_checked', pg_temp.k_pass(
        bad = '' AND s = 'ERR 22023 DETAIL=report keys', 'bad=' || bad || ' submit=' || s));

      DELETE FROM public.learn_pilot_reports WHERE user_id = u1;

      -- ===== S3: a schema 1 carrying signals is refused on its keys =====
      s := pg_temp.k_det(u1, fixture1 || jsonb_build_object('signals', rep2->'signals'));
      r := r || jsonb_build_object('4257_S3_schema1_with_signals_refused', pg_temp.k_pass(
        s = 'ERR 22023 DETAIL=report keys', s));

      DELETE FROM public.learn_pilot_reports WHERE user_id = u1;

      -- ===== S4: only signals_version 1 is known; missing 'signals' is refused =====
      bad := '';
      FOR k, p IN SELECT * FROM (VALUES
          ('v2', jsonb_set(rep2, '{signals,signals_version}', '2')),
          ('v0', jsonb_set(rep2, '{signals,signals_version}', '0')),
          ('v_string', jsonb_set(rep2, '{signals,signals_version}', '"1"')),
          ('v_null', jsonb_set(rep2, '{signals,signals_version}', 'null')),
          ('v_missing', rep2 #- '{signals,signals_version}')) t(name, rep)
      LOOP
        s := public._learn_pilot_report_invalid(p);
        IF s IS DISTINCT FROM 'signals: signals_version' THEN bad := bad || k || '=' || coalesce(s, 'VALID') || ' '; END IF;
      END LOOP;
      s := public._learn_pilot_report_invalid(rep2 - 'signals');
      s2 := public._learn_pilot_report_invalid(jsonb_set(rep2, '{signals}', '[]'));
      r := r || jsonb_build_object('4257_S4_signals_version_and_presence', pg_temp.k_pass(
        bad = '' AND s = 'signals' AND s2 = 'signals: not an object',
        'bad=' || bad || ' no_signals=' || coalesce(s, 'VALID') || ' array=' || coalesce(s2, 'VALID')));

      -- ===== S5 / R1d: every private _learn_pilot_* function: proacl set, no EXECUTE for PUBLIC,
      --       anon or authenticated (aclexplode), and a signed-in call is refused =====
      bad := '';
      FOR k, s IN SELECT p2.proname, p2.oid::regprocedure::text FROM pg_proc p2
                  WHERE p2.pronamespace = 'public'::regnamespace AND p2.proname LIKE '\_learn\_pilot\_%' ESCAPE '\'
      LOOP
        IF (SELECT proacl IS NULL FROM pg_proc WHERE oid = s::regprocedure) THEN bad := bad || 'default_acl:' || k || ' '; END IF;
        IF EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(pp.proacl) a
                   WHERE pp.oid = s::regprocedure AND a.privilege_type = 'EXECUTE'
                     AND a.grantee IN (0, anon_oid, auth_oid)) THEN
          bad := bad || 'grant:' || k || ' ';
        END IF;
        IF has_function_privilege('anon', s, 'EXECUTE') OR has_function_privilege('authenticated', s, 'EXECUTE') THEN
          bad := bad || 'priv:' || k || ' ';
        END IF;
      END LOOP;
      s := pg_temp.k_call_as(u5, 'SELECT to_jsonb(public._learn_pilot_signals_invalid(''{}''::jsonb))');
      s2 := pg_temp.k_call_as(NULL, 'SELECT to_jsonb(public._learn_pilot_signals_invalid(''{}''::jsonb))', 'anon');
      info := info || jsonb_build_object('S5_acls', (SELECT jsonb_object_agg(p2.proname, coalesce(p2.proacl::text, 'NULL'))
        FROM pg_proc p2 WHERE p2.pronamespace = 'public'::regnamespace AND p2.proname LIKE '\_learn\_pilot\_%' ESCAPE '\'));
      r := r || jsonb_build_object('4257_S5_R1d_private_functions_revoked', pg_temp.k_pass(
        bad = '' AND s LIKE 'ERR 42501%' AND s2 LIKE 'ERR 42501%'
        AND (SELECT array_agg(p2.proname::text ORDER BY p2.proname::text) FROM pg_proc p2
             WHERE p2.pronamespace = 'public'::regnamespace AND p2.proname LIKE '\_learn\_pilot\_%' ESCAPE '\') = expected_private,
        'bad=' || bad || ' auth=' || s || ' anon=' || s2));

      -- ===== C9: a max-valued schema 2 is accepted; the schema-2 cap is 65536 (a 40 KB schema 2 is
      --       refused on its keys, not its size); a 70 KB one is 'too large'; the base keeps 32768 =====
      s := pg_temp.k_sub(u1, max2);
      info := info || jsonb_build_object('C9_max2_octet_length', octet_length(max2::text),
        'C9_max2_compact', __MAX2_COMPACT__, 'C9_max2_estimate', __MAX2_EST__,
        'C9_rep2_octet_length', octet_length(rep2::text));
      r := r || jsonb_build_object('4257_C9a_max_valued_schema2_accepted', pg_temp.k_pass(
        s = '""' AND public._learn_pilot_report_invalid(max2) IS NULL
        AND (SELECT bool_and(report = max2) FROM public.learn_pilot_reports WHERE user_id = u1),
        s || ' len=' || octet_length(max2::text)));
      DELETE FROM public.learn_pilot_reports WHERE user_id = u1;
      s := pg_temp.k_det(u1, jsonb_set(rep2, '{signals,pad}', to_jsonb(repeat('x', 40000))));
      s2 := pg_temp.k_det(u1, jsonb_set(rep2, '{signals,pad}', to_jsonb(repeat('x', 70000))));
      k := pg_temp.k_det(u1, rep2 || jsonb_build_object('pad', repeat('x', 33000)));
      r := r || jsonb_build_object('4257_C9b_schema2_cap_65536', pg_temp.k_pass(
        s = 'ERR 22023 DETAIL=signals: keys' AND s2 = 'ERR 22023 DETAIL=too large' AND k = 'ERR 22023 DETAIL=too large',
        '40k=' || s || ' 70k=' || s2 || ' base33k=' || k));

      DELETE FROM public.learn_pilot_reports WHERE user_id = u1;

      -- ===== R1b: the migration changed the validator; rollback-4257 puts back the 4219 text exactly
      --       (md5 = the 4219 file), the ACL as captured before the run, and removes the signals validator =====
      s2 := (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._learn_pilot_report_invalid(jsonb)'::regprocedure);
      BEGIN
        EXECUTE $rb$__RB4257__$rb$;
        s := CASE WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._learn_pilot_report_invalid(jsonb)'::regprocedure) = md5_4219
                   AND (SELECT proacl::text FROM pg_proc WHERE oid = 'public._learn_pilot_report_invalid(jsonb)'::regprocedure)
                       = current_setting('p4257.before_acl', true)
                   AND to_regprocedure('public._learn_pilot_signals_invalid(jsonb)') IS NULL
                   AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261117120000')
                   AND obj_description('public.learn_pilot_report_submit(jsonb)'::regprocedure, 'pg_proc') LIKE '%schema 1 exactly.'
                   AND public._learn_pilot_report_invalid(fixture1) IS NULL
                   AND public._learn_pilot_report_invalid(rep2) = 'report keys'
              THEN 'restored'
              ELSE 'md5=' || coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._learn_pilot_report_invalid(jsonb)'::regprocedure), '-')
                   || ' acl=' || coalesce((SELECT proacl::text FROM pg_proc WHERE oid = 'public._learn_pilot_report_invalid(jsonb)'::regprocedure), '-')
                   || ' sigfn=' || coalesce(to_regprocedure('public._learn_pilot_signals_invalid(jsonb)')::text, '-')
                   || ' rep2=' || coalesce(public._learn_pilot_report_invalid(rep2), 'VALID') END;
        RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
        ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100); END IF;
      END;
      info := info || jsonb_build_object('R1b_md5_after_migration', s2, 'R1b_md5_4219', md5_4219,
        'R1b_md5_live_before_run', current_setting('p4257.before_md5', true),
        'R1b_acl_live_before_run', current_setting('p4257.before_acl', true));
      r := r || jsonb_build_object('4257_R1b_rollback_restores_4219', pg_temp.k_pass(
        s = 'restored' AND s2 IS DISTINCT FROM md5_4219
        AND to_regprocedure('public._learn_pilot_signals_invalid(jsonb)') IS NOT NULL,
        s || ' after_migration=' || coalesce(s2, '-')));

      RETURN r || jsonb_build_object('__info', info);
    END $b$$f$;

    v := pg_temp.k_run();
    RAISE EXCEPTION 'K4257_DONE' USING DETAIL = v::text;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'K4257_DONE' THEN
      GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
      v := d::jsonb;
    ELSE
      v := jsonb_build_object('4257_ABORTED', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 300), '__info', '{}'::jsonb);
    END IF;
  END;
  CREATE TEMP TABLE p4257_result (r jsonb, i jsonb);
  INSERT INTO p4257_result VALUES (v - '__info', v->'__info');
END
$k4257$;
