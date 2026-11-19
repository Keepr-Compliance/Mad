-- BACKLOG-4263 PR-10.4 harness: controls, loaded AFTER the migration. Each control is a function returning 'PASS' or
-- 'FAIL: ...'; pg_temp.iso runs one and rolls it back, so controls never see each other's writes.

CREATE FUNCTION pg_temp.iso(fn text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE x_v text;
BEGIN
  BEGIN
    EXECUTE format('SELECT pg_temp.%I()', fn) INTO x_v;
    RAISE EXCEPTION USING ERRCODE = 'MX001';
  EXCEPTION
    WHEN SQLSTATE 'MX001' THEN NULL;
    WHEN OTHERS THEN x_v := 'FAIL: ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  RETURN x_v;
END $h$;

CREATE FUNCTION pg_temp.dg(n int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT decode(substr(pg_temp.dgl(n), 3), 'hex') $h$;
-- the token rows of a connection (compared, never printed)
CREATE FUNCTION pg_temp.tokrows(conn uuid) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce(jsonb_agg(jsonb_build_object('h', md5(t.token_sha256::text), 'k', t.kind, 'u', t.used_at, 'e', t.expires_at, 'p', t.pepper_version)
                            ORDER BY t.token_sha256), '[]')
    FROM public.mcp_tokens t WHERE t.connection_id = conn $h$;
CREATE FUNCTION pg_temp.prune() RETURNS integer LANGUAGE sql AS $h$ SELECT public._mcp_prune_unused_clients() $h$;

-- ================================================================ registration
-- 200 a day per address: the day counter set to 199, then the 200th (accepted) and the 201st (refused, counted)
CREATE FUNCTION pg_temp.c_reg_day() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_r jsonb := '{}';
BEGIN
  PERFORM pg_temp.setc('reg_ip_day:' || pg_temp.iph('d1'), '1 day', 199);
  x_r := x_r || jsonb_build_object('call200', pg_temp.w(pg_temp.q_reg('d1a', 'd1')));
  x_r := x_r || jsonb_build_object('call201', pg_temp.w(pg_temp.q_reg('d1b', 'd1')));
  x_r := x_r || jsonb_build_object('other_address', pg_temp.w(pg_temp.q_reg('d2a', 'd2')));
  RETURN pg_temp.all_of(
    pg_temp.pass(x_r -> 'call200' = pg_temp.reg_ok('d1a'), '200th ' || (x_r -> 'call200')::text),
    pg_temp.pass(x_r -> 'call201' = pg_temp.refusal('rate_limited'), '201st ' || (x_r -> 'call201')::text),
    pg_temp.pass(x_r -> 'other_address' = pg_temp.reg_ok('d2a'), 'other address ' || (x_r -> 'other_address')::text),
    pg_temp.pass(pg_temp.cnt('reg_ip_day:' || pg_temp.iph('d1'), '1 day') = 201, 'day count ' || pg_temp.cnt('reg_ip_day:' || pg_temp.iph('d1'), '1 day')),
    pg_temp.pass(pg_temp.rows_of('reg_ip_day:' || pg_temp.iph('d1')) = 1, 'day rows ' || pg_temp.rows_of('reg_ip_day:' || pg_temp.iph('d1'))),
    pg_temp.pass(pg_temp.cnt('reg_ip:' || pg_temp.iph('d1'), '1 hour') = 2, 'hour count ' || pg_temp.cnt('reg_ip:' || pg_temp.iph('d1'), '1 hour')),
    pg_temp.pass(pg_temp.cnt('reg_ip_day:' || pg_temp.iph('d2'), '1 day') = 1, 'other day count ' || pg_temp.cnt('reg_ip_day:' || pg_temp.iph('d2'), '1 day')),
    pg_temp.pass(pg_temp.has_client('d1a') AND NOT pg_temp.has_client('d1b') AND pg_temp.has_client('d2a'), 'registrations'));
END $c$;

-- 60 an hour per address, unchanged: the hour counter set to 59, then the 60th and the 61st
CREATE FUNCTION pg_temp.c_reg_hour() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_r jsonb := '{}';
BEGIN
  PERFORM pg_temp.setc('reg_ip:' || pg_temp.iph('h1'), '1 hour', 59);
  x_r := x_r || jsonb_build_object('call60', pg_temp.w(pg_temp.q_reg('h1a', 'h1')));
  x_r := x_r || jsonb_build_object('call61', pg_temp.w(pg_temp.q_reg('h1b', 'h1')));
  RETURN pg_temp.all_of(
    pg_temp.pass(x_r -> 'call60' = pg_temp.reg_ok('h1a'), '60th ' || (x_r -> 'call60')::text),
    pg_temp.pass(x_r -> 'call61' = pg_temp.refusal('rate_limited'), '61st ' || (x_r -> 'call61')::text),
    pg_temp.pass(pg_temp.cnt('reg_ip:' || pg_temp.iph('h1'), '1 hour') = 61, 'hour count ' || pg_temp.cnt('reg_ip:' || pg_temp.iph('h1'), '1 hour')),
    pg_temp.pass(pg_temp.cnt('reg_ip_day:' || pg_temp.iph('h1'), '1 day') = 1, 'day count ' || pg_temp.cnt('reg_ip_day:' || pg_temp.iph('h1'), '1 day')),
    pg_temp.pass(pg_temp.has_client('h1a') AND NOT pg_temp.has_client('h1b'), 'registrations'));
END $c$;

-- the global daily bound at 5,000: accepted at 600 (above the old 500), the 5,000th accepted, the 5,001st refused
CREATE FUNCTION pg_temp.c_reg_global() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_r jsonb := '{}';
BEGIN
  PERFORM pg_temp.setc('reg_all', '1 day', 600);
  x_r := x_r || jsonb_build_object('at600', pg_temp.w(pg_temp.q_reg('g0a', 'g0')));
  PERFORM pg_temp.setc('reg_all', '1 day', 4999);
  x_r := x_r || jsonb_build_object('call5000', pg_temp.w(pg_temp.q_reg('g1a', 'g1')));
  x_r := x_r || jsonb_build_object('call5001', pg_temp.w(pg_temp.q_reg('g2a', 'g2')));
  RETURN pg_temp.all_of(
    pg_temp.pass(x_r -> 'at600' = pg_temp.reg_ok('g0a'), 'at 600 ' || (x_r -> 'at600')::text),
    pg_temp.pass(x_r -> 'call5000' = pg_temp.reg_ok('g1a'), '5000th ' || (x_r -> 'call5000')::text),
    pg_temp.pass(x_r -> 'call5001' = pg_temp.refusal('rate_limited'), '5001st ' || (x_r -> 'call5001')::text),
    pg_temp.pass(pg_temp.cnt('reg_all', '1 day') = 5001, 'global count ' || pg_temp.cnt('reg_all', '1 day')),
    pg_temp.pass(pg_temp.cnt('reg_ip:' || pg_temp.iph('g2'), '1 hour') = 1 AND pg_temp.cnt('reg_ip_day:' || pg_temp.iph('g2'), '1 day') = 1,
                 'refused address counters'),
    pg_temp.pass(pg_temp.has_client('g1a') AND NOT pg_temp.has_client('g2a'), 'registrations'));
END $c$;

-- a wrong or missing portal secret: refused, no counter row, no log row, no registration
CREATE FUNCTION pg_temp.c_reg_secret() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_all bigint := pg_temp.cnt('reg_all', '1 day'); x_all_rows bigint := pg_temp.rows_of('reg_all');
        x_log bigint := (SELECT count(*) FROM public.mcp_call_log); x_r jsonb := '{}';
BEGIN
  x_r := x_r || jsonb_build_object('wrong', pg_temp.w(pg_temp.q_reg('s1a', 's1', sec_o => 'pb-wrong-secret')));
  x_r := x_r || jsonb_build_object('null', pg_temp.w(pg_temp.q_reg('s1b', 's1', null_secret => true)));
  RETURN pg_temp.all_of(
    pg_temp.pass(x_r = jsonb_build_object('wrong', pg_temp.refusal('invalid_client_metadata'), 'null', pg_temp.refusal('invalid_client_metadata')), 'answers ' || x_r::text),
    pg_temp.pass(pg_temp.rows_of('reg_ip:' || pg_temp.iph('s1')) = 0 AND pg_temp.rows_of('reg_ip_day:' || pg_temp.iph('s1')) = 0,
                 'address counter rows ' || pg_temp.rows_of('reg_ip:' || pg_temp.iph('s1')) || '/' || pg_temp.rows_of('reg_ip_day:' || pg_temp.iph('s1'))),
    pg_temp.pass(pg_temp.cnt('reg_all', '1 day') = x_all AND pg_temp.rows_of('reg_all') = x_all_rows, 'global counter moved'),
    pg_temp.pass((SELECT count(*) FROM public.mcp_call_log) = x_log, 'call log rows added'),
    pg_temp.pass(NOT pg_temp.has_client('s1a') AND NOT pg_temp.has_client('s1b'), 'registered'));
END $c$;

-- ================================================================ refresh
CREATE FUNCTION pg_temp.c_refresh() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_c1 jsonb; x_c2 jsonb; x_k1 uuid; x_k2 uuid; x_b1 text; x_rt int := 1001; x_ok int := 0; x_r jsonb;
        x_inv jsonb := '{}'; x_before jsonb; x_after jsonb; x_61 jsonb; x_61b jsonb; x_tf0 bigint; x_tf1 bigint; x_c60 bigint; x_other jsonb;
        x_later jsonb; x_new_absent boolean; i int;
BEGIN
  x_c1 := pg_temp.connect('rf1', x_a, 'anthropic', 1000, 1001);
  x_c2 := pg_temp.connect('rf2', x_a, 'openai', 2000, 2001);
  x_k1 := pg_temp.id('conn:rf1'); x_k2 := pg_temp.id('conn:rf2');
  x_b1 := 'refresh_conn:' || x_k1::text;
  -- refused attempts that present connection 1's live refresh token: not counted in refresh_conn
  x_inv := x_inv || jsonb_build_object('wrong_client', pg_temp.w(pg_temp.q_rf(1001, 1100, 1101, client_o => pg_temp.cid('other'))));
  x_inv := x_inv || jsonb_build_object('wrong_resource', pg_temp.w(pg_temp.q_rf(1001, 1102, 1103, res_o => 'https://pb-other.example.test/api/mcp')));
  x_inv := x_inv || jsonb_build_object('wrong_secret', pg_temp.w(pg_temp.q_rf(1001, 1104, 1105, sec_o => 'pb-wrong-secret')));
  x_inv := x_inv || jsonb_build_object('unknown_token', pg_temp.w(pg_temp.q_rf(1999, 1106, 1107)));
  x_inv := x_inv || jsonb_build_object('rows_after_invalid', pg_temp.rows_of(x_b1));
  -- 60 refreshes of connection 1 in this hour, each presenting the refresh token the previous one issued
  FOR i IN 1..60 LOOP
    x_r := pg_temp.w(pg_temp.q_rf(x_rt, 3000 + 2 * i, 3001 + 2 * i));
    IF x_r = pg_temp.ok_answer() THEN x_ok := x_ok + 1; x_rt := 3001 + 2 * i; END IF;
  END LOOP;
  x_before := pg_temp.tokrows(x_k1);
  x_tf0 := pg_temp.cnt('tok_fail:' || pg_temp.client(), '1 minute');
  x_61 := pg_temp.w(pg_temp.q_rf(x_rt, 5000, 5001));
  x_after := pg_temp.tokrows(x_k1);
  x_new_absent := NOT EXISTS (SELECT 1 FROM public.mcp_tokens t WHERE t.token_sha256 IN (sha256(pg_temp.dg(5000)), sha256(pg_temp.dg(5001))));
  x_61b := pg_temp.w(pg_temp.q_rf(x_rt, 5002, 5003));
  x_tf1 := pg_temp.cnt('tok_fail:' || pg_temp.client(), '1 minute');
  x_c60 := pg_temp.cnt(x_b1, '1 hour');
  x_other := pg_temp.w(pg_temp.q_rf(2001, 2100, 2101));
  -- the hour passes (the counter row moved one window back), then the refused refresh token is presented again
  UPDATE public.mcp_rate_counters SET window_start = window_start - interval '1 hour' WHERE bucket = x_b1;
  x_later := pg_temp.w(pg_temp.q_rf(x_rt, 5004, 5005));
  RETURN pg_temp.all_of(
    pg_temp.pass(x_c1 ->> 'consent' = 'approve' AND x_c1 -> 'exchange' = pg_temp.ok_answer() AND (x_c1 ->> 'conn')::boolean
                 AND x_c2 ->> 'consent' = 'approve' AND x_c2 -> 'exchange' = pg_temp.ok_answer() AND (x_c2 ->> 'conn')::boolean,
                 'connect ' || x_c1::text || ' ' || x_c2::text),
    pg_temp.pass(x_inv = jsonb_build_object('wrong_client', pg_temp.refusal('invalid_grant'), 'wrong_resource', pg_temp.refusal('invalid_grant'),
                                            'wrong_secret', pg_temp.refusal('invalid_grant'), 'unknown_token', pg_temp.refusal('invalid_grant'),
                                            'rows_after_invalid', 0), 'refused attempts ' || x_inv::text),
    pg_temp.pass(x_ok = 60, 'accepted in the hour ' || x_ok),
    pg_temp.pass(x_61 = pg_temp.refusal('rate_limited'), '61st ' || x_61::text),
    pg_temp.pass(x_after = x_before, 'the refused refresh changed connection 1''s token rows: ' || jsonb_array_length(x_before) || ' -> ' || jsonb_array_length(x_after)
                 || ', used ' || (SELECT count(*) FROM jsonb_array_elements(x_after) e WHERE e ->> 'u' IS NOT NULL)),
    pg_temp.pass(x_new_absent, 'a token was stored for the refused refresh'),
    pg_temp.pass(x_61b = pg_temp.refusal('rate_limited'), 'again ' || x_61b::text),
    pg_temp.pass(x_tf1 = x_tf0, 'tok_fail count moved'),
    pg_temp.pass(x_c60 = 60, 'refresh_conn count ' || x_c60),
    pg_temp.pass(x_other = pg_temp.ok_answer(), 'other connection of the same user ' || x_other::text),
    pg_temp.pass(x_later = pg_temp.ok_answer(), 'after the hour, the same refresh token ' || x_later::text),
    pg_temp.pass(EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.id = x_k1 AND c.status = 'active'), 'connection 1 gone'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM public.mcp_call_log l WHERE l.user_id = x_a AND l.event = 'refresh_reuse'), 'refresh_reuse logged'),
    pg_temp.pass(pg_temp.cnt(x_b1, '1 hour') = 1 AND pg_temp.cnt('refresh_conn:' || x_k2::text, '1 hour') = 1,
                 'counts after the hour ' || pg_temp.cnt(x_b1, '1 hour') || '/' || pg_temp.cnt('refresh_conn:' || x_k2::text, '1 hour')));
