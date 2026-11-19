-- BACKLOG-4263 PR-10.7 harness: controls, loaded AFTER the migration. Each control is a function returning 'PASS' or
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

CREATE FUNCTION pg_temp.nids() RETURNS uuid[] LANGUAGE sql STABLE AS $h$
  SELECT coalesce(array_agg(n.id), '{}') FROM public.ai_app_connect_notices n $h$;
-- the notices not in prev, by fixture user key, ordered by user, provider, replaced
CREATE FUNCTION pg_temp.added(prev uuid[]) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce(jsonb_agg(jsonb_build_object('u', pg_temp.ukey(n.user_id), 'p', n.provider, 'r', n.replaced, 's', n.status, 'a', n.attempts,
                                               'at_now', n.connected_at = now(), 'lease', n.lease_until IS NOT NULL, 'sent', n.sent_at IS NOT NULL,
                                               'err', n.last_error)
                            ORDER BY pg_temp.ukey(n.user_id), n.provider, n.replaced), '[]')
    FROM public.ai_app_connect_notices n WHERE NOT (n.id = ANY (prev))
$h$;
CREATE FUNCTION pg_temp.one(u text, p text, r boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('u', u, 'p', p, 'r', r, 's', 'due', 'a', 0, 'at_now', true, 'lease', false, 'sent', false, 'err', NULL) $h$;
-- a notice row written directly (claim and done controls); connected_at = now() - age, lease_until = now() + lease
CREATE FUNCTION pg_temp.seed(k text, u uuid, st text, att int, age interval, lease interval DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE x_id uuid;
BEGIN
  INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced, connected_at, status, attempts, lease_until, sent_at)
  VALUES (u, 'anthropic', false, now() - age, st, att, now() + lease, CASE WHEN st IN ('sent', 'queued') THEN now() - age END)
  RETURNING ai_app_connect_notices.id INTO x_id;
  PERFORM pg_temp.put(k, x_id::text);
  RETURN x_id;
END $h$;
CREATE FUNCTION pg_temp.nrow(k text) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce((SELECT jsonb_build_object('s', n.status, 'a', n.attempts, 'lease', (n.lease_until - now())::text, 'err', n.last_error,
                                             'sent', n.sent_at IS NOT NULL)
                     FROM public.ai_app_connect_notices n WHERE n.id = pg_temp.id(k)), '"gone"'::jsonb) $h$;
-- a claim answer as [{k, a}] ordered by fixture key
CREATE FUNCTION pg_temp.claimed(arr jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce(jsonb_agg(jsonb_build_object('k', coalesce((SELECT f.k FROM pg_temp.pn_fx f WHERE f.v = e ->> 'id'), '?'), 'a', (e ->> 'attempts')::int)
                            ORDER BY coalesce((SELECT f.k FROM pg_temp.pn_fx f WHERE f.v = e ->> 'id'), '?')), '[]')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END) e
$h$;
CREATE FUNCTION pg_temp.svc(q text) RETURNS text LANGUAGE sql AS $h$ SELECT pg_temp.call_as(NULL, q, 'service_role') $h$;
CREATE FUNCTION pg_temp.claim(n int) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.svc(format('SELECT public.ai_app_notice_claim(%s)', coalesce(n::text, 'NULL')))) $h$;
CREATE FUNCTION pg_temp.done_q(k text, att int, st text, err text) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT to_jsonb(public.ai_app_notice_done(%L::uuid, %s, %L, %L))', pg_temp.id(k), att, st, err) $h$;

