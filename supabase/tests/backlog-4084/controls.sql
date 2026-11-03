-- BACKLOG-4084 DB controls (report_saved_views.is_default, report_set_default_view,
-- report_list_saved_views returning is_default, grants).
-- Venue: keepr-test, ONE call, ONE transaction ending in RAISE, so nothing persists. Run with
-- compose.py --with-migration (the migration is applied TWICE in front), or after 20261031180000 is
-- applied.
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (its effect is checked; otherwise MUTATION NOT APPLIED), build
-- fixtures, run every check, roll back. 'base' = no mutation (every check must PASS).
-- Fixtures (invented; ids are built at run time from fx(n), emails p4084-<n>@example.test):
--   users  1 internal user A, 2 internal user B, 3 authenticated with no internal role
--   views  21 A / report r1, 22 A / r1, 23 A / r2, 31 B / r1
-- Output: RAISE 'P4084_RESULT {mode: {mutation, pass, fail, reds}}'.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4084-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- run one SELECT returning jsonb as a role ('authenticated' with a user, or 'anon'):
  -- the reply as text, or 'ERR <sqlstate> <message>'
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
      PERFORM set_config('request.jwt.claim.role', r, true);
      EXECUTE format('SET LOCAL ROLE %I', r);
      EXECUTE q INTO j;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(j::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.set_def(u uuid, k text, v uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, format('SELECT public.report_set_default_view(%L, %L::uuid)', k, v))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.list(u uuid, k text) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, format('SELECT public.report_list_saved_views(%L)', k))
  $b$$f$;

  -- ids of the caller's default views for a report, straight from the table
  EXECUTE $f$CREATE FUNCTION pg_temp.defaults(u uuid, k text) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(string_agg(right(id::text, 2), ',' ORDER BY id), '-')
      FROM public.report_saved_views WHERE user_id = u AND report_key = k AND is_default
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || coalesce(detail, 'null') END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.chk(actual text, pattern text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN actual LIKE pattern THEN 'PASS' ELSE 'FAIL ' || left(coalesce(actual, 'null'), 120) END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.def(sig text) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_get_functiondef(sig::regprocedure)
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.acl(sig text) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(proacl::text, 'null') || ' definer=' || prosecdef || ' cfg=' || coalesce(proconfig::text, 'null')
      FROM pg_proc WHERE oid = sig::regprocedure
  $b$$f$;

  -- replace exactly one occurrence of a fragment in a live definition and re-create it
  EXECUTE $f$CREATE FUNCTION pg_temp.rewrite(sig text, old_frag text, new_frag text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text := pg_temp.def(sig); n int; d2 text;
  BEGIN
    n := (length(d) - length(replace(d, old_frag, ''))) / length(old_frag);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: fragment matched % times', n; END IF;
    d2 := replace(d, old_frag, new_frag);
    EXECUTE d2;
    IF md5(pg_temp.def(sig)) = md5(d) OR position(new_frag IN pg_temp.def(sig)) = 0 THEN
      RAISE EXCEPTION 'MUTATION NOT APPLIED: definition unchanged';
    END IF;
    RETURN 'MUTATION APPLIED ' || left(regexp_replace(old_frag, '\s+', ' ', 'g'), 70) || ' -> ' || left(regexp_replace(new_frag, '\s+', ' ', 'g'), 70);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE before text; after text; s1 text; s2 text;
    sd text := 'public.report_set_default_view(text,uuid)';
    sl text := 'public.report_list_saved_views(text)';
    ss text := 'public.report_save_view(text,text,jsonb,jsonb,boolean,uuid)';
  BEGIN
    IF m = 'base' THEN RETURN 'none'; END IF;
    IF m = 'no_owner' THEN
      -- the likely wrong implementation: id + report only, no owner predicate anywhere
      s1 := pg_temp.rewrite(sd, E'WHERE v.id = p_id\n      AND v.user_id = v_caller_id\n      AND v.report_key = p_report_key\n  ) THEN',
                                E'WHERE v.id = p_id\n      AND v.report_key = p_report_key\n  ) THEN');
      s2 := pg_temp.rewrite(sd, E'WHERE v.id = p_id\n      AND v.user_id = v_caller_id\n      AND v.report_key = p_report_key\n      AND NOT v.is_default;',
                                E'WHERE v.id = p_id\n      AND v.report_key = p_report_key\n      AND NOT v.is_default;');
      RETURN s1 || ' | ' || s2;
    ELSIF m = 'no_report_check' THEN
      RETURN pg_temp.rewrite(sd, E'AND v.user_id = v_caller_id\n      AND v.report_key = p_report_key\n  ) THEN',
                                 E'AND v.user_id = v_caller_id\n  ) THEN');
    ELSIF m = 'no_clear' THEN
      RETURN pg_temp.rewrite(sd, E'AND v.is_default\n    AND (p_id IS NULL OR v.id <> p_id);',
                                 E'AND v.is_default\n    AND false;');
    ELSIF m = 'oracle' THEN
      RETURN pg_temp.rewrite(sd, $q$RAISE EXCEPTION 'Saved view not found';$q$,
        $q$RAISE EXCEPTION 'Saved view not found: %', (SELECT CASE WHEN EXISTS (SELECT 1 FROM report_saved_views x WHERE x.id = p_id) THEN 'not yours' ELSE 'missing' END);$q$);
    ELSIF m = 'no_guard' THEN
      RETURN pg_temp.rewrite(sd, E'IF v_caller_id IS NULL OR NOT EXISTS (\n    SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id\n  ) THEN',
                                 'IF false THEN');
    ELSIF m = 'list_no_flag' THEN
      RETURN pg_temp.rewrite(sl, E'''is_default'', v.is_default,\n', '');
    ELSIF m = 'list_no_isolation' THEN
      RETURN pg_temp.rewrite(sl, E'WHERE v.user_id = v_caller_id\n    AND v.report_key', 'WHERE v.report_key');
    ELSIF m = 'save_clears_default' THEN
      RETURN pg_temp.rewrite(ss, E'pinned = p_pinned,\n        updated_at = now()',
                                 E'pinned = p_pinned,\n        is_default = false,\n        updated_at = now()');
    ELSIF m = 'no_unique_index' THEN
      DROP INDEX public.report_saved_views_one_default;
      IF to_regclass('public.report_saved_views_one_default') IS NOT NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED index report_saved_views_one_default removed';
    ELSIF m = 'grant_anon' THEN
      before := pg_temp.acl(sd);
      GRANT EXECUTE ON FUNCTION public.report_set_default_view(text, uuid) TO anon;
      after := pg_temp.acl(sd);
      IF after = before OR NOT has_function_privilege('anon', sd, 'EXECUTE') THEN
        RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m;
      END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE TO anon [' || after || ']';
    ELSIF m = 'grant_public' THEN
      before := pg_temp.acl(sl);
      GRANT EXECUTE ON FUNCTION public.report_list_saved_views(text) TO PUBLIC;
      after := pg_temp.acl(sl);
      IF after = before THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE TO PUBLIC [' || after || ']';
    ELSIF m = 'no_definer' THEN
      before := pg_temp.acl(sd);
      ALTER FUNCTION public.report_set_default_view(text, uuid) SECURITY INVOKER;
      after := pg_temp.acl(sd);
      IF after = before OR after NOT LIKE '%definer=false%' THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED SECURITY INVOKER [' || after || ']';
    END IF;
    RAISE EXCEPTION 'unknown mode %', m;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    s text; s2 text; s3 text; n int;
    A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); C uuid := pg_temp.fx(3);
    r1 text := 'p4084-r1'; r2 text := 'p4084-r2';
    sd text := 'public.report_set_default_view(text,uuid)';
    sl text := 'public.report_list_saved_views(text)';
    d0 text; a0 text; l0 text;
  BEGIN
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p4084-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 3) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT pg_temp.fx(x), 'p4084-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4084 user ' || x
      FROM generate_series(1, 3) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT u, (SELECT ar.id FROM public.admin_roles ar ORDER BY ar.slug LIMIT 1) FROM unnest(ARRAY[A, B]) u;

    INSERT INTO public.report_saved_views (id, user_id, report_key, name, filters, metric, pinned) VALUES
      (pg_temp.fx(21), A, r1, 'A one', '{"period":{"key":"month"}}', '{"col":"rows","fn":"count"}', false),
      (pg_temp.fx(22), A, r1, 'A two', '{}', '{"col":"rows","fn":"count"}', true),
      (pg_temp.fx(23), A, r2, 'A other report', '{}', '{"col":"rows","fn":"count"}', false),
      (pg_temp.fx(31), B, r1, 'B one', '{}', '{"col":"rows","fn":"count"}', false);

    -- ===== C0: fixtures are what they claim =====
    r := r || jsonb_build_object('C0_fixtures', pg_temp.pass(
      (SELECT count(*) FROM public.report_saved_views WHERE user_id IN (A, B, C)) = 4
      AND (SELECT count(*) FROM public.report_saved_views WHERE user_id IN (A, B, C) AND is_default) = 0
      AND EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = A)
      AND EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = B)
      AND NOT EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = C), 'fixture mismatch'));

    -- ===== C1: owner sets a default; the list says which one =====
    s := pg_temp.set_def(A, r1, pg_temp.fx(21));
    r := r || jsonb_build_object('C1a_set_ok', pg_temp.pass(s NOT LIKE 'ERR%' AND pg_temp.defaults(A, r1) = '21', s || ' defaults=' || pg_temp.defaults(A, r1)));
    s := pg_temp.list(A, r1);
    r := r || jsonb_build_object('C1b_list_flags', pg_temp.pass(s NOT LIKE 'ERR%' AND
      (SELECT string_agg(right(e->>'id', 2) || '=' || coalesce(e->>'is_default', '?') || ':' || jsonb_typeof(e->'is_default'), ',' ORDER BY e->>'id')
         FROM jsonb_array_elements(s::jsonb) e) = '21=true:boolean,22=false:boolean', left(s, 160)));

    -- ===== C2: a second set MOVES the flag; exactly one default; other report untouched =====
    UPDATE public.report_saved_views SET is_default = true WHERE id = pg_temp.fx(23);
    s := pg_temp.set_def(A, r1, pg_temp.fx(22));
    r := r || jsonb_build_object('C2_second_set_moves', pg_temp.pass(
      s NOT LIKE 'ERR%' AND pg_temp.defaults(A, r1) = '22' AND pg_temp.defaults(A, r2) = '23',
      s || ' r1=' || pg_temp.defaults(A, r1) || ' r2=' || pg_temp.defaults(A, r2)));

    -- ===== C3: a save (pin toggle) keeps the default =====
    s := pg_temp.call_as(A, format('SELECT public.report_save_view(%L, %L, %L::jsonb, %L::jsonb, false, %L::uuid)',
           r1, 'A two', '{}', '{"col":"rows","fn":"count"}', pg_temp.fx(22)));
    r := r || jsonb_build_object('C3_save_keeps_default', pg_temp.pass(
      s NOT LIKE 'ERR%' AND pg_temp.defaults(A, r1) = '22', s || ' defaults=' || pg_temp.defaults(A, r1)));

    -- ===== C4: another user cannot set your view as default, or read that it is =====
    s := pg_temp.set_def(B, r1, pg_temp.fx(21));
    r := r || jsonb_build_object('C4a_cross_user_set_refused', pg_temp.pass(
      s = 'ERR P0001 Saved view not found' AND pg_temp.defaults(A, r1) = '22' AND pg_temp.defaults(B, r1) = '-',
      s || ' A=' || pg_temp.defaults(A, r1) || ' B=' || pg_temp.defaults(B, r1)));
    s := pg_temp.list(B, r1);
    r := r || jsonb_build_object('C4b_cross_user_list_isolated', pg_temp.pass(
      s NOT LIKE 'ERR%' AND (SELECT string_agg(right(e->>'id', 2) || '=' || (e->>'is_default'), ',') FROM jsonb_array_elements(s::jsonb) e) = '31=false',
      left(s, 160)));
    -- B clearing its own default must not clear A's
    s := pg_temp.set_def(B, r1, NULL);
    r := r || jsonb_build_object('C4c_clear_scoped_to_caller', pg_temp.pass(
      s NOT LIKE 'ERR%' AND pg_temp.defaults(A, r1) = '22', s || ' A=' || pg_temp.defaults(A, r1)));

    -- ===== C5: a view of another report is refused =====
    s := pg_temp.set_def(A, r1, pg_temp.fx(23));
    r := r || jsonb_build_object('C5_other_report_refused', pg_temp.pass(
      s = 'ERR P0001 Saved view not found' AND pg_temp.defaults(A, r1) = '22',
      s || ' r1=' || pg_temp.defaults(A, r1)));

    -- ===== C6: missing id, someone else's id and other-report id get the SAME reply =====
    s := pg_temp.set_def(A, r1, pg_temp.fx(99));
    s2 := pg_temp.set_def(A, r1, pg_temp.fx(31));
    s3 := pg_temp.set_def(A, r1, pg_temp.fx(23));
    r := r || jsonb_build_object('C6_no_existence_oracle', pg_temp.pass(
      s LIKE 'ERR %' AND s = s2 AND s2 = s3, s || ' | ' || s2 || ' | ' || s3));

    -- ===== C7: two defaults for one user and report are impossible, even by a direct write =====
    BEGIN
      UPDATE public.report_saved_views SET is_default = true WHERE id = pg_temp.fx(21);
      s := 'second default written: ' || pg_temp.defaults(A, r1);
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE; END IF;
    END;
    r := r || jsonb_build_object('C7_two_defaults_impossible', pg_temp.chk(s, 'ERR 23505'));

    -- ===== C8: clear =====
    s := pg_temp.set_def(A, r1, NULL);
    r := r || jsonb_build_object('C8_clear', pg_temp.pass(
      s NOT LIKE 'ERR%' AND pg_temp.defaults(A, r1) = '-' AND pg_temp.defaults(A, r2) = '23',
      s || ' r1=' || pg_temp.defaults(A, r1) || ' r2=' || pg_temp.defaults(A, r2)));

    -- ===== C9: an authenticated user with no internal role is refused =====
    r := r || jsonb_build_object('C9_non_internal_refused', pg_temp.chk(pg_temp.set_def(C, r1, NULL), 'ERR 42501%'));

    -- ===== C10: anon cannot execute either function =====
    r := r || jsonb_build_object('C10a_anon_set_denied', pg_temp.chk(
      pg_temp.call_as(NULL, format('SELECT public.report_set_default_view(%L, NULL)', r1), 'anon'), 'ERR 42501 permission denied%'));
    r := r || jsonb_build_object('C10b_anon_list_denied', pg_temp.chk(
      pg_temp.call_as(NULL, format('SELECT public.report_list_saved_views(%L)', r1), 'anon'), 'ERR 42501 permission denied%'));

    -- ===== C11: catalog — grants, SECURITY DEFINER, search_path; table TRUNCATE =====
    SELECT count(*) INTO n FROM pg_proc p
     WHERE p.oid IN (sd::regprocedure, sl::regprocedure,
                     'public.report_save_view(text,text,jsonb,jsonb,boolean,uuid)'::regprocedure,
                     'public.report_delete_saved_view(uuid)'::regprocedure)
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
       AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
    r := r || jsonb_build_object('C11_catalog', pg_temp.pass(
      n = 4
      AND NOT has_table_privilege('anon', 'public.report_saved_views', 'TRUNCATE')
      AND NOT has_table_privilege('authenticated', 'public.report_saved_views', 'TRUNCATE')
      AND NOT has_table_privilege('authenticated', 'public.report_saved_views', 'UPDATE'),
      n || ' of 4 functions compliant; set ' || pg_temp.acl(sd) || '; list ' || pg_temp.acl(sl)));

    -- ===== C12: re-applying the migration changes nothing =====
    d0 := md5(pg_temp.def(sd) || pg_temp.def(sl)); a0 := pg_temp.acl(sd) || pg_temp.acl(sl);
    BEGIN
      EXECUTE $mg$__MIGRATION__$mg$;
      s := CASE WHEN md5(pg_temp.def(sd) || pg_temp.def(sl)) = d0 AND pg_temp.acl(sd) || pg_temp.acl(sl) = a0
                 AND to_regclass('public.report_saved_views_one_default') IS NOT NULL
            THEN 'same' ELSE 'changed' END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    r := r || jsonb_build_object('C12_reapply_idempotent', pg_temp.chk(s, 'same'));

    -- ===== C13: the rollback restores the 3450 shape =====
    l0 := pg_temp.acl(sl);
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s2 := pg_temp.list(A, r1);
      s := CASE WHEN s2 NOT LIKE 'ERR%' AND position('is_default' IN s2) = 0 AND position('"pinned"' IN s2) > 0
                 AND to_regprocedure('public.report_set_default_view(text,uuid)') IS NULL
                 AND to_regclass('public.report_saved_views_one_default') IS NULL
                 AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                                  WHERE table_schema = 'public' AND table_name = 'report_saved_views' AND column_name = 'is_default')
                 AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261031180000')
                 AND pg_temp.acl(sl) = l0
            THEN 'restored' ELSE 'not restored: ' || left(s2, 60) || ' ' || pg_temp.acl(sl) END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    r := r || jsonb_build_object('C13_rollback_restores', pg_temp.pass(s = 'restored', s));

    RETURN r;
  END $b$$f$;

  FOREACH v_m IN ARRAY v_modes LOOP
    BEGIN
      v_mut := pg_temp.apply_mode(v_m);
      v_r := pg_temp.run();
      RAISE EXCEPTION 'MODE_DONE' USING DETAIL = (jsonb_build_object('mutation', v_mut, 'checks', v_r))::text;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'MODE_DONE' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        v_r := v_detail::jsonb;
        v_res := v_res || jsonb_build_object(v_m, jsonb_build_object(
          'mutation', v_r->'mutation',
          'pass', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value = 'PASS'),
          'fail', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS'),
          'reds', CASE WHEN v_m = 'base' THEN (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS')
                       ELSE (SELECT coalesce(jsonb_agg(e.key ORDER BY e.key), '[]'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS') END));
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300));
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P4084_RESULT %', v_res;
END
$drv$;