END $c$;

-- ================================================================ cleanup
CREATE FUNCTION pg_temp.c_prune_rule() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_empty integer; x_n integer; x_keep jsonb; x_kids bigint;
BEGIN
  x_empty := pg_temp.prune();
  PERFORM pg_temp.pclient('p31', '31 days');
  PERFORM pg_temp.pclient('p29', '29 days');
  PERFORM pg_temp.pclient('pact', '31 days'); PERFORM pg_temp.pconn('pact', 'active');
  PERFORM pg_temp.pclient('ppend', '31 days'); PERFORM pg_temp.pconn('ppend', 'pending');
  PERFORM pg_temp.pclient('rqp', '31 days'); PERFORM pg_temp.preq('rqp', 'pending', false);
  PERFORM pg_temp.pclient('rqa', '31 days'); PERFORM pg_temp.preq('rqa', 'approved', false);
  PERFORM pg_temp.pclient('rqd', '31 days'); PERFORM pg_temp.preq('rqd', 'denied', false);
  PERFORM pg_temp.pclient('rqx', '31 days'); PERFORM pg_temp.preq('rqx', 'pending', true);
  x_n := pg_temp.prune();
  SELECT jsonb_object_agg(k, pg_temp.has_client(k)) INTO x_keep FROM unnest(ARRAY['p31', 'p29', 'pact', 'ppend', 'rqp', 'rqa', 'rqd', 'rqx']) k;
  SELECT (SELECT count(*) FROM public.mcp_connections c WHERE c.client_id IN (pg_temp.cid('pact'), pg_temp.cid('ppend')))
       + (SELECT count(*) FROM public.mcp_authorization_requests r WHERE r.client_id IN (pg_temp.cid('rqp'), pg_temp.cid('rqa'), pg_temp.cid('rqd'), pg_temp.cid('rqx')))
    INTO x_kids;
  RETURN pg_temp.all_of(
    pg_temp.pass(x_empty = 0, 'nothing to delete answered ' || coalesce(x_empty::text, 'null')),
    pg_temp.pass(x_n = 1, 'deleted ' || coalesce(x_n::text, 'null')),
    pg_temp.pass(x_keep = '{"p31": false, "p29": true, "pact": true, "ppend": true, "rqp": true, "rqa": true, "rqd": true, "rqx": true}'::jsonb, 'kept ' || x_keep::text),
    pg_temp.pass(x_kids = 6, 'child rows ' || x_kids),
    pg_temp.pass(pg_temp.real_changed() = 0, 'pre-existing registrations changed or locked: ' || pg_temp.real_changed()),
    pg_temp.pass(pg_temp.real_selectable() = 0, 'pre-existing registrations selectable: ' || pg_temp.real_selectable()));