-- ---------------------------------------------------------------- one notice per activated connection, right user, provider, replaced
CREATE FUNCTION pg_temp.c_notice() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_b uuid := pg_temp.id('B'); x_p uuid[]; x_c jsonb := '[]'; x_e jsonb := '[]'; x_add jsonb := '[]'; x_act bigint;
BEGIN
  x_p := pg_temp.nids();
  x_c := x_c || pg_temp.consent('n-a1', x_a, 'anthropic'); x_e := x_e || pg_temp.w(pg_temp.q_ex('n-a1', 'anthropic', 101));
  x_add := x_add || jsonb_build_array(pg_temp.added(x_p)); x_p := pg_temp.nids();
  x_c := x_c || pg_temp.consent('n-a2', x_a, 'anthropic'); x_e := x_e || pg_temp.w(pg_temp.q_ex('n-a2', 'anthropic', 102));
  x_add := x_add || jsonb_build_array(pg_temp.added(x_p)); x_p := pg_temp.nids();
  SELECT count(*) INTO x_act FROM public.mcp_connections c WHERE c.user_id = x_a AND c.status = 'active' AND c.provider = 'anthropic';
  x_c := x_c || pg_temp.consent('n-a3', x_a, 'openai'); x_e := x_e || pg_temp.w(pg_temp.q_ex('n-a3', 'openai', 103));
  x_add := x_add || jsonb_build_array(pg_temp.added(x_p)); x_p := pg_temp.nids();
  x_c := x_c || pg_temp.consent('n-b1', x_b, 'anthropic'); x_e := x_e || pg_temp.w(pg_temp.q_ex('n-b1', 'anthropic', 104));
  x_add := x_add || jsonb_build_array(pg_temp.added(x_p));
  RETURN pg_temp.all_of(
    pg_temp.pass((SELECT bool_and(c ->> 'step' = 'approve' AND c ->> 'ok' = 'true') FROM jsonb_array_elements(x_c) c), 'consent ' || x_c::text),
    pg_temp.pass((SELECT bool_and(e = pg_temp.ok_answer()) FROM jsonb_array_elements(x_e) e), 'exchange ' || x_e::text),
    pg_temp.pass(x_add -> 0 = jsonb_build_array(pg_temp.one('A', 'anthropic', false)), 'first ' || (x_add -> 0)::text),
    pg_temp.pass(x_add -> 1 = jsonb_build_array(pg_temp.one('A', 'anthropic', true)), 'reconnect ' || (x_add -> 1)::text),
    pg_temp.pass(x_act = 1, 'earlier connection not replaced, active ' || x_act),
    pg_temp.pass(x_add -> 2 = jsonb_build_array(pg_temp.one('A', 'openai', false)), 'other provider ' || (x_add -> 2)::text),
    pg_temp.pass(x_add -> 3 = jsonb_build_array(pg_temp.one('B', 'anthropic', false)), 'other user ' || (x_add -> 3)::text));
END $c$;

-- ---------------------------------------------------------------- no notice for a refused exchange, a refresh, a second use of a code
CREATE FUNCTION pg_temp.c_none() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_u uuid := pg_temp.id('C'); x_p uuid[]; x_c jsonb := '[]'; x_r jsonb := '{}'; x_mid jsonb; x_rf jsonb;
BEGIN
  x_p := pg_temp.nids();
  x_c := x_c || pg_temp.consent('n-c1', x_u, 'anthropic');
  x_r := x_r || jsonb_build_object('wrong_verifier', pg_temp.w(pg_temp.q_ex('n-c1', 'anthropic', 111, ver_o => pg_temp.ver('n-zz'))));
  x_r := x_r || jsonb_build_object('unknown_code', pg_temp.w(pg_temp.q_ex('n-c0', 'anthropic', 112, code_o => pg_temp.cdl('n-none'))));
  x_c := x_c || pg_temp.consent('n-c2', x_u, 'anthropic');
  UPDATE public.mcp_authorization_codes SET expires_at = now() - interval '1 second' WHERE code_sha256 = sha256(pg_temp.cd('n-c2'));
  x_r := x_r || jsonb_build_object('expired', pg_temp.w(pg_temp.q_ex('n-c2', 'anthropic', 113)));
  x_c := x_c || pg_temp.consent('n-c3', x_u, 'openai');
  x_r := x_r || jsonb_build_object('wrong_secret', pg_temp.w(pg_temp.q_ex('n-c3', 'openai', 114, sec_o => 'pn-wrong-secret')));
  x_r := x_r || jsonb_build_object('same_digests', pg_temp.w(pg_temp.q_ex('n-c3', 'openai', 114, rt_n => 114)));
  x_r := x_r || jsonb_build_object('valid', pg_temp.w(pg_temp.q_ex('n-c3', 'openai', 115)));
  x_mid := pg_temp.added(x_p);
  x_rf := pg_temp.w(format('SELECT public.mcp_refresh(%L, %L::bytea, %L, %L, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.dgl(615),
            pg_temp.client(), pg_temp.res(), pg_temp.dgl(117), pg_temp.dgl(617)));
  x_c := x_c || pg_temp.consent('n-c4', x_u, 'anthropic');
  x_r := x_r || jsonb_build_object('token_clash', pg_temp.w(pg_temp.q_ex('n-c4', 'anthropic', 117)));
  x_r := x_r || jsonb_build_object('reused_code', pg_temp.w(pg_temp.q_ex('n-c3', 'openai', 118)));
  RETURN pg_temp.all_of(
    pg_temp.pass((SELECT bool_and(c ->> 'step' = 'approve' AND c ->> 'ok' = 'true') FROM jsonb_array_elements(x_c) c), 'consent ' || x_c::text),
    pg_temp.pass(x_r = jsonb_build_object('wrong_verifier', pg_temp.j('{"ok":false,"error":"invalid_grant"}'), 'unknown_code', pg_temp.j('{"ok":false,"error":"invalid_grant"}'),
                                          'expired', pg_temp.j('{"ok":false,"error":"invalid_grant"}'), 'wrong_secret', pg_temp.j('{"ok":false,"error":"invalid_grant"}'),
                                          'same_digests', pg_temp.j('{"ok":false,"error":"invalid_request"}'), 'valid', pg_temp.ok_answer(),
                                          'token_clash', pg_temp.j('{"ok":false,"error":"invalid_request"}'), 'reused_code', pg_temp.j('{"ok":false,"error":"invalid_grant"}')),
                 'answers ' || x_r::text),
    pg_temp.pass(x_rf ->> 'ok' = 'true', 'refresh ' || x_rf::text),
    pg_temp.pass(x_mid = jsonb_build_array(pg_temp.one('C', 'openai', false)), 'after the valid exchange ' || x_mid::text),
    pg_temp.pass(pg_temp.added(x_p) = jsonb_build_array(pg_temp.one('C', 'openai', false)), 'at the end ' || pg_temp.added(x_p)::text));
