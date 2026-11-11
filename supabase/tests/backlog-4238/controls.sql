-- BACKLOG-4238 PR-1 controls (single session). compose.py places this after the rollback, the
-- migration applied twice, and lib/helpers.sql; the call ends in RAISE, so nothing persists.
-- Each control runs in its own subtransaction that is undone at its end.
-- Fixtures (all invented): users fx(1) A, fx(2) B (same organization as A, role broker),
-- fx(3) admin with an impersonation session in progress, fx(4) plain user; one organization;
-- a stub table public.cloud_p4238_state and a stub public.get_my_cloud_autosave_state() returning
-- the BACKLOG-4236 state v1 shape; a writer function public.p4238_writer() granted to authenticated.

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $run$
DECLARE
  r  jsonb := '{}'::jsonb;
  A  uuid := pg_temp.fx(1);
  B  uuid := pg_temp.fx(2);
  ADM uuid := pg_temp.fx(3);
  P  uuid := pg_temp.fx(4);
  ORG uuid := pg_temp.fx(100);
  s  text; t text; t2 text; t3 text; c jsonb; c2 jsonb; c3 jsonb;
  n0 bigint; n1 bigint; k0 bigint; k1 bigint; n int; ok boolean;
  ANON_FNS text[] := ARRAY['public.mcp_register_client(text,text,text,text[],bytea)',
    'public.mcp_authorize_begin(text,text,text,text,text,text,text,text,bytea,bytea)',
    'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)',
    'public.mcp_refresh(text,bytea,text,text,bytea,bytea)',
    'public.mcp_check_access(text,bytea,text)', 'public.mcp_get_status(text,bytea,text)'];
  AUTH_FNS text[] := ARRAY['public.mcp_authorize_view(text,bytea)', 'public.mcp_authorize_approve(text,bytea,text,bytea)',
    'public.mcp_authorize_deny(text,bytea,text)', 'public.mcp_list_my_connections()',
    'public.mcp_disconnect(uuid)', 'public.mcp_disconnect_all_mine()'];