END $c$;

-- at most 500 per run: 501 eligible registrations take two runs
CREATE FUNCTION pg_temp.c_prune_cap() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_1 integer; x_2 integer; x_3 integer;
BEGIN
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256, created_at)
  SELECT pg_temp.cid('cap' || n), 'Fixture app cap', ARRAY[pg_temp.redir('anthropic')], pg_temp.ipd('cap'), now() - interval '40 days' - n * interval '1 second'
    FROM generate_series(1, 501) n;
  x_1 := pg_temp.prune(); x_2 := pg_temp.prune(); x_3 := pg_temp.prune();
  RETURN pg_temp.all_of(
    pg_temp.pass(x_1 = 500 AND x_2 = 1 AND x_3 = 0, 'runs ' || coalesce(x_1::text, 'null') || ', ' || coalesce(x_2::text, 'null') || ', ' || coalesce(x_3::text, 'null')),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM public.mcp_oauth_clients c WHERE c.client_name = 'Fixture app cap'), 'left over'),
    pg_temp.pass(pg_temp.real_changed() = 0, 'pre-existing registrations changed or locked: ' || pg_temp.real_changed()));
END $c$;

-- the check repeated after the lock: an authorization request appears for a selected registration while the run is
-- in progress (an AFTER DELETE trigger on the registration deleted just before it) -> that registration is kept
CREATE FUNCTION pg_temp.trg_child_appears() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN
  IF OLD.client_id = pg_temp.cid('rcA') THEN
    PERFORM pg_temp.preq('rcB', 'pending', false);
  END IF;
  RETURN OLD;