END $c$;

-- ---------------------------------------------------------------- the notice insert cannot fail the exchange
-- two breaks: a CHECK that refuses the row (class 23) and a trigger that raises deadlock_detected (40P01, class 40)
CREATE FUNCTION pg_temp.raise_40p01() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '40P01', MESSAGE = 'harness: deadlock in the notice insert';
END $t$;
CREATE FUNCTION pg_temp.c_insert_fail() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_b uuid := pg_temp.id('B'); x_direct text; x_direct2 text; x_p uuid[]; x_c jsonb; x_e jsonb; x_fx jsonb;
        x_c2 jsonb; x_e2 jsonb; x_fx2 jsonb; x_n2 jsonb;
BEGIN
  EXECUTE 'ALTER TABLE public.ai_app_connect_notices ADD CONSTRAINT x4263_refuse CHECK (false) NOT VALID';
  BEGIN
    INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced) VALUES (x_a, 'anthropic', false);
    x_direct := 'inserted';
  EXCEPTION WHEN OTHERS THEN x_direct := SQLSTATE;
  END;
  x_p := pg_temp.nids();
  x_c := pg_temp.consent('n-f1', x_a, 'anthropic');
  x_e := pg_temp.w(pg_temp.q_ex('n-f1', 'anthropic', 121));
  x_fx := pg_temp.effects(x_a);
  -- second break: the CHECK removed, a trigger raising 40P01 on every INSERT
  EXECUTE 'ALTER TABLE public.ai_app_connect_notices DROP CONSTRAINT x4263_refuse';
  EXECUTE 'CREATE TRIGGER x4263_deadlock BEFORE INSERT ON public.ai_app_connect_notices FOR EACH ROW EXECUTE FUNCTION pg_temp.raise_40p01()';
  BEGIN
    INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced) VALUES (x_b, 'anthropic', false);
    x_direct2 := 'inserted';
  EXCEPTION WHEN OTHERS THEN x_direct2 := SQLSTATE;
  END;
  x_p := pg_temp.nids();
  x_c2 := pg_temp.consent('n-f2', x_b, 'anthropic');
  x_e2 := pg_temp.w(pg_temp.q_ex('n-f2', 'anthropic', 122));
  x_fx2 := pg_temp.effects(x_b);
  x_n2 := pg_temp.added(x_p);
  RETURN pg_temp.all_of(
    pg_temp.pass(x_direct = '23514', 'the break did not make an INSERT raise: ' || coalesce(x_direct, 'null')),
    pg_temp.pass(x_direct2 = '40P01', 'the trigger did not make an INSERT raise 40P01: ' || coalesce(x_direct2, 'null')),
    pg_temp.pass(x_c2 ->> 'ok' = 'true', 'consent 2 ' || x_c2::text),
    pg_temp.pass(x_e2 = pg_temp.ok_answer(), 'exchange under 40P01 ' || coalesce(x_e2::text, 'null')),
    pg_temp.pass(x_fx2 -> 'conns' = '["active anthropic"]' AND (x_fx2 ->> 'tokens')::int = 2 AND (x_fx2 ->> 'codes_used')::int = 1,
                 'connection under 40P01 ' || x_fx2::text),
    pg_temp.pass(x_n2 = '[]', 'a notice was written under 40P01 ' || x_n2::text),
    pg_temp.pass(x_c ->> 'ok' = 'true', 'consent ' || x_c::text),
    pg_temp.pass(x_e = pg_temp.ok_answer(), 'exchange ' || coalesce(x_e::text, 'null')),
    pg_temp.pass(x_fx -> 'conns' = '["active anthropic"]' AND (x_fx ->> 'tokens')::int = 2 AND (x_fx ->> 'codes_used')::int = 1, 'connection ' || x_fx::text),
    pg_temp.pass(pg_temp.added(x_p) = '[]', 'a notice was written ' || pg_temp.added(x_p)::text));
