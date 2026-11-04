-- BACKLOG-4086 DB controls (public.support_sla_settings: seed, RLS, grants, CHECKs, trigger, rollback).
-- Venue: keepr-test, ONE call, ONE transaction ending in RAISE, so nothing persists. Run with
-- compose.py --with-migration (the migration is applied TWICE in front: S5a idempotence), or after
-- 20261031000000 is applied.
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (its effect is checked; otherwise MUTATION NOT APPLIED), build
-- fixtures, run every check, roll back. 'base' = no mutation (every check must PASS).
-- Fixtures (SR R2): auth users p4086-*@example.test created INSIDE the transaction, one per role
-- shape: support-supervisor (holds support.admin), support-agent (support.manage only), marketing
-- (internal, no support permission), and one authenticated user with no internal role.
-- Output: RAISE 'P4086_RESULT {mode: {mutation, pass, fail, reds}}'.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- a statement as a role ('authenticated' with a user, or 'anon'): 'ok:<rows>' or 'ERR <sqlstate> ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.exec_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
      PERFORM set_config('request.jwt.claim.role', r, true);
      EXECUTE format('SET LOCAL ROLE %I', r);
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ok:' || n;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- a statement as the owner (postgres): 'ok:<rows>' or 'ERR <sqlstate> ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.exec_owner(q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    BEGIN
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      RAISE EXCEPTION 'UNDO' USING DETAIL = n::text;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'UNDO' THEN
        RETURN 'ok';
      END IF;
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || coalesce(detail, 'null') END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.perm(u uuid, k text) RETURNS boolean LANGUAGE sql AS $b$
    SELECT EXISTS (SELECT 1 FROM public.internal_roles ir
      JOIN public.admin_role_permissions arp ON arp.role_id = ir.role_id
      JOIN public.admin_permissions ap ON ap.id = arp.permission_id
      WHERE ir.user_id = u AND ap.key = k)
  $b$$f$;

  -- PASS when the actual result text matches the LIKE pattern
  EXECUTE $f$CREATE FUNCTION pg_temp.chk(actual text, pattern text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN actual LIKE pattern THEN 'PASS' ELSE 'FAIL ' || coalesce(actual, 'null') END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.policy_text() RETURNS text LANGUAGE sql AS $b$
    SELECT string_agg(policyname || ':' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ' ; ' ORDER BY policyname)
      FROM pg_policies WHERE schemaname = 'public' AND tablename = 'support_sla_settings'
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE before text; after text; n int;
  BEGIN
    IF m = 'base' THEN RETURN 'none'; END IF;
    before := pg_temp.policy_text();
    IF m = 'm_no_admin_filter' THEN
      -- the update policy keeps the internal-role test but drops the support.admin permission
      ALTER POLICY support_sla_settings_update_admin ON public.support_sla_settings
        USING (EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid())))
        WITH CHECK (EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid())));
      after := pg_temp.policy_text();
      IF after = before OR after LIKE '%support.admin%' THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED update policy without support.admin [' || left(after, 160) || ']';
    ELSIF m = 'm_select_open' THEN
      ALTER POLICY support_sla_settings_select_internal ON public.support_sla_settings USING (true);
      after := pg_temp.policy_text();
      IF after = before THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED select policy USING (true)';
    ELSIF m = 'm_no_seed' THEN
      DELETE FROM public.support_sla_settings;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % rows deleted', n; END IF;
      RETURN 'MUTATION APPLIED seed row deleted (1)';
    ELSIF m = 'm_no_trigger' THEN
      DROP TRIGGER support_sla_settings_touch ON public.support_sla_settings;
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'support_sla_settings_touch') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED trigger dropped';
    ELSIF m = 'm_grant_insert' THEN
      GRANT INSERT, DELETE ON public.support_sla_settings TO authenticated;
      IF NOT has_table_privilege('authenticated', 'public.support_sla_settings', 'INSERT') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED GRANT INSERT, DELETE TO authenticated';
    ELSIF m = 'm_no_window_check' THEN
      ALTER TABLE public.support_sla_settings DROP CONSTRAINT support_sla_settings_window_ck;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_sla_settings_window_ck') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED window CHECK dropped';
    END IF;
    RAISE EXCEPTION 'unknown mode %', m;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    u_sup uuid := gen_random_uuid(); u_agent uuid := gen_random_uuid();
    u_mkt uuid := gen_random_uuid(); u_out uuid := gen_random_uuid();
    s text; s2 text; n int; rec record;
  BEGIN
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4086-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sup, u_agent, u_mkt, u_out]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P4086 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sup, u_agent, u_mkt, u_out]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_sup, ar.id FROM public.admin_roles ar WHERE ar.slug = 'support-supervisor';
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_agent, ar.id FROM public.admin_roles ar WHERE ar.slug = 'support-agent';
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_mkt, ar.id FROM public.admin_roles ar WHERE ar.slug = 'marketing';

    -- ===== S0: the fixtures are what they claim (a null sub makes S2/S3 vacuous) =====
    SELECT count(*) INTO n FROM public.internal_roles ir WHERE ir.user_id IN (u_sup, u_agent, u_mkt);
    r := r || jsonb_build_object('S0a_fixture_users_seeded', pg_temp.pass(
      n = 3 AND u_sup IS NOT NULL AND u_agent IS NOT NULL AND u_mkt IS NOT NULL AND u_out IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = u_out),
      'internal rows ' || n || ' sup=' || coalesce(u_sup::text, 'null')));
    -- (has_permission() only answers for the caller, so the permission join is read directly)
    r := r || jsonb_build_object('S0b_permissions_as_named', pg_temp.pass(
      pg_temp.perm(u_sup, 'support.admin')
      AND NOT pg_temp.perm(u_agent, 'support.admin') AND pg_temp.perm(u_agent, 'support.manage')
      AND NOT pg_temp.perm(u_mkt, 'support.admin') AND NOT pg_temp.perm(u_mkt, 'support.manage'),
      'permission mismatch'));

    -- ===== S1: the seed row holds the six defaults =====
    SELECT count(*) INTO n FROM public.support_sla_settings;
    SELECT * INTO rec FROM public.support_sla_settings WHERE id = 1;
    r := r || jsonb_build_object('S1_seed_defaults', pg_temp.pass(
      n = 1 AND rec.first_response_target_minutes = 480 AND rec.resolution_target_business_days = 3
      AND rec.business_day_start_minute = 540 AND rec.business_day_end_minute = 1020
      AND rec.business_days = '{1,2,3,4,5}'::smallint[] AND rec.time_zone = 'America/Los_Angeles',
      'rows ' || n));

    -- ===== S2: who can read =====
    r := r || jsonb_build_object('S2a_agent_reads_1', pg_temp.chk(
      pg_temp.exec_as(u_agent, 'SELECT * FROM public.support_sla_settings'), 'ok:1'));
    r := r || jsonb_build_object('S2b_marketing_reads_1', pg_temp.chk(
      pg_temp.exec_as(u_mkt, 'SELECT * FROM public.support_sla_settings'), 'ok:1'));
    r := r || jsonb_build_object('S2c_supervisor_reads_1', pg_temp.chk(
      pg_temp.exec_as(u_sup, 'SELECT * FROM public.support_sla_settings'), 'ok:1'));
    r := r || jsonb_build_object('S2d_non_internal_reads_0', pg_temp.chk(
      pg_temp.exec_as(u_out, 'SELECT * FROM public.support_sla_settings'), 'ok:0'));
    r := r || jsonb_build_object('S2e_anon_denied', pg_temp.chk(
      pg_temp.exec_as(NULL, 'SELECT * FROM public.support_sla_settings', 'anon'), 'ERR 42501%'));

    -- ===== S3: who can write =====
    r := r || jsonb_build_object('S3a_agent_updates_0', pg_temp.chk(
      pg_temp.exec_as(u_agent, 'UPDATE public.support_sla_settings SET first_response_target_minutes = 61'), 'ok:0'));
    r := r || jsonb_build_object('S3b_marketing_updates_0', pg_temp.chk(
      pg_temp.exec_as(u_mkt, 'UPDATE public.support_sla_settings SET first_response_target_minutes = 62'), 'ok:0'));
    r := r || jsonb_build_object('S3c_non_internal_updates_0', pg_temp.chk(
      pg_temp.exec_as(u_out, 'UPDATE public.support_sla_settings SET first_response_target_minutes = 63'), 'ok:0'));
    r := r || jsonb_build_object('S3d_anon_update_denied', pg_temp.chk(
      pg_temp.exec_as(NULL, 'UPDATE public.support_sla_settings SET first_response_target_minutes = 64', 'anon'), 'ERR 42501%'));
    r := r || jsonb_build_object('S3e_insert_denied', pg_temp.chk(
      pg_temp.exec_as(u_sup, 'INSERT INTO public.support_sla_settings (id) VALUES (1) ON CONFLICT DO NOTHING'), 'ERR 42501%'));
    r := r || jsonb_build_object('S3e_delete_denied', pg_temp.chk(
      pg_temp.exec_as(u_sup, 'DELETE FROM public.support_sla_settings'), 'ERR 42501%'));
    r := r || jsonb_build_object('S3e_truncate_anon_select_not_granted', pg_temp.pass(
      NOT has_table_privilege('authenticated', 'public.support_sla_settings', 'TRUNCATE')
      AND NOT has_table_privilege('anon', 'public.support_sla_settings', 'SELECT'), 'privilege held'));
    SELECT first_response_target_minutes INTO n FROM public.support_sla_settings WHERE id = 1;
    r := r || jsonb_build_object('S3f_denied_updates_left_no_trace', pg_temp.pass(n = 480, 'target now ' || coalesce(n::text, 'null')));
    -- the supervisor changes the target to 60, trying to spoof the audit columns
    s := pg_temp.exec_as(u_sup, format(
      'UPDATE public.support_sla_settings SET first_response_target_minutes = 60, updated_at = %L, updated_by = %L',
      '2000-01-01T00:00:00Z', u_out));
    SELECT * INTO rec FROM public.support_sla_settings WHERE id = 1;
    r := r || jsonb_build_object('S3g_supervisor_updates_1', pg_temp.pass(
      s = 'ok:1' AND rec.first_response_target_minutes = 60, s || ' target ' || coalesce(rec.first_response_target_minutes::text, 'null')));
    -- R7: the trigger maintains updated_at / updated_by; the client cannot set them
    r := r || jsonb_build_object('S3h_trigger_sets_audit_columns', pg_temp.pass(
      rec.updated_by = u_sup AND rec.updated_at > '2000-01-02'::timestamptz,
      'updated_by ' || coalesce(rec.updated_by::text, 'null') || ' at ' || coalesce(rec.updated_at::text, 'null')));
    r := r || jsonb_build_object('S3i_trigger_fn_not_callable', pg_temp.pass(
      NOT has_function_privilege('anon', 'public.support_sla_settings_touch()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.support_sla_settings_touch()', 'EXECUTE'), 'execute held'));

    -- ===== S4: CHECKs reject bad values (as the owner, so RLS is not what stops them) =====
    r := r || jsonb_build_object('S4a_end_le_start', pg_temp.chk(
      pg_temp.exec_owner('UPDATE public.support_sla_settings SET business_day_end_minute = 540'), 'ERR 23514%'));
    r := r || jsonb_build_object('S4b_target_zero', pg_temp.chk(
      pg_temp.exec_owner('UPDATE public.support_sla_settings SET first_response_target_minutes = 0'), 'ERR 23514%'));
    r := r || jsonb_build_object('S4c_days_zero', pg_temp.chk(
      pg_temp.exec_owner('UPDATE public.support_sla_settings SET resolution_target_business_days = 0'), 'ERR 23514%'));
    r := r || jsonb_build_object('S4d_second_row', pg_temp.chk(
      pg_temp.exec_owner('INSERT INTO public.support_sla_settings (id) VALUES (2)'), 'ERR 23514%'));
    r := r || jsonb_build_object('S4e_weekday_7', pg_temp.chk(
      pg_temp.exec_owner($q$UPDATE public.support_sla_settings SET business_days = '{7}'$q$), 'ERR 23514%'));
    r := r || jsonb_build_object('S4f_no_weekdays', pg_temp.chk(
      pg_temp.exec_owner($q$UPDATE public.support_sla_settings SET business_days = '{}'$q$), 'ERR 23514%'));
    r := r || jsonb_build_object('S4g_valid_update_ok', pg_temp.chk(
      pg_temp.exec_owner('UPDATE public.support_sla_settings SET business_day_end_minute = 1080'), 'ok'));

    -- ===== S5: idempotent (applied twice in front) and the rollback removes everything =====
    r := r || jsonb_build_object('S5a_applied_twice_one_row', pg_temp.pass(
      (SELECT count(*) FROM public.support_sla_settings) = 1
      AND (SELECT count(*) FROM pg_policies WHERE tablename = 'support_sla_settings') = 2
      AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'support_sla_settings_touch') = 1, 'objects'));
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s := CASE WHEN to_regclass('public.support_sla_settings') IS NULL
                 AND to_regprocedure('public.support_sla_settings_touch()') IS NULL
                 AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261031000000')
            THEN 'gone' ELSE 'left' END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN
        GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE
        s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
      END IF;
    END;
    r := r || jsonb_build_object('S5b_rollback_removes_all', pg_temp.pass(
      s = 'gone' AND to_regclass('public.support_sla_settings') IS NOT NULL, s));

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
  RAISE EXCEPTION 'P4086_RESULT %', v_res;
END
$drv$;