END $t$;
CREATE FUNCTION pg_temp.c_prune_recheck() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_n integer;
BEGIN
  PERFORM pg_temp.pclient('rcA', '32 days');
  PERFORM pg_temp.pclient('rcB', '31 days');
  EXECUTE 'CREATE TRIGGER x4263_child_appears AFTER DELETE ON public.mcp_oauth_clients FOR EACH ROW EXECUTE FUNCTION pg_temp.trg_child_appears()';
  x_n := pg_temp.prune();
  RETURN pg_temp.all_of(
    pg_temp.pass(x_n = 1, 'deleted ' || coalesce(x_n::text, 'null')),
    pg_temp.pass(NOT pg_temp.has_client('rcA'), 'first registration kept'),
    pg_temp.pass(pg_temp.has_client('rcB'), 'the registration whose request appeared was deleted'),
    pg_temp.pass((SELECT count(*) FROM public.mcp_authorization_requests r WHERE r.client_id = pg_temp.cid('rcB')) = 1, 'the request is gone'));
END $c$;

-- a third table with a foreign key to mcp_oauth_clients: the run deletes nothing
CREATE FUNCTION pg_temp.c_prune_other_child() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_n integer;
BEGIN
  PERFORM pg_temp.pclient('oc1', '31 days');
  PERFORM pg_temp.pclient('oc2', '31 days');
  EXECUTE 'CREATE TABLE public.x4263_child (client_id text NOT NULL REFERENCES public.mcp_oauth_clients (client_id) ON DELETE CASCADE)';
  EXECUTE format('INSERT INTO public.x4263_child (client_id) VALUES (%L)', pg_temp.cid('oc2'));
  x_n := pg_temp.prune();
  RETURN pg_temp.all_of(
    pg_temp.pass(x_n = 0, 'deleted ' || coalesce(x_n::text, 'null')),
    pg_temp.pass(pg_temp.has_client('oc1') AND pg_temp.has_client('oc2'), 'kept ' || pg_temp.has_client('oc1') || '/' || pg_temp.has_client('oc2')));