END $c$;

-- ---------------------------------------------------------------- the notice survives the connection row and the client row
CREATE FUNCTION pg_temp.c_survive() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_p uuid[]; x_e jsonb; x_n1 int; x_n2 int; x_n3 int; x_conns bigint;
BEGIN
  x_p := pg_temp.nids();
  PERFORM pg_temp.consent('n-s1', x_a, 'anthropic');
  x_e := pg_temp.w(pg_temp.q_ex('n-s1', 'anthropic', 131));
  x_n1 := jsonb_array_length(pg_temp.added(x_p));
  DELETE FROM public.mcp_connections c WHERE c.user_id = x_a;
  x_n2 := jsonb_array_length(pg_temp.added(x_p));
  DELETE FROM public.mcp_oauth_clients o WHERE o.client_id = pg_temp.client();
  x_n3 := jsonb_array_length(pg_temp.added(x_p));
  SELECT count(*) INTO x_conns FROM public.mcp_connections c WHERE c.user_id = x_a;
  RETURN pg_temp.all_of(
    pg_temp.pass(x_e = pg_temp.ok_answer(), 'exchange ' || coalesce(x_e::text, 'null')),
    pg_temp.pass(x_n1 = 1 AND x_conns = 0, 'setup ' || x_n1 || ' ' || x_conns),
    pg_temp.pass(x_n2 = 1, 'gone with the connection row'),
    pg_temp.pass(x_n3 = 1, 'gone with the client row'));
END $c$;

-- ---------------------------------------------------------------- two exchanges, two users, one transaction: each writes its own row
CREATE FUNCTION pg_temp.c_two_users() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_p uuid[]; x_e1 jsonb; x_e2 jsonb; x_ids bigint;
BEGIN
  x_p := pg_temp.nids();
  PERFORM pg_temp.consent('n-t1', pg_temp.id('A'), 'anthropic');
  PERFORM pg_temp.consent('n-t2', pg_temp.id('B'), 'anthropic');
  x_e1 := pg_temp.w(pg_temp.q_ex('n-t1', 'anthropic', 141));
  x_e2 := pg_temp.w(pg_temp.q_ex('n-t2', 'anthropic', 142));
  SELECT count(DISTINCT n.id) INTO x_ids FROM public.ai_app_connect_notices n WHERE NOT (n.id = ANY (x_p));
  RETURN pg_temp.all_of(
    pg_temp.pass(x_e1 = pg_temp.ok_answer() AND x_e2 = pg_temp.ok_answer(), 'exchange ' || coalesce(x_e1::text, 'null') || coalesce(x_e2::text, 'null')),
    pg_temp.pass(pg_temp.added(x_p) = jsonb_build_array(pg_temp.one('A', 'anthropic', false), pg_temp.one('B', 'anthropic', false)), 'rows ' || pg_temp.added(x_p)::text),
    pg_temp.pass(x_ids = 2, 'distinct ids ' || x_ids),
    pg_temp.pass((SELECT count(*) FROM pg_index i WHERE i.indrelid = 'public.ai_app_connect_notices'::regclass AND i.indisunique) = 1, 'a unique index besides the key'));
END $c$;

-- ---------------------------------------------------------------- no API role but service_role reaches the functions; no role reaches the table
CREATE FUNCTION pg_temp.c_grants() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_role text; x_q text; x_r text; x_bad text := ''; x_n int := 0;
BEGIN
  PERFORM pg_temp.seed('g1', pg_temp.id('A'), 'due', 0, '1 minute');
  FOREACH x_role IN ARRAY ARRAY['anon', 'authenticated', 'mcp_reader'] LOOP
    FOREACH x_q IN ARRAY ARRAY['SELECT public.ai_app_notice_claim(10)', pg_temp.done_q('g1', 0, 'sent', NULL)] LOOP
      x_r := pg_temp.call_as(pg_temp.id('A'), x_q, x_role); x_n := x_n + 1;
      IF x_r NOT LIKE 'ERR 42501 permission denied for function %' THEN x_bad := x_bad || x_role || ' ' || left(x_q, 40) || ' -> ' || left(x_r, 80) || '; '; END IF;
    END LOOP;
  END LOOP;
  FOREACH x_role IN ARRAY ARRAY['anon', 'authenticated', 'mcp_reader', 'service_role'] LOOP
    FOREACH x_q IN ARRAY ARRAY['SELECT count(*) FROM public.ai_app_connect_notices',
                               format('INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced) VALUES (%L, %L, false)', pg_temp.id('A'), 'anthropic'),
                               'UPDATE public.ai_app_connect_notices SET attempts = 0',
                               'DELETE FROM public.ai_app_connect_notices',
                               'TRUNCATE public.ai_app_connect_notices'] LOOP
      x_r := pg_temp.call_as(pg_temp.id('A'), x_q, x_role); x_n := x_n + 1;
      IF x_r NOT LIKE 'ERR 42501 permission denied for table %' THEN x_bad := x_bad || x_role || ' ' || left(x_q, 40) || ' -> ' || left(x_r, 80) || '; '; END IF;
    END LOOP;
  END LOOP;
  RETURN pg_temp.all_of(pg_temp.pass(x_bad = '' AND x_n = 26, x_n || ' calls: ' || x_bad),
                        pg_temp.pass(pg_temp.nrow('g1') = '{"s":"due","a":0,"lease":null,"err":null,"sent":false}', 'row changed ' || pg_temp.nrow('g1')::text));