BEGIN
  -- ===== state of a fresh apply, before any fixture =====
  r := r || jsonb_build_object('D12_fresh_apply_disabled_no_secret', pg_temp.pass(
    (SELECT enabled = false AND portal_secret_sha256 IS NULL AND portal_secret_prev_sha256 IS NULL AND connect_requires_cloud
       FROM public.mcp_settings WHERE id)
    AND (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_settings' AND column_name = 'enabled') = 'false',
    (SELECT row_to_json(x)::text FROM (SELECT enabled, portal_secret_sha256 IS NULL AS no_secret FROM public.mcp_settings) x)));
  r := r || jsonb_build_object('SEED_allowlist_exact', pg_temp.pass(
    (SELECT array_agg(redirect_uri || '|' || provider ORDER BY redirect_uri) FROM public.mcp_redirect_allowlist)
      = ARRAY['https://chatgpt.com/connector_platform_oauth_redirect|openai', 'https://claude.ai/api/mcp/auth_callback|anthropic'],
    (SELECT string_agg(redirect_uri, ',') FROM public.mcp_redirect_allowlist)));
  r := r || jsonb_build_object('PRE_no_state_function', pg_temp.pass(to_regprocedure('public.get_my_cloud_autosave_state()') IS NULL, 'exists'));

  -- ===== D2: grants, RLS, role =====
  r := r || jsonb_build_object('D2_function_grants', pg_temp.pass(
    (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_') = 25
    AND NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_'
         AND (has_function_privilege('anon', p.oid, 'EXECUTE') IS DISTINCT FROM (p.oid = ANY (ANON_FNS::regprocedure[]::oid[]))
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE') IS DISTINCT FROM (p.oid = ANY (AUTH_FNS::regprocedure[]::oid[]))
           OR has_function_privilege('service_role', p.oid, 'EXECUTE')
           OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))),
    (SELECT string_agg(p.oid::regprocedure::text || ' anon=' || has_function_privilege('anon', p.oid, 'EXECUTE')
                       || ' auth=' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                       || ' svc=' || has_function_privilege('service_role', p.oid, 'EXECUTE'), '; ')
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_'
        AND (has_function_privilege('anon', p.oid, 'EXECUTE') IS DISTINCT FROM (p.oid = ANY (ANON_FNS::regprocedure[]::oid[]))
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE') IS DISTINCT FROM (p.oid = ANY (AUTH_FNS::regprocedure[]::oid[]))
          OR has_function_privilege('service_role', p.oid, 'EXECUTE')
          OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)))
    || ' count=' || (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_')));
  r := r || jsonb_build_object('D2_tables_closed', pg_temp.pass(
    (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'mcp\_%') = 9
    AND NOT EXISTS (SELECT 1 FROM pg_class c CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'mcp_reader']) ro(x)
                     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr(y)
                     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'mcp\_%'
                       AND has_table_privilege(ro.x, c.oid, pr.y))
    AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'mcp\_%' AND NOT c.relrowsecurity)
    AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'mcp\_%'),
    (SELECT string_agg(c.relname || ':' || ro.x || ':' || pr.y, ',') FROM pg_class c CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'mcp_reader']) ro(x)
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr(y)
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'mcp\_%' AND has_table_privilege(ro.x, c.oid, pr.y))));
  r := r || jsonb_build_object('D2_reader_role', pg_temp.pass(
    (SELECT NOT rolbypassrls AND NOT rolcanlogin AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolsuper AND rolinherit FROM pg_roles WHERE rolname = 'mcp_reader')
    AND pg_has_role('mcp_reader', 'authenticated', 'MEMBER')
    AND NOT has_schema_privilege('mcp_reader', 'public', 'CREATE')
    AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'mcp_reader'::regrole AND m.member = 'postgres'::regrole
                  AND NOT m.inherit_option AND m.set_option)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'mcp_reader'::regrole AND m.member = 'postgres'::regrole AND m.inherit_option)
    AND (SELECT array_agg(p.oid::regprocedure::text || ':' || p.provolatile::text || ':' || p.prosecdef) FROM pg_proc p WHERE p.proowner = 'mcp_reader'::regrole)
        = ARRAY['_mcp_r_entitlement():s:true']
    AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname LIKE '\_mcp\_r\_%' AND p.proowner IS DISTINCT FROM 'mcp_reader'::regrole),
    (SELECT row_to_json(x)::text FROM (SELECT rolbypassrls, rolcanlogin, rolinherit,
        has_schema_privilege('mcp_reader', 'public', 'CREATE') AS create_public,
        (SELECT string_agg(m.inherit_option || '/' || m.set_option, ',') FROM pg_auth_members m WHERE m.roleid = 'mcp_reader'::regrole AND m.member = 'postgres'::regrole) AS pg_member,
        (SELECT string_agg(p.oid::regprocedure::text || ':' || p.provolatile::text, ',') FROM pg_proc p WHERE p.proowner = 'mcp_reader'::regrole) AS owned
       FROM pg_roles WHERE rolname = 'mcp_reader') x)));
  r := r || jsonb_build_object('D2_anon_and_signed_in_cannot_call_internal', pg_temp.pass(
    pg_temp.call_as(NULL, 'SELECT to_jsonb(public._mcp_secret_ok(''x''))', 'anon') LIKE 'ERR 42501%'
    AND pg_temp.call_as(pg_temp.fx(4), format('SELECT to_jsonb(public._mcp_disconnect_all_for(%L, %L))', pg_temp.fx(4), 'disconnect_all')) LIKE 'ERR 42501%'
    AND pg_temp.call_as(NULL, 'SELECT public._mcp_r_entitlement()', 'anon') LIKE 'ERR 42501%',
    'internal callable'));

  -- ===== base fixtures =====
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4238-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 4) x;
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.organizations (id, name, slug) VALUES (ORG, 'P4238 Fixture Org', 'p4238-fixture-org');
  INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (ORG, A, 'agent'), (ORG, B, 'broker');
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.impersonation_sessions (admin_user_id, target_user_id, token, status, expires_at, session_expires_at)
  VALUES (ADM, A, 'p4238fixturetoken', 'validated', now() + interval '60 seconds', now() + interval '30 minutes');
  UPDATE public.mcp_settings SET enabled = true, connect_requires_cloud = false,
         portal_secret_sha256 = sha256(convert_to(pg_temp.sec(), 'UTF8')) WHERE id;

  -- ===== D15a: no state function yet =====
  BEGIN
    c := pg_temp.connect(A, 'd15a');
    t := pg_temp.st('at-d15a');
    r := r || jsonb_build_object('D15a_cloud_not_built', pg_temp.pass(
      (c ->> 'ok')::boolean AND pg_temp.j(t) -> 'result' ->> 'reason' = 'cloud_not_built'
      AND (pg_temp.j(t) -> 'result' -> 'entitled') = 'false'::jsonb AND pg_temp.j(t) ->> 'ok' = 'true',
      c::text || ' / ' || t));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D15a_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== stub of the BACKLOG-4236 state function (v1 shape) =====
  EXECUTE $s$CREATE TABLE public.cloud_p4238_state (owner uuid PRIMARY KEY, entitled boolean NOT NULL, schema_version int NOT NULL DEFAULT 1, mode text NOT NULL DEFAULT 'ok')$s$;
  EXECUTE $s$ALTER TABLE public.cloud_p4238_state ENABLE ROW LEVEL SECURITY$s$;
  EXECUTE $s$CREATE POLICY p4238_own ON public.cloud_p4238_state FOR SELECT TO authenticated USING (owner = (SELECT auth.uid()))$s$;
  EXECUTE $s$REVOKE ALL ON public.cloud_p4238_state FROM anon, authenticated$s$;
  EXECUTE $s$GRANT SELECT ON public.cloud_p4238_state TO authenticated$s$;
  EXECUTE $s$CREATE TABLE public.p4238_written (v text)$s$;
  EXECUTE $s$REVOKE ALL ON public.p4238_written FROM anon, authenticated$s$;
  EXECUTE $s$CREATE SEQUENCE public.p4238_seq$s$;
  EXECUTE $s$GRANT USAGE ON SEQUENCE public.p4238_seq TO authenticated$s$;
  EXECUTE $s$CREATE FUNCTION public.p4238_writer() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $w$
    BEGIN INSERT INTO public.p4238_written VALUES (coalesce(auth.uid()::text, 'null')); END $w$$s$;
  EXECUTE $s$REVOKE ALL ON FUNCTION public.p4238_writer() FROM PUBLIC, anon, authenticated, service_role$s$;
  EXECUTE $s$GRANT EXECUTE ON FUNCTION public.p4238_writer() TO authenticated$s$;
  EXECUTE $s$CREATE FUNCTION public.get_my_cloud_autosave_state() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $g$
    DECLARE x public.cloud_p4238_state%ROWTYPE;
    BEGIN
      SELECT * INTO x FROM public.cloud_p4238_state ORDER BY entitled DESC LIMIT 1;  -- ownership from row rules only
      IF x.mode = 'write' THEN PERFORM public.p4238_writer(); END IF;
      IF x.mode = 'ro_off' THEN PERFORM set_config('transaction_read_only', 'off', true); INSERT INTO public.p4238_written VALUES ('ro_off'); END IF;
      IF x.mode = 'nextval' THEN PERFORM nextval('public.p4238_seq'); END IF;
      IF x.mode = 'raise' THEN RAISE EXCEPTION 'stub failure'; END IF;
      IF x.mode = 'sleep' THEN PERFORM pg_sleep(3); END IF;
      RETURN jsonb_build_object('schema_version', coalesce(x.schema_version, 1), 'user_id', auth.uid(), 'licensed', coalesce(x.entitled, false),
        'entitled', coalesce(x.entitled, false), 'path', 'solo', 'organization_id', NULL,
        'reason', CASE WHEN coalesce(x.entitled, false) THEN NULL ELSE 'no_license' END,
        'settings', jsonb_build_object('enabled', coalesce(x.entitled, false), 'notice_version', 1, 'accepted_at', NULL),
        'current_notice_version', 1, 'storage', jsonb_build_object('used_bytes', 0, 'quota_bytes', NULL));
    END $g$$s$;
  EXECUTE $s$REVOKE ALL ON FUNCTION public.get_my_cloud_autosave_state() FROM PUBLIC, anon, authenticated, service_role$s$;
  EXECUTE $s$GRANT EXECUTE ON FUNCTION public.get_my_cloud_autosave_state() TO authenticated$s$;
  INSERT INTO public.cloud_p4238_state (owner, entitled) VALUES (A, true), (B, false);

  -- ===== D1: portal secret, with a VALID access digest =====
  BEGIN
    c := pg_temp.connect(A, 'd1');
    t := pg_temp.st('at-d1');
    ok := (c ->> 'ok')::boolean AND pg_temp.j(t) ->> 'ok' = 'true';
    r := r || jsonb_build_object('D1_positive_correct_secret', pg_temp.pass(ok, c::text || ' / ' || t));
    -- case 1: wrong secret, previous hash NULL
    n0 := pg_temp.nlog(); k0 := pg_temp.nctr();
    t := pg_temp.st('at-d1', 'wrong-secret');
    t2 := pg_temp.chk('at-d1', 'wrong-secret');
    t3 := pg_temp.exch('c-x', pg_temp.ver(), 'd1', pg_temp.claude(), 'at-x', 'rt-x', pg_temp.res(), 'wrong-secret')
       || pg_temp.refr('rt-d1', 'd1', 'at-y', 'rt-y', pg_temp.res(), 'wrong-secret');
    r := r || jsonb_build_object('D1_wrong_secret_prev_null', pg_temp.pass(
      pg_temp.j(t) = '{"ok": false, "error": "not_connected"}'::jsonb
      AND pg_temp.j(t2) = '{"ok": false, "error": "not_connected"}'::jsonb
      AND t3 = '{"ok": false, "error": "invalid_grant"}{"ok": false, "error": "invalid_grant"}'
      AND pg_temp.err(pg_temp.reg('d1w', ARRAY[pg_temp.claude()], 'ip-d1w', 'wrong-secret')) = 'invalid_client_metadata'
      AND pg_temp.j(pg_temp.beg('d1', pg_temp.claude(), 'b-d1w', s => 'wrong-secret')) = '{"ok": false, "error": "invalid_client", "show": "page"}'::jsonb
      AND pg_temp.nlog() = n0 AND pg_temp.nctr() = k0,
      t || ' ' || t2 || ' ' || t3 || ' log ' || n0 || '->' || pg_temp.nlog() || ' ctr ' || k0 || '->' || pg_temp.nctr()));
    -- case 2: wrong secret, previous hash set
    UPDATE public.mcp_settings SET portal_secret_prev_sha256 = sha256(convert_to('p4238-secret-previous', 'UTF8')) WHERE id;
    n0 := pg_temp.nlog(); k0 := pg_temp.nctr();
    t := pg_temp.st('at-d1', 'wrong-secret');
    r := r || jsonb_build_object('D1_wrong_secret_prev_set', pg_temp.pass(
      pg_temp.j(t) = '{"ok": false, "error": "not_connected"}'::jsonb AND pg_temp.nlog() = n0 AND pg_temp.nctr() = k0, t));
    -- case 3: previous secret accepted during rotation
    t := pg_temp.st('at-d1', 'p4238-secret-previous');
    r := r || jsonb_build_object('D1_prev_secret_accepted', pg_temp.pass(pg_temp.j(t) ->> 'ok' = 'true', t));
    UPDATE public.mcp_settings SET portal_secret_prev_sha256 = NULL WHERE id;
    -- case 4: NULL secret
    n0 := pg_temp.nlog(); k0 := pg_temp.nctr();
    t := pg_temp.call_as(NULL, format('SELECT public.mcp_get_status(NULL, %s, %L)', pg_temp.hx(pg_temp.dg('at-d1')), pg_temp.res()), 'anon');
    r := r || jsonb_build_object('D1_null_secret', pg_temp.pass(
      pg_temp.j(t) = '{"ok": false, "error": "not_connected"}'::jsonb AND pg_temp.nlog() = n0 AND pg_temp.nctr() = k0, t));
    -- case 5: settings row deleted
    BEGIN
      DELETE FROM public.mcp_settings;
      n0 := pg_temp.nlog(); k0 := pg_temp.nctr();
      t := pg_temp.st('at-d1') || pg_temp.reg('d1s', ARRAY[pg_temp.claude()], 'ip-d1s');
      ok := t = '{"ok": false, "error": "not_connected"}{"ok": false, "error": "invalid_client_metadata"}' AND pg_temp.nlog() = n0 AND pg_temp.nctr() = k0;
      RAISE EXCEPTION USING ERRCODE = 'T4239';
    EXCEPTION WHEN SQLSTATE 'T4239' THEN NULL;
    END;
    r := r || jsonb_build_object('D1_settings_row_missing', pg_temp.pass(ok, t));
    -- case 6: current hash NULL
    UPDATE public.mcp_settings SET portal_secret_sha256 = NULL WHERE id;
    n0 := pg_temp.nlog(); k0 := pg_temp.nctr();
    t := pg_temp.st('at-d1');
    r := r || jsonb_build_object('D1_current_hash_null', pg_temp.pass(
      pg_temp.j(t) = '{"ok": false, "error": "not_connected"}'::jsonb AND pg_temp.nlog() = n0 AND pg_temp.nctr() = k0, t));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D3: the reader cannot write =====
  BEGIN
    c := pg_temp.connect(A, 'd3');
    UPDATE public.cloud_p4238_state SET mode = 'write' WHERE owner = A;
    t := pg_temp.st('at-d3');
    UPDATE public.cloud_p4238_state SET mode = 'ro_off' WHERE owner = A;
    t2 := pg_temp.st('at-d3');
    UPDATE public.cloud_p4238_state SET mode = 'nextval' WHERE owner = A;
    t3 := pg_temp.st('at-d3');
    r := r || jsonb_build_object('D3_writes_refused', pg_temp.pass(
      (c ->> 'ok')::boolean
      AND pg_temp.j(t) -> 'result' ->> 'reason' = 'state_unavailable'
      AND pg_temp.j(t2) -> 'result' ->> 'reason' = 'state_unavailable'
      AND pg_temp.j(t3) -> 'result' ->> 'reason' = 'state_unavailable'
      AND (SELECT count(*) FROM public.p4238_written) = 0
      AND (SELECT count(*) FROM public.mcp_call_log l WHERE l.user_id = A AND l.event = 'call' AND l.outcome = 'ok') = 3,
      t || ' / ' || t2 || ' / ' || t3 || ' written=' || (SELECT count(*) FROM public.p4238_written)));
    UPDATE public.cloud_p4238_state SET mode = 'ok' WHERE owner = A;
    t := pg_temp.st('at-d3');
    r := r || jsonb_build_object('D3_positive_clean_reader', pg_temp.pass((pg_temp.j(t) -> 'result' -> 'entitled') = 'true'::jsonb, t));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D3_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== claims and read-only restored after the wrapper returns =====
  BEGIN
    c := pg_temp.connect(A, 'cl');
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    EXECUTE 'SET LOCAL ROLE anon';
    t := public.mcp_get_status(pg_temp.sec(), pg_temp.dg('at-cl'), pg_temp.res())::text;
    t2 := coalesce(current_setting('request.jwt.claims', true), 'null') || '|' || coalesce(current_setting('request.jwt.claim.sub', true), 'null')
          || '|' || current_setting('transaction_read_only');
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    r := r || jsonb_build_object('CL_claims_and_read_only_restored', pg_temp.pass(
      pg_temp.j(t) ->> 'ok' = 'true' AND t2 = '{"role":"anon"}||off', t || ' after=' || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('CL_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D4: dispatch refuses a reader that is not STABLE or not owned by mcp_reader =====
  BEGIN
    c := pg_temp.connect(A, 'd4');
    t := pg_temp.st('at-d4');
    BEGIN
      EXECUTE 'SET ROLE mcp_reader';
      EXECUTE 'ALTER FUNCTION public._mcp_r_entitlement() VOLATILE';
      EXECUTE 'RESET ROLE';
      n0 := pg_temp.nlog();
      t2 := pg_temp.st('at-d4');
      n1 := (SELECT count(*) FROM public.mcp_call_log l WHERE l.user_id = A AND l.outcome = 'error');
      RAISE EXCEPTION USING ERRCODE = 'T4239';
    EXCEPTION WHEN SQLSTATE 'T4239' THEN NULL;
    END;
    BEGIN
      EXECUTE 'GRANT mcp_reader TO postgres WITH INHERIT TRUE';
      EXECUTE 'ALTER FUNCTION public._mcp_r_entitlement() OWNER TO postgres';
      t3 := pg_temp.st('at-d4');
      RAISE EXCEPTION USING ERRCODE = 'T4239';
    EXCEPTION WHEN SQLSTATE 'T4239' THEN NULL;
    END;
    r := r || jsonb_build_object('D4_dispatch_check', pg_temp.pass(
      pg_temp.j(t) ->> 'ok' = 'true'
      AND pg_temp.j(t2) = '{"ok": false, "error": "error"}'::jsonb AND n1 = 1
      AND pg_temp.j(t3) = '{"ok": false, "error": "error"}'::jsonb,
      t || ' / volatile=' || t2 || ' errlog=' || n1 || ' / postgres-owned=' || t3));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('D4_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D5: the reader reads as the token's owner under row rules =====
  BEGIN
    c := pg_temp.connect(A, 'd5a');
    c2 := pg_temp.connect(B, 'd5b');
    t := pg_temp.st('at-d5a');
    t2 := pg_temp.st('at-d5b');
    r := r || jsonb_build_object('D5_owner_only', pg_temp.pass(
      (c ->> 'ok')::boolean AND (c2 ->> 'ok')::boolean
      AND (pg_temp.j(t) -> 'result' -> 'entitled') = 'true'::jsonb
      AND (pg_temp.j(t2) -> 'result' -> 'entitled') = 'false'::jsonb
      AND pg_temp.j(t2) -> 'result' ->> 'reason' = 'no_license',
      t || ' / ' || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D5_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D6: token resolution =====
  BEGIN
    c := pg_temp.connect(A, 'd6');
    t := pg_temp.st('at-d6');
    s := 'fresh=' || pg_temp.err(t);
    ok := pg_temp.err(t) = 'OK' AND pg_temp.err(pg_temp.chk('at-d6')) = 'OK';
    BEGIN
      UPDATE public.mcp_tokens SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE token_sha256 = sha256(pg_temp.dg('at-d6'));
      t := pg_temp.st('at-d6'); t2 := pg_temp.chk('at-d6');
      ok := ok AND pg_temp.err(t) = 'not_connected' AND pg_temp.err(t2) = 'not_connected'; s := s || ' expired=' || pg_temp.err(t) || '/' || pg_temp.err(t2);
      RAISE EXCEPTION USING ERRCODE = 'T4239';
    EXCEPTION WHEN SQLSTATE 'T4239' THEN NULL; END;
    t := pg_temp.st('rt-d6'); ok := ok AND pg_temp.err(t) = 'not_connected'; s := s || ' refresh_as_access=' || pg_temp.err(t);
    t := pg_temp.st('at-d6', resource => 'https://other.example.test/api/mcp'); ok := ok AND pg_temp.err(t) = 'not_connected'; s := s || ' other_resource=' || pg_temp.err(t);
    BEGIN
      UPDATE public.mcp_settings SET pepper_version = 2 WHERE id;
      t := pg_temp.st('at-d6'); ok := ok AND pg_temp.err(t) = 'not_connected'; s := s || ' pepper=' || pg_temp.err(t);
      RAISE EXCEPTION USING ERRCODE = 'T4239';
    EXCEPTION WHEN SQLSTATE 'T4239' THEN NULL; END;
    BEGIN
      UPDATE public.mcp_connections SET status = 'pending', activated_at = NULL WHERE id = (c ->> 'conn')::uuid;
      t := pg_temp.st('at-d6'); ok := ok AND pg_temp.err(t) = 'not_connected'; s := s || ' pending=' || pg_temp.err(t);
      RAISE EXCEPTION USING ERRCODE = 'T4239';
    EXCEPTION WHEN SQLSTATE 'T4239' THEN NULL; END;
    BEGIN
      INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at)
      VALUES (sha256(pg_temp.dg('short')), (c ->> 'conn')::uuid, 'access', 1, now() + interval '299 seconds');
      s := s || ' short_token=inserted'; ok := false;
    EXCEPTION WHEN check_violation THEN s := s || ' short_token=refused'; END;
    t := pg_temp.st('at-d6'); ok := ok AND pg_temp.err(t) = 'OK'; s := s || ' again=' || pg_temp.err(t);
    r := r || jsonb_build_object('D6_token_resolution', pg_temp.pass(ok, s));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D6_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D7: a code works once; a replay disconnects =====
  BEGIN
    c := pg_temp.connect(A, 'd7');
    t := pg_temp.exch('c-d7', pg_temp.ver(), 'd7', pg_temp.claude(), 'at-d7b', 'rt-d7b');
    r := r || jsonb_build_object('D7_code_single_use', pg_temp.pass(
      (c ->> 'ok')::boolean AND pg_temp.err(t) = 'invalid_grant'
      AND NOT EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c ->> 'conn')::uuid)
      AND (SELECT count(*) FROM public.mcp_call_log WHERE user_id = A AND event = 'code_replay') = 1
      AND pg_temp.err(pg_temp.st('at-d7')) = 'not_connected',
      c ->> 'exch' || ' / second=' || t || ' conn_left=' || (SELECT count(*) FROM public.mcp_connections WHERE id = (c ->> 'conn')::uuid)));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D7_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D8: PKCE and bindings at exchange =====
  BEGIN
    s := '';
    c := pg_temp.to_code(A, 'd8a');
    t := pg_temp.exch('c-d8a', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXl', 'd8a', pg_temp.claude(), 'at-d8a', 'rt-d8a'); s := s || 'wrong_verifier=' || pg_temp.err(t);
    ok := pg_temp.err(t) = 'invalid_grant';
    c := pg_temp.to_code(A, 'd8b');
    t := pg_temp.exch('c-d8b', pg_temp.chal(), 'd8b', pg_temp.claude(), 'at-d8b', 'rt-d8b'); s := s || ' verifier_eq_challenge=' || pg_temp.err(t);
    ok := ok AND pg_temp.err(t) = 'invalid_grant';
    c := pg_temp.to_code(A, 'd8c');
    t := pg_temp.exch('c-d8c', pg_temp.ver(), 'd8c', pg_temp.gpt(), 'at-d8c', 'rt-d8c'); s := s || ' other_redirect=' || pg_temp.err(t);
    ok := ok AND pg_temp.err(t) = 'invalid_grant';
    c := pg_temp.to_code(A, 'd8d');
    PERFORM pg_temp.reg('d8z', ARRAY[pg_temp.claude()], 'ipr-d8z');
    t := pg_temp.exch('c-d8d', pg_temp.ver(), 'd8z', pg_temp.claude(), 'at-d8d', 'rt-d8d'); s := s || ' other_client=' || pg_temp.err(t);
    ok := ok AND pg_temp.err(t) = 'invalid_grant';
    c := pg_temp.to_code(A, 'd8e');
    t := pg_temp.exch('c-d8e', pg_temp.ver(), 'd8e', pg_temp.claude(), 'at-d8e', 'rt-d8e', 'https://other.example.test/api/mcp'); s := s || ' other_resource=' || pg_temp.err(t);
    ok := ok AND pg_temp.err(t) = 'invalid_grant';
    PERFORM pg_temp.reg('d8f', ARRAY[pg_temp.claude()], 'ipr-d8f');
    t := pg_temp.beg('d8f', pg_temp.claude(), 'b-d8f', method => 'plain'); s := s || ' method_plain=' || t;
    ok := ok AND pg_temp.j(t) = jsonb_build_object('ok', false, 'error', 'invalid_request', 'show', 'redirect', 'redirect_uri', pg_temp.claude(), 'state', 'state-d8f');
    t := pg_temp.beg('d8f', pg_temp.claude(), 'b-d8f', scope => 'mcp:write'); s := s || ' scope=' || pg_temp.err(t);
    ok := ok AND pg_temp.err(t) = 'invalid_scope';
    c := pg_temp.connect(A, 'd8g'); s := s || ' rfc7636_pair=' || pg_temp.err(c ->> 'exch');
    ok := ok AND (c ->> 'ok')::boolean;
    r := r || jsonb_build_object('D8_pkce_and_bindings', pg_temp.pass(ok, s));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D8_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D9: redirect allowlist is exact =====
  BEGIN
    s := '';
    ok := true;
    FOR t IN SELECT unnest(ARRAY['https://evil.example/cb', 'http://localhost:3000/cb', 'https://claude.ai/api/mcp/auth_callback/x',
                                 'https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai/api/mcp/auth_callback?x=1',
                                 'https://chatgpt.com/connector_platform_oauth_redirect/abc', 'https://claude.ai/api/mcp/auth_callbackx'])
    LOOP
      n := coalesce(n, 0) + 1;
      t2 := pg_temp.err(pg_temp.reg('d9' || n, ARRAY[t], 'ip-d9-' || n));
      ok := ok AND t2 = 'invalid_redirect_uri';
      s := s || t || '=' || t2 || ' ';
    END LOOP;
    t2 := pg_temp.err(pg_temp.reg('d9m', ARRAY[pg_temp.claude(), 'https://evil.example/cb'], 'ip-d9m')); ok := ok AND t2 = 'invalid_redirect_uri'; s := s || 'mixed=' || t2;
    t2 := pg_temp.err(pg_temp.reg('d9n', ARRAY[pg_temp.claude(), NULL], 'ip-d9n')); ok := ok AND t2 = 'invalid_redirect_uri'; s := s || ' null_elem=' || t2;
    t2 := pg_temp.err(pg_temp.reg('d9f', ARRAY[pg_temp.claude(), pg_temp.gpt(), pg_temp.claude(), pg_temp.gpt()], 'ip-d9f')); ok := ok AND t2 = 'invalid_redirect_uri'; s := s || ' four=' || t2;
    t2 := pg_temp.err(pg_temp.reg('d9ok', ARRAY[pg_temp.claude(), pg_temp.gpt()], 'ip-d9ok')); ok := ok AND t2 = 'OK'; s := s || ' seeded=' || t2;
    t2 := pg_temp.reg('d9c', ARRAY[pg_temp.claude()], 'ip-d9c');
    t3 := pg_temp.beg('d9c', pg_temp.gpt(), 'b-d9c'); ok := ok AND pg_temp.j(t3) = '{"ok": false, "error": "invalid_client", "show": "page"}'::jsonb; s := s || ' begin_unregistered=' || t3;
    t3 := pg_temp.beg('d9c', 'https://evil.example/cb', 'b-d9c'); ok := ok AND pg_temp.j(t3) = '{"ok": false, "error": "invalid_client", "show": "page"}'::jsonb;
    r := r || jsonb_build_object('D9_allowlist_exact', pg_temp.pass(ok, s));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D9_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D10: strict refresh rotation =====
  BEGIN
    c := pg_temp.connect(A, 'd10');
    t := pg_temp.refr('rt-d10', 'd10', 'at-d10b', 'rt-d10b');
    t2 := pg_temp.st('at-d10b');
    t3 := pg_temp.refr('rt-d10', 'd10', 'at-d10c', 'rt-d10c');
    r := r || jsonb_build_object('D10_refresh_reuse_revokes', pg_temp.pass(
      (c ->> 'ok')::boolean AND pg_temp.j(t) = '{"ok": true, "scope": "mcp:read", "expires_in": 3600, "token_type": "Bearer"}'::jsonb
      AND pg_temp.err(t2) = 'OK'
      AND pg_temp.err(t3) = 'invalid_grant'
      AND NOT EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c ->> 'conn')::uuid)
      AND (SELECT count(*) FROM public.mcp_call_log WHERE event = 'refresh_reuse' AND user_id = A) = 1
      AND pg_temp.err(pg_temp.st('at-d10b')) = 'not_connected'
      AND pg_temp.err(pg_temp.refr('rt-d10b', 'd10', 'at-d10d', 'rt-d10d')) = 'invalid_grant',
      t || ' / ' || t2 || ' / reuse=' || t3));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D10_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D11: cross-user (same-organization broker) and the impersonating admin =====
  BEGIN
    s := '';
    c := pg_temp.connect(A, 'd11');
    c2 := pg_temp.to_code(A, 'd11p');  -- a fresh request by A ...
    PERFORM pg_temp.reg('d11q', ARRAY[pg_temp.claude()], 'ipr-d11q');
    t := pg_temp.beg('d11q', pg_temp.claude(), 'b-d11q');
    t2 := pg_temp.vw(A, pg_temp.j(t) ->> 'request_id', 'b-d11q');               -- claimed by A
    t3 := pg_temp.vw(B, pg_temp.j(t) ->> 'request_id', 'b-d11q');               -- B tries to view
    ok := pg_temp.err(t2) = 'OK' AND pg_temp.err(t3) = 'request_invalid'; s := s || 'B_view=' || pg_temp.err(t3);
    t3 := pg_temp.appr(B, pg_temp.j(t) ->> 'request_id', 'b-d11q', pg_temp.j(t2) ->> 'nonce', 'c-d11q');
    ok := ok AND pg_temp.err(t3) = 'request_invalid'; s := s || ' B_approve=' || pg_temp.err(t3);
    t3 := pg_temp.deny(B, pg_temp.j(t) ->> 'request_id', 'b-d11q', pg_temp.j(t2) ->> 'nonce');
    ok := ok AND pg_temp.err(t3) = 'request_invalid'; s := s || ' B_deny=' || pg_temp.err(t3);
    t3 := pg_temp.call_as(B, format('SELECT public.mcp_disconnect(%L)', c ->> 'conn'));
    ok := ok AND pg_temp.j(t3) = '{"ok": true}'::jsonb AND EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c ->> 'conn')::uuid);
    s := s || ' B_disconnect=' || t3 || ' still=' || EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c ->> 'conn')::uuid);
    t3 := pg_temp.call_as(B, format('SELECT public.mcp_disconnect(%L)', gen_random_uuid()));
    ok := ok AND pg_temp.j(t3) = '{"ok": true}'::jsonb;
    t3 := pg_temp.call_as(B, 'SELECT public.mcp_list_my_connections()');
    ok := ok AND pg_temp.j(t3) = '{"ok": true, "connections": []}'::jsonb; s := s || ' B_list=' || t3;
    t3 := pg_temp.call_as(A, 'SELECT public.mcp_list_my_connections()');
    ok := ok AND jsonb_array_length(pg_temp.j(t3) -> 'connections') = 1
          AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.j(t3) -> 'connections' -> 0) k)
              = ARRAY['client_name', 'consented_at', 'id', 'last_used_at', 'provider', 'redirect_host']
          AND pg_temp.j(t3) -> 'connections' -> 0 ->> 'redirect_host' = 'claude.ai';
    s := s || ' A_list=' || t3;
    -- impersonating admin
    t3 := pg_temp.vw(ADM, pg_temp.j(t) ->> 'request_id', 'b-d11q') || pg_temp.appr(ADM, 'x', 'b', 'n', 'c') || pg_temp.deny(ADM, 'x', 'b', 'n')
          || pg_temp.call_as(ADM, format('SELECT public.mcp_disconnect(%L)', c ->> 'conn')) || pg_temp.call_as(ADM, 'SELECT public.mcp_disconnect_all_mine()');
    ok := ok AND t3 = repeat('{"ok": false, "error": "impersonating"}', 5); s := s || ' admin=' || t3;
    t3 := pg_temp.call_as(NULL, 'SELECT public.mcp_list_my_connections()', 'authenticated');
    ok := ok AND pg_temp.err(t3) = 'not_signed_in';
    r := r || jsonb_build_object('D11_cross_user_and_impersonation', pg_temp.pass(ok, s));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D11_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D12: kill switch =====
  BEGIN
    c := pg_temp.connect(A, 'd12');
    t := pg_temp.st('at-d12');
    UPDATE public.mcp_settings SET enabled = false WHERE id;
    n0 := pg_temp.nlog();
    t2 := pg_temp.st('at-d12');
    t3 := pg_temp.chk('at-d12');
    r := r || jsonb_build_object('D12_kill_switch', pg_temp.pass(
      pg_temp.err(t) = 'OK' AND pg_temp.j(t2) = '{"ok": false, "error": "disabled"}'::jsonb AND pg_temp.err(t3) = 'not_connected'
      AND pg_temp.nlog() = n0 + 1 AND (SELECT outcome FROM public.mcp_call_log ORDER BY id DESC LIMIT 1) = 'disabled'
      AND pg_temp.j(pg_temp.beg('d12', pg_temp.claude(), 'b-d12x')) ->> 'error' = 'temporarily_unavailable',
      t || ' / ' || t2 || ' / ' || t3));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D12_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D13 (single session): refusals keep their audit row =====
  BEGIN
    c := pg_temp.connect(A, 'd13');
    FOR n IN 1..30 LOOP t := pg_temp.st('at-d13'); END LOOP;
    t2 := pg_temp.st('at-d13');
    r := r || jsonb_build_object('D13_rate_limited_logged', pg_temp.pass(
      pg_temp.err(t) = 'OK' AND pg_temp.j(t2) = '{"ok": false, "error": "rate_limited"}'::jsonb
      AND (SELECT count(*) FROM public.mcp_call_log WHERE user_id = A AND tool = 'get_status' AND outcome = 'ok') = 30
      AND (SELECT count(*) FROM public.mcp_call_log WHERE user_id = A AND tool = 'get_status' AND outcome = 'rate_limited') = 1
      AND NOT EXISTS (SELECT 1 FROM public.mcp_call_log WHERE outcome = 'pending'),
      t || ' / 31st=' || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D13_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D15: entitlement =====
  BEGIN
    s := '';
    c := pg_temp.connect(A, 'd15');
    t := pg_temp.st('at-d15'); ok := (pg_temp.j(t) -> 'result' -> 'entitled') = 'true'::jsonb; s := s || 'v1=' || t;
    UPDATE public.cloud_p4238_state SET schema_version = 2 WHERE owner = A;
    t := pg_temp.st('at-d15'); ok := ok AND pg_temp.j(t) -> 'result' ->> 'reason' = 'state_unavailable' AND (pg_temp.j(t) -> 'result' -> 'entitled') = 'false'::jsonb; s := s || ' v2=' || t;
    UPDATE public.cloud_p4238_state SET schema_version = 1, mode = 'raise' WHERE owner = A;
    t := pg_temp.st('at-d15'); ok := ok AND pg_temp.j(t) -> 'result' ->> 'reason' = 'state_unavailable'; s := s || ' raise=' || t;
    UPDATE public.cloud_p4238_state SET mode = 'ok' WHERE owner = A;
    UPDATE public.mcp_settings SET connect_requires_cloud = true WHERE id;
    c2 := pg_temp.to_code(B, 'd15b');
    ok := ok AND pg_temp.err(c2 ->> 'appr') = 'not_entitled'; s := s || ' B_approve=' || (c2 ->> 'appr');
    c3 := pg_temp.connect(A, 'd15c');
    ok := ok AND (c3 ->> 'ok')::boolean; s := s || ' A_connect=' || (c3 ->> 'exch');
    r := r || jsonb_build_object('D15_entitlement', pg_temp.pass(ok, s));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D15_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D16: consent request binding, claim and nonce =====
  BEGIN
    s := '';
    PERFORM pg_temp.reg('d16', ARRAY[pg_temp.claude()], 'ipr-d16');
    t := pg_temp.beg('d16', pg_temp.claude(), 'b-d16');
    t2 := pg_temp.vw(A, pg_temp.j(t) ->> 'request_id', 'other-browser'); ok := pg_temp.err(t2) = 'request_invalid'; s := s || 'other_binding=' || pg_temp.err(t2);
    t2 := pg_temp.call_as(A, format('SELECT public.mcp_authorize_view(%L, NULL)', pg_temp.j(t) ->> 'request_id')); ok := ok AND pg_temp.err(t2) = 'request_invalid'; s := s || ' null_binding=' || pg_temp.err(t2);
    t2 := pg_temp.vw(A, pg_temp.j(t) ->> 'request_id', 'b-d16');
    ok := ok AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.j(t2)) k)
                 = ARRAY['client_name', 'nonce', 'notice_version', 'ok', 'provider', 'redirect_host', 'request_id', 'scope']
          AND pg_temp.j(t2) ->> 'provider' = 'anthropic' AND pg_temp.j(t2) ->> 'redirect_host' = 'claude.ai';
    s := s || ' view=' || pg_temp.err(t2);
    t3 := pg_temp.call_as(A, format('SELECT public.mcp_authorize_approve(%L, %s, NULL, %s)', pg_temp.j(t) ->> 'request_id', pg_temp.hx(pg_temp.dg('b-d16')), pg_temp.hx(pg_temp.dg('c-d16'))));
    ok := ok AND pg_temp.err(t3) = 'request_invalid'; s := s || ' null_nonce=' || pg_temp.err(t3);
    t3 := pg_temp.appr(A, pg_temp.j(t) ->> 'request_id', 'b-d16', 'wrong-nonce', 'c-d16'); ok := ok AND pg_temp.err(t3) = 'request_invalid'; s := s || ' wrong_nonce=' || pg_temp.err(t3);
    t3 := pg_temp.appr(A, pg_temp.j(t) ->> 'request_id', 'other-browser', pg_temp.j(t2) ->> 'nonce', 'c-d16'); ok := ok AND pg_temp.err(t3) = 'request_invalid'; s := s || ' approve_other_binding=' || pg_temp.err(t3);
    t3 := pg_temp.appr(A, pg_temp.j(t) ->> 'request_id', 'b-d16', pg_temp.j(t2) ->> 'nonce', 'c-d16');
    ok := ok AND pg_temp.j(t3) = jsonb_build_object('ok', true, 'redirect_uri', pg_temp.claude(), 'state', 'state-d16'); s := s || ' approve=' || t3;
    t3 := pg_temp.appr(A, pg_temp.j(t) ->> 'request_id', 'b-d16', pg_temp.j(t2) ->> 'nonce', 'c-d16b'); ok := ok AND pg_temp.err(t3) = 'request_invalid'; s := s || ' second_approve=' || pg_temp.err(t3);
    -- expired request
    t := pg_temp.beg('d16', pg_temp.claude(), 'b-d16e');
    UPDATE public.mcp_authorization_requests SET expires_at = now() - interval '1 second' WHERE id = pg_temp.j(t) ->> 'request_id';
    t2 := pg_temp.vw(A, pg_temp.j(t) ->> 'request_id', 'b-d16e'); ok := ok AND pg_temp.err(t2) = 'request_invalid'; s := s || ' expired=' || pg_temp.err(t2);
    -- deny
    t := pg_temp.beg('d16', pg_temp.claude(), 'b-d16d');
    t2 := pg_temp.vw(A, pg_temp.j(t) ->> 'request_id', 'b-d16d');
    t3 := pg_temp.deny(A, pg_temp.j(t) ->> 'request_id', 'b-d16d', pg_temp.j(t2) ->> 'nonce');
    ok := ok AND pg_temp.j(t3) = jsonb_build_object('ok', true, 'redirect_uri', pg_temp.claude(), 'state', 'state-d16');
    t3 := pg_temp.appr(A, pg_temp.j(t) ->> 'request_id', 'b-d16d', pg_temp.j(t2) ->> 'nonce', 'c-d16d'); ok := ok AND pg_temp.err(t3) = 'request_invalid'; s := s || ' approve_after_deny=' || pg_temp.err(t3);
    r := r || jsonb_build_object('D16_consent_binding', pg_temp.pass(ok, s));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D16_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D17: disconnect all =====
  BEGIN
    c := pg_temp.connect(A, 'd17a');
    c2 := pg_temp.connect(A, 'd17g', pg_temp.gpt());
    c3 := pg_temp.connect(B, 'd17b');
    t := pg_temp.call_as(A, 'SELECT public.mcp_disconnect_all_mine()');
    BEGIN
      PERFORM public._mcp_disconnect_all_for(B, 'other');
      t2 := 'accepted';
    EXCEPTION WHEN invalid_parameter_value THEN t2 := 'refused';
    END;
    r := r || jsonb_build_object('D17_disconnect_all', pg_temp.pass(
      (c ->> 'ok')::boolean AND (c2 ->> 'ok')::boolean AND (c3 ->> 'ok')::boolean
      AND pg_temp.j(t) = '{"ok": true, "disconnected": 2}'::jsonb
      AND NOT EXISTS (SELECT 1 FROM public.mcp_connections WHERE user_id = A)
      AND (SELECT count(*) FROM public.mcp_connections WHERE user_id = B) = 1
      AND pg_temp.err(pg_temp.st('at-d17b')) = 'OK'
      AND (SELECT count(*) FROM public.mcp_call_log WHERE user_id = A AND event = 'disconnect_all' AND rows_returned = 2) = 1
      AND t2 = 'refused',
      t || ' B_left=' || (SELECT count(*) FROM public.mcp_connections WHERE user_id = B) || ' bad_event=' || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D17_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== D18: reconnecting the same app replaces the older connection =====
  BEGIN
    c := pg_temp.connect(A, 'd18a');
    c2 := pg_temp.connect(A, 'd18g', pg_temp.gpt());
    c3 := pg_temp.connect(B, 'd18b');
    t := (pg_temp.connect(A, 'd18c')) ->> 'conn';
    r := r || jsonb_build_object('D18_reconnect_replaces', pg_temp.pass(
      (c ->> 'ok')::boolean
      AND NOT EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c ->> 'conn')::uuid)
      AND EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = t::uuid AND status = 'active')
      AND EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c2 ->> 'conn')::uuid)
      AND EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c3 ->> 'conn')::uuid)
      AND (SELECT count(*) FROM public.mcp_call_log WHERE user_id = A AND event = 'reconnect_replaced') = 1,
      'old=' || EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c ->> 'conn')::uuid) || ' gpt=' || EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c2 ->> 'conn')::uuid)
      || ' B=' || EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = (c3 ->> 'conn')::uuid)));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('D18_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== C9: frozen success shapes =====
  BEGIN
    PERFORM pg_temp.reg('c9', ARRAY[pg_temp.claude()], 'ipr-c9');
    t := pg_temp.reg('c9b', ARRAY[pg_temp.claude()], 'ipr-c9b');
    t2 := pg_temp.beg('c9', pg_temp.claude(), 'b-c9');
    c := pg_temp.connect(A, 'c9x');
    r := r || jsonb_build_object('C9_shapes', pg_temp.pass(
      pg_temp.j(t) = jsonb_build_object('ok', true, 'client_id', pg_temp.cid('c9b'), 'client_name', 'Fixture app c9b', 'redirect_uris', jsonb_build_array(pg_temp.claude()))
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.j(t2)) k) = ARRAY['expires_in', 'ok', 'request_id']
      AND (pg_temp.j(t2) ->> 'request_id') ~ '^[A-Za-z0-9_-]{22}$' AND (pg_temp.j(t2) -> 'expires_in') = '600'::jsonb
      AND pg_temp.j(c ->> 'exch') = '{"ok": true, "scope": "mcp:read", "expires_in": 3600, "token_type": "Bearer"}'::jsonb
      AND pg_temp.j(c ->> 'appr') = jsonb_build_object('ok', true, 'redirect_uri', pg_temp.claude(), 'state', 'state-c9x')
      AND pg_temp.j(pg_temp.chk('at-c9x')) = '{"ok": true}'::jsonb
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.j(pg_temp.st('at-c9x')) -> 'result') k) = ARRAY['connected', 'entitled', 'provider', 'reason'],
      t || ' / ' || t2 || ' / ' || (c ->> 'exch')));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('C9_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== content-free log =====
  r := r || jsonb_build_object('LOG_columns_content_free', pg_temp.pass(
    (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_call_log')
      = ARRAY['id', 'user_id', 'connection_id', 'provider', 'event', 'tool', 'outcome', 'started_at', 'ended_at', 'rows_returned', 'duration_ms'],
    (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_call_log')));

  -- ===== G1: rollback removes everything; apply after rollback restores it =====
  BEGIN
    EXECUTE $rbx4238$__ROLLBACK__$rbx4238$;
    s := 'after_rollback fns=' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~ '^_?mcp_')
      || ' rels=' || (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'mcp\_%')
      || ' type=' || (to_regtype('public.mcp_gate') IS NOT NULL)
      || ' role=' || (SELECT count(*) FROM pg_roles WHERE rolname = 'mcp_reader');
    ok := s = 'after_rollback fns=0 rels=0 type=false role=0';
    EXECUTE $mg4238$__MIGRATION__$mg4238$;
    t := 'fns=' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~ '^_?mcp_')
      || ' tables=' || (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname LIKE 'mcp\_%')
      || ' role=' || (SELECT count(*) FROM pg_roles WHERE rolname = 'mcp_reader')
      || ' reader_owner=' || (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname = '_mcp_r_entitlement');
    ok := ok AND t = 'fns=25 tables=9 role=1 reader_owner=mcp_reader';
    r := r || jsonb_build_object('G1_rollback_then_apply', pg_temp.pass(ok, s || ' / ' || t));
    RAISE EXCEPTION USING ERRCODE = 'T4238';
  EXCEPTION WHEN SQLSTATE 'T4238' THEN NULL; WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('G1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  RETURN r;
END
$run$;

DO $drv4238$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4238_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv4238$;