END $c$;

-- no API role may execute the cleanup; its attributes
CREATE FUNCTION pg_temp.c_prune_grants() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_anon jsonb; x_auth text; x_svc text; x_attr boolean;
BEGIN
  PERFORM pg_temp.pclient('gr1', '31 days');
  x_anon := pg_temp.w('SELECT to_jsonb(public._mcp_prune_unused_clients())');
  x_auth := pg_temp.call_as(pg_temp.id('A'), 'SELECT to_jsonb(public._mcp_prune_unused_clients())', 'authenticated');
  x_svc := pg_temp.call_as(NULL, 'SELECT to_jsonb(public._mcp_prune_unused_clients())', 'service_role');
  SELECT p.prosecdef AND p.provolatile = 'v' AND p.proowner = 'postgres'::regrole::oid AND array_to_string(p.proconfig, ',') = 'search_path=""'
         AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
         AND (SELECT array_agg(DISTINCT a.grantee::regrole::text) FROM aclexplode(p.proacl) a) = ARRAY['postgres']
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
    INTO x_attr FROM pg_proc p WHERE p.oid = to_regprocedure('public._mcp_prune_unused_clients()');
  RETURN pg_temp.all_of(
    pg_temp.pass(x_anon ->> 'sqlerr' = '42501', 'anon ' || x_anon::text),
    pg_temp.pass(x_auth LIKE 'ERR 42501%', 'authenticated ' || x_auth),
    pg_temp.pass(x_svc LIKE 'ERR 42501%', 'service_role ' || x_svc),
    pg_temp.pass(x_attr, 'attributes or grants'),
    pg_temp.pass(pg_temp.has_client('gr1'), 'a refused caller deleted a registration'));
END $c$;

-- the tables with a foreign key to mcp_oauth_clients (pg_temp.children, in fixtures.sql): exactly the two the cleanup checks
CREATE FUNCTION pg_temp.c_children() RETURNS text LANGUAGE sql STABLE AS $c$
  SELECT pg_temp.pass(pg_temp.children() = '["public.mcp_authorization_requests:c", "public.mcp_connections:c"]'::jsonb, 'children ' || pg_temp.children()::text)