END $c$;

-- ---------------------------------------------------------------- the inside check: service_role claim works, anything else is refused
CREATE FUNCTION pg_temp.c_caller() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_pc text; x_uc text; x_pd text; x_ud text; x_mid jsonb; x_sc jsonb; x_sd text;
BEGIN
  PERFORM pg_temp.seed('k1', x_a, 'due', 0, '1 minute');
  x_pc := pg_temp.as_user(NULL, 'SELECT public.ai_app_notice_claim(10)');
  x_uc := pg_temp.as_user(x_a, 'SELECT public.ai_app_notice_claim(10)');
  x_pd := pg_temp.as_user(NULL, pg_temp.done_q('k1', 0, 'sent', NULL));
  x_ud := pg_temp.as_user(x_a, pg_temp.done_q('k1', 0, 'sent', NULL));
  x_mid := pg_temp.nrow('k1');
  x_sc := pg_temp.claim(10);
  x_sd := pg_temp.svc(pg_temp.done_q('k1', 1, 'sent', NULL));
  RETURN pg_temp.all_of(
    pg_temp.pass(x_pc LIKE 'ERR P0001 Unauthorized%', 'claim, owner without claims: ' || left(x_pc, 120)),
    pg_temp.pass(x_uc LIKE 'ERR P0001 Unauthorized%', 'claim, owner with a user claim: ' || left(x_uc, 120)),
    pg_temp.pass(x_pd LIKE 'ERR P0001 Unauthorized%', 'done, owner without claims: ' || left(x_pd, 120)),
    pg_temp.pass(x_ud LIKE 'ERR P0001 Unauthorized%', 'done, owner with a user claim: ' || left(x_ud, 120)),
    pg_temp.pass(x_mid = '{"s":"due","a":0,"lease":null,"err":null,"sent":false}', 'row changed by a refused call ' || x_mid::text),
    pg_temp.pass(pg_temp.claimed(x_sc) = '[{"k":"k1","a":1}]', 'service_role claim ' || left(x_sc::text, 200)),
    pg_temp.pass(x_sd = 'true', 'service_role done ' || x_sd),
    pg_temp.pass((pg_temp.nrow('k1') ->> 's') = 'sent', 'after done ' || pg_temp.nrow('k1')::text));
END $c$;

-- ---------------------------------------------------------------- claim: lease, attempts cap, 2-day skip, 30-day prune, keys
CREATE FUNCTION pg_temp.c_claim() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_c1 jsonb; x_c2 jsonb; x_c3 jsonb; x_st jsonb; x_keys boolean; x_first jsonb;
BEGIN
  PERFORM pg_temp.seed('r_fresh', x_a, 'due', 0, '1 minute');
  PERFORM pg_temp.seed('r_old', x_a, 'due', 0, '3 days');
  PERFORM pg_temp.seed('r_old_leased', x_a, 'due', 1, '2 days 1 minute', '1 minute');
  PERFORM pg_temp.seed('r_tired', x_a, 'due', 5, '1 hour');
  PERFORM pg_temp.seed('r_tired_leased', x_a, 'due', 5, '1 hour', '1 minute');
  PERFORM pg_temp.seed('r_leased', x_a, 'due', 1, '10 minutes', '1 minute');
  PERFORM pg_temp.seed('r_lease_over', x_a, 'due', 1, '10 minutes', '-1 minute');
  PERFORM pg_temp.seed('r_four', x_a, 'due', 4, '1 hour', '-1 second');
  PERFORM pg_temp.seed('r_sent_old', x_a, 'sent', 1, '31 days');
  PERFORM pg_temp.seed('r_due_old', x_a, 'due', 0, '31 days');
  PERFORM pg_temp.seed('r_sent_new', x_a, 'sent', 1, '1 day');
  x_c1 := pg_temp.claim(50);
  SELECT jsonb_object_agg(f.k, pg_temp.nrow(f.k)) INTO x_st FROM pg_temp.pn_fx f WHERE f.k LIKE 'r\_%';
  SELECT bool_and((SELECT array_agg(x ORDER BY x COLLATE "C") FROM jsonb_object_keys(e) x) = ARRAY['attempts', 'connected_at', 'id', 'provider', 'replaced', 'user_id'])
    INTO x_keys FROM jsonb_array_elements(x_c1) e;
  SELECT e INTO x_first FROM jsonb_array_elements(x_c1) e WHERE e ->> 'id' = pg_temp.id('r_fresh')::text;
  x_c2 := pg_temp.claim(50);
  UPDATE public.ai_app_connect_notices n SET lease_until = now() - interval '1 second' WHERE n.id IN (pg_temp.id('r_fresh'), pg_temp.id('r_old_leased'));
  x_c3 := pg_temp.claim(50);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.claimed(x_c1) = '[{"k":"r_four","a":5},{"k":"r_fresh","a":1},{"k":"r_lease_over","a":2}]', 'first claim ' || left(x_c1::text, 300) || ' ' || pg_temp.claimed(x_c1)::text),
    pg_temp.pass(x_keys IS TRUE, 'keys ' || left(x_c1::text, 300)),
    pg_temp.pass(x_first ->> 'user_id' = x_a::text AND x_first ->> 'provider' = 'anthropic' AND x_first -> 'replaced' = 'false' AND x_first ->> 'connected_at' IS NOT NULL,
                 'row ' || coalesce(x_first::text, 'null')),
    pg_temp.pass(x_st = jsonb_build_object(
      'r_fresh', pg_temp.j('{"s":"due","a":1,"lease":"00:05:00","err":null,"sent":false}'),
      'r_old', pg_temp.j('{"s":"skipped","a":0,"lease":null,"err":"stale","sent":false}'),
      'r_old_leased', pg_temp.j('{"s":"due","a":1,"lease":"00:01:00","err":null,"sent":false}'),
      'r_tired', pg_temp.j('{"s":"failed","a":5,"lease":null,"err":"attempts","sent":false}'),
      'r_tired_leased', pg_temp.j('{"s":"due","a":5,"lease":"00:01:00","err":null,"sent":false}'),
      'r_leased', pg_temp.j('{"s":"due","a":1,"lease":"00:01:00","err":null,"sent":false}'),
      'r_lease_over', pg_temp.j('{"s":"due","a":2,"lease":"00:05:00","err":null,"sent":false}'),
      'r_four', pg_temp.j('{"s":"due","a":5,"lease":"00:05:00","err":null,"sent":false}'),
      'r_sent_old', pg_temp.j('"gone"'),
      'r_due_old', pg_temp.j('"gone"'),
      'r_sent_new', pg_temp.j('{"s":"sent","a":1,"lease":null,"err":null,"sent":true}')), 'states ' || x_st::text),
    pg_temp.pass(x_c2 = '[]', 'second claim ' || left(x_c2::text, 300)),
    pg_temp.pass(pg_temp.claimed(x_c3) = '[{"k":"r_fresh","a":2}]', 'after the lease ' || left(x_c3::text, 300)),
    pg_temp.pass(pg_temp.nrow('r_old_leased') = '{"s":"skipped","a":1,"lease":null,"err":"stale","sent":false}', 'old row after its lease ' || pg_temp.nrow('r_old_leased')::text));
END $c$;

-- ---------------------------------------------------------------- claim: at most 50, nothing for 0, NULL or a negative limit
CREATE FUNCTION pg_temp.c_cap() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_z jsonb; x_null jsonb; x_neg jsonb; x_big jsonb; x_rest jsonb;
BEGIN
  INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced) SELECT x_a, 'openai', false FROM generate_series(1, 60);
  x_z := pg_temp.claim(0);
  x_null := pg_temp.claim(NULL);
  x_neg := pg_temp.claim(-5);
  x_big := pg_temp.claim(1000);
  x_rest := pg_temp.claim(50);
  RETURN pg_temp.all_of(
    pg_temp.pass(x_z = '[]' AND x_null = '[]' AND x_neg = '[]', 'small limits ' || left(x_z::text, 80) || left(x_null::text, 80) || left(x_neg::text, 80)),
    pg_temp.pass(jsonb_array_length(x_big) = 50, 'limit 1000 gave ' || coalesce(jsonb_array_length(x_big)::text, left(x_big::text, 100))),
    pg_temp.pass(jsonb_array_length(x_rest) = 10, 'the rest gave ' || coalesce(jsonb_array_length(x_rest)::text, left(x_rest::text, 100))));
END $c$;