$c$;

-- the cron job: once, this schedule and command, active, as postgres in this database; the other jobs unchanged
CREATE FUNCTION pg_temp.c_cron() RETURNS text LANGUAGE plpgsql AS $c$
BEGIN
  RETURN pg_temp.all_of(
    pg_temp.pass((SELECT count(*) FROM cron.job j WHERE j.jobname = 'mcp-unused-client-prune') = 1, 'jobs named ' || (SELECT count(*) FROM cron.job j WHERE j.jobname = 'mcp-unused-client-prune')),
    pg_temp.pass(EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'mcp-unused-client-prune' AND j.schedule = '53 3 * * *'
                           AND j.command = 'SELECT public._mcp_prune_unused_clients()' AND j.username = 'postgres' AND j.active
                           AND j.database = current_database()), 'job shape'),
    pg_temp.pass((SELECT count(*) FROM cron.job j WHERE j.command ~ '_mcp_prune_unused_clients') = 1, 'jobs running the cleanup ' || (SELECT count(*) FROM cron.job j WHERE j.command ~ '_mcp_prune_unused_clients')),
    pg_temp.pass((SELECT count(*) FROM cron.job j WHERE j.jobname IS DISTINCT FROM 'mcp-unused-client-prune')
                 = (SELECT (v #>> '{}')::bigint FROM pg_temp.pb_out WHERE k = 'fx_cron_jobs_before'), 'other jobs'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM pg_temp.pb_cron_before b WHERE NOT EXISTS (
                   SELECT 1 FROM cron.job j WHERE j.jobid = b.jobid AND j.jobname IS NOT DISTINCT FROM b.jobname AND j.schedule = b.schedule
                      AND j.command = b.command AND j.username = b.username AND j.active = b.active)), 'an existing job changed'));
END $c$;

-- ---------------------------------------------------------------- catalogue: the apply post-check, run again
CREATE FUNCTION pg_temp.c_catalog() RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  EXECUTE @@POSTCHECK@@;
  RETURN 'PASS';
EXCEPTION WHEN OTHERS THEN RETURN 'FAIL: ' || left(SQLERRM, 900);
END $h$;

-- ---------------------------------------------------------------- the migration's own post-check, run again
CREATE FUNCTION pg_temp.c_mig_post() RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  EXECUTE @@MIGPOST@@;
  RETURN 'PASS';
EXCEPTION WHEN OTHERS THEN RETURN 'FAIL: ' || left(SQLERRM, 900);
END $h$;

-- ================================================================ the bodies before this migration, under temporary names
-- registration: one case, set up, call fn as anon; answer and side effects (reg_ip_day excluded); rolled back
CREATE FUNCTION pg_temp.eq_reg_case(cs text, fn text) RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_k text := 'eq-' || cs; x_out text; x_r jsonb; x_all0 bigint;
BEGIN
  BEGIN
    PERFORM pg_temp.setc('reg_all', '1 day', 10);
    x_all0 := pg_temp.cnt('reg_all', '1 day');
    IF cs = 'disabled' THEN UPDATE public.mcp_settings SET enabled = false WHERE id; END IF;
    IF cs = 'ip_hour_limited' THEN PERFORM pg_temp.setc('reg_ip:' || pg_temp.iph('eq'), '1 hour', 60); END IF;
    IF cs = 'reg_all_400' THEN PERFORM pg_temp.setc('reg_all', '1 day', 400); x_all0 := 400; END IF;
    IF cs = 'duplicate' THEN PERFORM pg_temp.w(pg_temp.q_reg(x_k, 'eq', fn)); END IF;
    x_r := pg_temp.w(CASE cs
      WHEN 'wrong_secret' THEN pg_temp.q_reg(x_k, 'eq', fn, sec_o => 'pb-wrong-secret')
      WHEN 'null_secret' THEN pg_temp.q_reg(x_k, 'eq', fn, null_secret => true)
      WHEN 'bad_ip' THEN pg_temp.q_reg(x_k, 'eq', fn, ip_o => '\x0102')
      WHEN 'bad_client_id' THEN pg_temp.q_reg(x_k, 'eq', fn, cid_o => 'kpr_c_short')
      WHEN 'bad_name' THEN pg_temp.q_reg(x_k, 'eq', fn, name_o => '')
      WHEN 'bad_redirect' THEN pg_temp.q_reg(x_k, 'eq', fn, redir_o => ARRAY['https://pb-fixture.example.test/cb'])
      ELSE pg_temp.q_reg(x_k, 'eq', fn) END);
    x_out := jsonb_build_object('res', x_r, 'fx', jsonb_build_object(
      'registered', pg_temp.has_client(x_k),
      'reg_ip', pg_temp.cnt('reg_ip:' || pg_temp.iph('eq'), '1 hour'),
      'reg_all_delta', pg_temp.cnt('reg_all', '1 day') - x_all0,
      'log', (SELECT count(*) FROM public.mcp_call_log l WHERE l.ended_at = now())))::text;
    RAISE EXCEPTION USING ERRCODE = 'MX004';
  EXCEPTION WHEN SQLSTATE 'MX004' THEN NULL;
  END;
  RETURN x_out;