-- ---------------------------------------------------------------- done: guarded on attempts and on due; vocabulary; error cut to 40
CREATE FUNCTION pg_temp.c_done() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_r jsonb := '{}'; x_st jsonb;
BEGIN
  PERFORM pg_temp.seed('d1', x_a, 'due', 1, '1 minute', '5 minutes');
  PERFORM pg_temp.seed('d2', x_a, 'due', 2, '1 minute', '5 minutes');
  PERFORM pg_temp.seed('d3', x_a, 'due', 1, '1 minute', '5 minutes');
  PERFORM pg_temp.seed('d4', x_a, 'due', 1, '1 minute', '5 minutes');
  PERFORM pg_temp.seed('d5', x_a, 'due', 1, '1 minute', '5 minutes');
  x_r := x_r || jsonb_build_object('stale', pg_temp.svc(pg_temp.done_q('d1', 0, 'sent', NULL)));
  x_r := x_r || jsonb_build_object('stale_row', pg_temp.nrow('d1'));
  x_r := x_r || jsonb_build_object('sent', pg_temp.svc(pg_temp.done_q('d1', 1, 'sent', NULL)));
  x_r := x_r || jsonb_build_object('over_finished', pg_temp.svc(pg_temp.done_q('d1', 1, 'failed', 'late')));
  x_r := x_r || jsonb_build_object('retry', pg_temp.svc(pg_temp.done_q('d2', 2, 'due', repeat('e', 100))));
  x_r := x_r || jsonb_build_object('bad_status', left(pg_temp.svc(pg_temp.done_q('d3', 1, 'bogus', NULL)), 9));
  x_r := x_r || jsonb_build_object('null_status', left(pg_temp.svc(pg_temp.done_q('d3', 1, NULL, NULL)), 9));
  x_r := x_r || jsonb_build_object('queued', pg_temp.svc(pg_temp.done_q('d4', 1, 'queued', NULL)));
  x_r := x_r || jsonb_build_object('no_address', pg_temp.svc(pg_temp.done_q('d5', 1, 'skipped', 'no_address')));
  SELECT jsonb_object_agg(f.k, pg_temp.nrow(f.k)) INTO x_st FROM pg_temp.pn_fx f WHERE f.k LIKE 'd_';
  RETURN pg_temp.all_of(
    pg_temp.pass(x_r = jsonb_build_object('stale', 'false', 'stale_row', pg_temp.j('{"s":"due","a":1,"lease":"00:05:00","err":null,"sent":false}'),
                                          'sent', 'true', 'over_finished', 'false', 'retry', 'true', 'bad_status', 'ERR 22023', 'null_status', 'ERR 22023',
                                          'queued', 'true', 'no_address', 'true'), 'answers ' || x_r::text),
    pg_temp.pass(x_st = jsonb_build_object(
      'd1', pg_temp.j('{"s":"sent","a":1,"lease":null,"err":null,"sent":true}'),
      'd2', jsonb_build_object('s', 'due', 'a', 2, 'lease', NULL, 'err', repeat('e', 40), 'sent', false),
      'd3', pg_temp.j('{"s":"due","a":1,"lease":"00:05:00","err":null,"sent":false}'),
      'd4', pg_temp.j('{"s":"queued","a":1,"lease":null,"err":null,"sent":true}'),
      'd5', pg_temp.j('{"s":"skipped","a":1,"lease":null,"err":"no_address","sent":false}')), 'states ' || x_st::text));
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

-- ================================================================ the body before this migration, under a temporary name
-- one case: set up, call function fn as anon, answer and side effects (notices excluded); rolled back
CREATE FUNCTION pg_temp.eq_case(cs text, fn text) RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_u uuid := pg_temp.id('A'); x_k text := 'n-eq-' || cs; x_out text; x_r jsonb; x_prov text := 'anthropic';
BEGIN
  BEGIN
    IF cs = 'openai' THEN x_prov := 'openai'; END IF;
    IF cs IN ('replace', 'token_clash') THEN
      -- token_clash: the earlier connection is of the other provider, so it is not replaced and its tokens stay
      PERFORM pg_temp.consent(x_k || '-pre', x_u, CASE WHEN cs = 'token_clash' THEN 'openai' ELSE x_prov END);
      PERFORM pg_temp.w(pg_temp.q_ex(x_k || '-pre', CASE WHEN cs = 'token_clash' THEN 'openai' ELSE x_prov END, 151, fn));
    END IF;
    IF cs IS DISTINCT FROM 'unknown' THEN PERFORM pg_temp.consent(x_k, x_u, x_prov); END IF;
    IF cs = 'expired' THEN
      UPDATE public.mcp_authorization_codes SET expires_at = now() - interval '1 second' WHERE code_sha256 = sha256(pg_temp.cd(x_k));
    END IF;
    IF cs IN ('replay_ok', 'replay_bad') THEN PERFORM pg_temp.w(pg_temp.q_ex(x_k, x_prov, 152, fn)); END IF;
    x_r := pg_temp.w(CASE cs
      WHEN 'wrong_verifier' THEN pg_temp.q_ex(x_k, x_prov, 153, fn, ver_o => pg_temp.ver('n-zz'))
      WHEN 'replay_bad' THEN pg_temp.q_ex(x_k, x_prov, 153, fn, ver_o => pg_temp.ver('n-zz'))
      WHEN 'unknown' THEN pg_temp.q_ex(x_k, x_prov, 153, fn, code_o => pg_temp.cdl('n-none'))
      WHEN 'wrong_secret' THEN pg_temp.q_ex(x_k, x_prov, 153, fn, sec_o => 'pn-wrong-secret')
      WHEN 'same_digests' THEN pg_temp.q_ex(x_k, x_prov, 153, fn, rt_n => 153)
      WHEN 'token_clash' THEN pg_temp.q_ex(x_k, x_prov, 151, fn)
      WHEN 'wrong_redirect' THEN pg_temp.q_ex(x_k, x_prov, 153, fn, redir_o => 'https://claude.ai/api/mcp/other')
      WHEN 'wrong_resource' THEN pg_temp.q_ex(x_k, x_prov, 153, fn, res_o => 'https://pn-other.example.test/api/mcp')
      ELSE pg_temp.q_ex(x_k, x_prov, 153, fn) END);
    x_out := jsonb_build_object('res', x_r, 'fx', pg_temp.effects(x_u))::text;
    RAISE EXCEPTION USING ERRCODE = 'MX004';
  EXCEPTION WHEN SQLSTATE 'MX004' THEN NULL;
  END;
  RETURN x_out;
END $c$;
CREATE FUNCTION pg_temp.eq_cases() RETURNS text[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT ARRAY['first', 'replace', 'openai', 'wrong_verifier', 'unknown', 'expired', 'replay_ok', 'replay_bad', 'wrong_secret', 'same_digests',
               'token_clash', 'wrong_redirect', 'wrong_resource'] $h$;
CREATE FUNCTION pg_temp.c_equal() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_cs text; x_o text; x_n text; x_bad text := ''; x_seen text[] := '{}'; x_first jsonb;
BEGIN
  FOREACH x_cs IN ARRAY pg_temp.eq_cases() LOOP
    x_o := pg_temp.eq_case(x_cs, 'mcp_exchange_code_x4263old');
    x_n := pg_temp.eq_case(x_cs, 'mcp_exchange_code');
    IF x_o IS DISTINCT FROM x_n THEN
      x_bad := x_bad || x_cs || ': old ' || left(coalesce(x_o, 'null'), 250) || ' new ' || left(coalesce(x_n, 'null'), 250) || '; ';
    END IF;
    x_seen := x_seen || coalesce((x_n::jsonb -> 'res')::text, 'null');
    IF x_cs = 'first' THEN x_first := x_n::jsonb -> 'res'; END IF;
  END LOOP;
  RETURN pg_temp.all_of(
    pg_temp.pass(x_bad = '', x_bad),
    pg_temp.pass(x_first = pg_temp.ok_answer(), 'first ' || coalesce(x_first::text, 'null')),
    pg_temp.pass((SELECT count(DISTINCT s) FROM unnest(x_seen) s) >= 3, 'answers do not differ: ' || array_to_string(x_seen, ' ')));
END $c$;
CREATE FUNCTION pg_temp.eq_report() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_cs text; x_out jsonb := '{}';
BEGIN
  FOREACH x_cs IN ARRAY pg_temp.eq_cases() LOOP
    x_out := x_out || jsonb_build_object(x_cs, pg_temp.eq_case(x_cs, 'mcp_exchange_code')::jsonb);
  END LOOP;
  RETURN x_out::text;
END $c$;
CREATE FUNCTION pg_temp.with_old(fn text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE x_v text; x_ok boolean := false;
BEGIN
  BEGIN
    EXECUTE @@OLDCOPY@@;
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.mcp_exchange_code_x4263old(text, bytea, text, text, text, text, bytea, bytea) TO anon';
    SELECT md5(p.prosrc) = '@@OLD_MD5@@' AND p.prosecdef INTO x_ok
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_exchange_code_x4263old(text,bytea,text,text,text,text,bytea,bytea)');
    EXECUTE format('SELECT pg_temp.%I()', fn) INTO x_v;
    RAISE EXCEPTION USING ERRCODE = 'MX003';
  EXCEPTION WHEN SQLSTATE 'MX003' THEN NULL;
    WHEN OTHERS THEN x_v := 'FAIL: ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  IF x_ok IS NOT TRUE THEN
    RETURN 'FAIL: the old copy is not installed at md5 @@OLD_MD5@@ (' || coalesce(x_v, '') || ')';
  END IF;
  RETURN x_v;
END $h$;