END $c$;
CREATE FUNCTION pg_temp.eq_reg_cases() RETURNS text[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT ARRAY['ok', 'wrong_secret', 'null_secret', 'disabled', 'bad_ip', 'bad_client_id', 'bad_name', 'bad_redirect', 'duplicate',
               'ip_hour_limited', 'reg_all_400'] $h$;
-- refresh: one case on a fresh connection of user A; answer and side effects (refresh_conn excluded); rolled back
CREATE FUNCTION pg_temp.effects_rf(u uuid) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT jsonb_build_object(
    'conns', (SELECT coalesce(jsonb_agg(c.status || ' ' || c.provider ORDER BY c.status, c.provider), '[]') FROM public.mcp_connections c WHERE c.user_id = u),
    'tokens', (SELECT count(*) FROM public.mcp_tokens t JOIN public.mcp_connections c ON c.id = t.connection_id WHERE c.user_id = u),
    'tokens_used', (SELECT count(*) FROM public.mcp_tokens t JOIN public.mcp_connections c ON c.id = t.connection_id WHERE c.user_id = u AND t.used_at IS NOT NULL),
    'log', (SELECT coalesce(jsonb_agg(l.event || ' ' || l.outcome ORDER BY l.event, l.outcome), '[]') FROM public.mcp_call_log l WHERE l.user_id = u),
    'tok_fail', jsonb_build_array(pg_temp.rows_of('tok_fail:' || pg_temp.client()), pg_temp.cnt('tok_fail:' || pg_temp.client(), '1 minute'),
                                  pg_temp.cnt('tok_fail:' || pg_temp.cid('other'), '1 minute'), pg_temp.rows_of('tok_fail:' || pg_temp.cid('nobody'))))
$h$;
CREATE FUNCTION pg_temp.eq_rf_case(cs text, fn text) RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_u uuid := pg_temp.id('A'); x_k text := 'eqr-' || cs; x_out text; x_r jsonb;
BEGIN
  BEGIN
    PERFORM pg_temp.connect(x_k, x_u, 'anthropic', 7000, 7001);
    IF cs = 'expired' THEN
      UPDATE public.mcp_tokens SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE token_sha256 = sha256(pg_temp.dg(7001));
    END IF;
    IF cs = 'reuse' THEN PERFORM pg_temp.w(pg_temp.q_rf(7001, 7102, 7103, fn)); END IF;
    x_r := pg_temp.w(CASE cs
      WHEN 'wrong_secret' THEN pg_temp.q_rf(7001, 7100, 7101, fn, sec_o => 'pb-wrong-secret')
      WHEN 'null_secret' THEN pg_temp.q_rf(7001, 7100, 7101, fn, null_secret => true)
      WHEN 'bad_length' THEN format('SELECT public.%I(%L, %L::bytea, %L, %L, %L::bytea, %L::bytea)', fn, pg_temp.secret(), pg_temp.dgl(7001),
                                    pg_temp.client(), pg_temp.res(), '\x0102', pg_temp.dgl(7101))
      WHEN 'same_digests' THEN pg_temp.q_rf(7001, 7100, 7100, fn)
      WHEN 'wrong_client' THEN pg_temp.q_rf(7001, 7100, 7101, fn, client_o => pg_temp.cid('other'))
      WHEN 'unknown_client' THEN pg_temp.q_rf(7001, 7100, 7101, fn, client_o => pg_temp.cid('nobody'))
      WHEN 'wrong_resource' THEN pg_temp.q_rf(7001, 7100, 7101, fn, res_o => 'https://pb-other.example.test/api/mcp')
      WHEN 'unknown_token' THEN pg_temp.q_rf(7999, 7100, 7101, fn)
      WHEN 'token_clash' THEN pg_temp.q_rf(7001, 7000, 7101, fn)
      ELSE pg_temp.q_rf(7001, 7100, 7101, fn) END);
    x_out := jsonb_build_object('res', x_r, 'fx', pg_temp.effects_rf(x_u))::text;
    RAISE EXCEPTION USING ERRCODE = 'MX004';
  EXCEPTION WHEN SQLSTATE 'MX004' THEN NULL;
  END;
  RETURN x_out;
END $c$;
CREATE FUNCTION pg_temp.eq_rf_cases() RETURNS text[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT ARRAY['ok', 'wrong_secret', 'null_secret', 'bad_length', 'same_digests', 'wrong_client', 'unknown_client', 'wrong_resource', 'unknown_token',
               'expired', 'reuse', 'token_clash'] $h$;
CREATE FUNCTION pg_temp.c_equal() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_cs text; x_o text; x_n text; x_bad text := ''; x_seen text[] := '{}'; x_seen_r text[] := '{}';
BEGIN
  FOREACH x_cs IN ARRAY pg_temp.eq_reg_cases() LOOP
    x_o := pg_temp.eq_reg_case(x_cs, 'mcp_register_client_x4263old');
    x_n := pg_temp.eq_reg_case(x_cs, 'mcp_register_client');
    IF x_o IS DISTINCT FROM x_n THEN
      x_bad := x_bad || 'register ' || x_cs || ': old ' || left(coalesce(x_o, 'null'), 250) || ' new ' || left(coalesce(x_n, 'null'), 250) || '; ';
    END IF;
    x_seen_r := x_seen_r || coalesce((x_n::jsonb -> 'res')::text, 'null');
  END LOOP;
  FOREACH x_cs IN ARRAY pg_temp.eq_rf_cases() LOOP
    x_o := pg_temp.eq_rf_case(x_cs, 'mcp_refresh_x4263old');
    x_n := pg_temp.eq_rf_case(x_cs, 'mcp_refresh');
    IF x_o IS DISTINCT FROM x_n THEN
      x_bad := x_bad || 'refresh ' || x_cs || ': old ' || left(coalesce(x_o, 'null'), 250) || ' new ' || left(coalesce(x_n, 'null'), 250) || '; ';
    END IF;
    x_seen := x_seen || coalesce((x_n::jsonb -> 'res')::text, 'null');
  END LOOP;
  RETURN pg_temp.all_of(
    pg_temp.pass(x_bad = '', x_bad),
    pg_temp.pass((SELECT count(DISTINCT s) FROM unnest(x_seen_r) s) >= 4, 'register answers do not differ: ' || array_to_string(x_seen_r, ' ')),
    pg_temp.pass((SELECT count(DISTINCT s) FROM unnest(x_seen) s) >= 3, 'refresh answers do not differ: ' || array_to_string(x_seen, ' ')));
END $c$;
CREATE FUNCTION pg_temp.eq_report() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_cs text; x_out jsonb := '{}';
BEGIN
  FOREACH x_cs IN ARRAY pg_temp.eq_reg_cases() LOOP
    x_out := x_out || jsonb_build_object('register_' || x_cs, pg_temp.eq_reg_case(x_cs, 'mcp_register_client')::jsonb);
  END LOOP;
  FOREACH x_cs IN ARRAY pg_temp.eq_rf_cases() LOOP
    x_out := x_out || jsonb_build_object('refresh_' || x_cs, pg_temp.eq_rf_case(x_cs, 'mcp_refresh')::jsonb);
  END LOOP;
  RETURN x_out::text;
END $c$;
CREATE FUNCTION pg_temp.with_old(fn text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE x_v text; x_ok boolean := false;
BEGIN
  BEGIN
    EXECUTE @@OLDREG@@;
    EXECUTE @@OLDREF@@;
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.mcp_register_client_x4263old(text, text, text, text[], bytea) TO anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.mcp_refresh_x4263old(text, bytea, text, text, bytea, bytea) TO anon';
    SELECT bool_and(p.prosecdef) AND count(*) = 2
           AND bool_or(md5(p.prosrc) = '@@R_OLD@@' AND p.proname = 'mcp_register_client_x4263old')
           AND bool_or(md5(p.prosrc) = '@@F_OLD@@' AND p.proname = 'mcp_refresh_x4263old') INTO x_ok
      FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.mcp_register_client_x4263old(text,text,text,text[],bytea)'),
                                     to_regprocedure('public.mcp_refresh_x4263old(text,bytea,text,text,bytea,bytea)'));
    EXECUTE format('SELECT pg_temp.%I()', fn) INTO x_v;
    RAISE EXCEPTION USING ERRCODE = 'MX003';
  EXCEPTION WHEN SQLSTATE 'MX003' THEN NULL;
    WHEN OTHERS THEN x_v := 'FAIL: ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  IF x_ok IS NOT TRUE THEN
    RETURN 'FAIL: the old copies are not installed at md5 @@R_OLD@@ / @@F_OLD@@ (' || coalesce(x_v, '') || ')';
  END IF;
  RETURN x_v;
END $h$;
