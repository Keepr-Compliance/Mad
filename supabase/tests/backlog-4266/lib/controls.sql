-- BACKLOG-4266 harness: controls, loaded AFTER the migration. Each control returns 'PASS' or 'FAIL: ...'; the runner
-- calls each one in a subtransaction that is undone, so controls never see each other's writes.
-- Forcing the notice INSERT to fail without changing the product: DDL on public.ai_app_connect_notices (owner
-- postgres, the role this call runs as) made inside the control's own subtransaction, undone with it:
--   a CHECK (false) NOT VALID constraint (refuses every new row: 23514);
--   a BEFORE INSERT trigger that raises deadlock_detected (40P01) or lock_not_available (55P03);
--   a BEFORE INSERT trigger that returns NULL: the INSERT ... SELECT then writes no row and raises nothing (the
--   zero-row path the row-count check closes; making the SELECT itself find no connection would need a change to the
--   product, since the connection row was just updated by the same call).

CREATE FUNCTION pg_temp.h66_raise_40p01() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN RAISE EXCEPTION USING ERRCODE = '40P01', MESSAGE = 'h4266: deadlock in the notice insert'; END $t$;
CREATE FUNCTION pg_temp.h66_raise_55p03() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'h4266: lock not available in the notice insert'; END $t$;
CREATE FUNCTION pg_temp.h66_skip() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN RETURN NULL; END $t$;
CREATE FUNCTION pg_temp.h66_noop() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN RETURN NEW; END $t$;

-- ---------------------------------------------------------------- one notice per activated connection
CREATE FUNCTION pg_temp.c_notice() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_a uuid := pg_temp.id('A'); x_b uuid := pg_temp.id('B'); x_c jsonb := '[]'; x_e jsonb := '[]'; x_f1 jsonb; x_f2 jsonb; x_fb jsonb;
BEGIN
  x_c := x_c || pg_temp.consent('n-a1', x_a, 'anthropic');
  x_e := x_e || pg_temp.w(pg_temp.q_ex('n-a1', 'anthropic', 101));
  x_f1 := pg_temp.effects(x_a);
  x_c := x_c || pg_temp.consent('n-a2', x_a, 'anthropic');
  x_e := x_e || pg_temp.w(pg_temp.q_ex('n-a2', 'anthropic', 102));
  x_f2 := pg_temp.effects(x_a);
  x_c := x_c || pg_temp.consent('n-b1', x_b, 'openai');
  x_e := x_e || pg_temp.w(pg_temp.q_ex('n-b1', 'openai', 103));
  x_fb := pg_temp.effects(x_b);
  RETURN pg_temp.all_of(
    pg_temp.pass((SELECT bool_and(pg_temp.consented(c)) FROM jsonb_array_elements(x_c) c), 'consent ' || x_c::text),
    pg_temp.pass((SELECT bool_and(e = pg_temp.ok_answer()) FROM jsonb_array_elements(x_e) e), 'exchange ' || x_e::text),
    pg_temp.pass(x_f1 = '{"conns": ["active anthropic"], "tokens": 2, "codes_used": 1, "notices": ["anthropic false due"]}'::jsonb, 'first ' || x_f1::text),
    pg_temp.pass(x_f2 -> 'conns' = '["active anthropic"]' AND x_f2 -> 'notices' = '["anthropic false due", "anthropic true due"]', 'reconnect ' || x_f2::text),
    pg_temp.pass(x_fb = '{"conns": ["active openai"], "tokens": 2, "codes_used": 1, "notices": ["openai false due"]}'::jsonb, 'other user ' || x_fb::text));
END $c$;

-- ---------------------------------------------------------------- refused exchanges: answers unchanged, no notice
CREATE FUNCTION pg_temp.c_none() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_u uuid := pg_temp.id('C'); x_c jsonb := '[]'; x_r jsonb := '{}'; x_f jsonb;
BEGIN
  x_c := x_c || pg_temp.consent('n-c1', x_u, 'anthropic');
  x_r := x_r || jsonb_build_object('wrong_verifier', pg_temp.w(pg_temp.q_ex('n-c1', 'anthropic', 111, ver_o => pg_temp.ver('n-zz'))));
  x_r := x_r || jsonb_build_object('unknown_code', pg_temp.w(pg_temp.q_ex('n-c0', 'anthropic', 112, code_o => pg_temp.cdl('n-none'))));
  x_c := x_c || pg_temp.consent('n-c3', x_u, 'openai');
  x_r := x_r || jsonb_build_object('wrong_secret', pg_temp.w(pg_temp.q_ex('n-c3', 'openai', 114, sec_o => 'h66-wrong-secret')));
  x_r := x_r || jsonb_build_object('same_digests', pg_temp.w(pg_temp.q_ex('n-c3', 'openai', 114, rt_n => 114)));
  x_f := pg_temp.effects(x_u);
  RETURN pg_temp.all_of(
    pg_temp.pass((SELECT bool_and(pg_temp.consented(c)) FROM jsonb_array_elements(x_c) c), 'consent ' || x_c::text),
    -- 20261123170000: a verifier mismatch removes the pending connection and answers invalid_grant (the /*rejected*/
    -- branch, as in 20261118180000:121-134); an unknown code answers invalid_grant (:96-119); a wrong portal secret
    -- answers _mcp_refuse('invalid_grant') (:79-81); equal digests answer invalid_request (:82-85)
    pg_temp.pass(x_r = jsonb_build_object('wrong_verifier', pg_temp.refused('invalid_grant'), 'unknown_code', pg_temp.refused('invalid_grant'),
                                          'wrong_secret', pg_temp.refused('invalid_grant'), 'same_digests', pg_temp.refused('invalid_request')),
                 'answers ' || x_r::text),
    pg_temp.pass(x_f -> 'notices' = '[]' AND (x_f ->> 'tokens')::int = 0, 'effects ' || x_f::text));
END $c$;

-- ---------------------------------------------------------------- a notice that cannot be written fails the whole exchange
-- user B: an earlier active connection (with its notice), then the break, then a reconnect with code k that must raise
-- want_err and leave nothing (code unused, new connection pending, earlier connection and its tokens kept, no new
-- notice); then the break undone and the SAME code redeemed: ok and the second notice.
CREATE FUNCTION pg_temp.fail_case(k text, brk text, unbrk text, want_err text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE x_b uuid := pg_temp.id('B'); x_c0 jsonb; x_e0 jsonb; x_c jsonb; x_e jsonb; x_f jsonb; x_s jsonb; x_e2 jsonb; x_f2 jsonb; x_direct text; x_n bigint;
BEGIN
  x_c0 := pg_temp.consent(k || '-base', x_b, 'anthropic');
  x_e0 := pg_temp.w(pg_temp.q_ex(k || '-base', 'anthropic', 201));
  EXECUTE brk;
  -- the break acts: a direct INSERT (undone) raises want_err, or for the zero-row break writes no row
  BEGIN
    INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced) VALUES (x_b, 'anthropic', false);
    GET DIAGNOSTICS x_n = ROW_COUNT;
    x_direct := 'rows=' || x_n;
    RAISE EXCEPTION USING ERRCODE = 'MX009';
  EXCEPTION WHEN SQLSTATE 'MX009' THEN NULL;
    WHEN OTHERS THEN x_direct := SQLSTATE;
  END;
  x_c := pg_temp.consent(k, x_b, 'anthropic');
  x_e := pg_temp.w(pg_temp.q_ex(k, 'anthropic', 202));
  x_f := pg_temp.effects(x_b);
  x_s := pg_temp.code_state(k);
  EXECUTE unbrk;
  x_e2 := pg_temp.w(pg_temp.q_ex(k, 'anthropic', 203));
  x_f2 := pg_temp.effects(x_b);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.consented(x_c0) AND x_e0 = pg_temp.ok_answer(), 'earlier connection ' || x_c0::text || ' ' || coalesce(x_e0::text, 'null')),
    pg_temp.pass(x_direct = CASE WHEN want_err = 'MC004' THEN 'rows=0' ELSE want_err END, 'the break did not act on a direct INSERT: ' || coalesce(x_direct, 'null')),
    pg_temp.pass(pg_temp.consented(x_c), 'consent ' || x_c::text),
    pg_temp.pass(x_e ->> 'sqlerr' = want_err AND x_e ->> 'ok' IS NULL, 'exchange under the break did not raise ' || want_err || ': ' || coalesce(x_e::text, 'null')),
    pg_temp.pass(x_s = '{"used": false, "conn": "pending"}'::jsonb, 'code after the failed exchange ' || coalesce(x_s::text, 'null')),
    pg_temp.pass(x_f = '{"conns": ["active anthropic", "pending anthropic"], "tokens": 2, "codes_used": 1, "notices": ["anthropic false due"]}'::jsonb,
                 'state after the failed exchange ' || x_f::text),
    pg_temp.pass(x_e2 = pg_temp.ok_answer(), 'same code after the break was undone ' || coalesce(x_e2::text, 'null')),
    pg_temp.pass(x_f2 -> 'conns' = '["active anthropic"]' AND x_f2 -> 'notices' = '["anthropic false due", "anthropic true due"]', 'after the retry ' || x_f2::text));
END $h$;
CREATE FUNCTION pg_temp.c_fail_check() RETURNS text LANGUAGE sql AS $c$
  SELECT pg_temp.fail_case('n-f1', 'ALTER TABLE public.ai_app_connect_notices ADD CONSTRAINT h66_refuse CHECK (false) NOT VALID',
                           'ALTER TABLE public.ai_app_connect_notices DROP CONSTRAINT h66_refuse', '23514') $c$;
CREATE FUNCTION pg_temp.c_fail_deadlock() RETURNS text LANGUAGE sql AS $c$
  SELECT pg_temp.fail_case('n-f2', 'CREATE TRIGGER h66_t BEFORE INSERT ON public.ai_app_connect_notices FOR EACH ROW EXECUTE FUNCTION pg_temp.h66_raise_40p01()',
                           'DROP TRIGGER h66_t ON public.ai_app_connect_notices', '40P01') $c$;
CREATE FUNCTION pg_temp.c_fail_lock() RETURNS text LANGUAGE sql AS $c$
  SELECT pg_temp.fail_case('n-f3', 'CREATE TRIGGER h66_t BEFORE INSERT ON public.ai_app_connect_notices FOR EACH ROW EXECUTE FUNCTION pg_temp.h66_raise_55p03()',
                           'DROP TRIGGER h66_t ON public.ai_app_connect_notices', '55P03') $c$;
CREATE FUNCTION pg_temp.c_zero_row() RETURNS text LANGUAGE sql AS $c$
  SELECT pg_temp.fail_case('n-f4', 'CREATE TRIGGER h66_t BEFORE INSERT ON public.ai_app_connect_notices FOR EACH ROW EXECUTE FUNCTION pg_temp.h66_skip()',
                           'DROP TRIGGER h66_t ON public.ai_app_connect_notices', 'MC004') $c$;

-- ---------------------------------------------------------------- catalogue: the exchange and the notice table as the migration leaves them
CREATE FUNCTION pg_temp.c_catalogue() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x jsonb; x_post text := 'ok';
BEGIN
  SELECT jsonb_build_object(
    'md5', md5(p.prosrc)::text, 'secdef', p.prosecdef, 'vol', p.provolatile::text, 'config', array_to_string(p.proconfig, ',')::text,
    'owner', pg_catalog.pg_get_userbyid(p.proowner)::text,
    'execute', (SELECT coalesce(jsonb_agg(DISTINCT a.grantee::regrole::text ORDER BY a.grantee::regrole::text), '[]') FROM aclexplode(p.proacl) a
                 WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 0),
    'public_execute', EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))
    INTO x FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)');
  x := x || (SELECT jsonb_build_object('t_owner', pg_catalog.pg_get_userbyid(c.relowner)::text, 't_rls', c.relrowsecurity, 't_force', c.relforcerowsecurity,
                                       't_triggers', (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal))
               FROM pg_catalog.pg_class c WHERE c.oid = 'public.ai_app_connect_notices'::regclass);
  BEGIN
    EXECUTE @@MIGPOST@@;
  EXCEPTION WHEN OTHERS THEN x_post := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  RETURN pg_temp.all_of(
    pg_temp.pass(x = jsonb_build_object('md5', '@@NEW_MD5@@', 'secdef', true, 'vol', 'v', 'config', 'search_path=""', 'owner', 'postgres',
                                        'execute', '["anon", "postgres"]'::jsonb, 'public_execute', false,
                                        't_owner', 'postgres', 't_rls', true, 't_force', false, 't_triggers', 0), 'catalogue ' || x::text),
    pg_temp.pass(x_post = 'ok', 'the migration''s own post-check: ' || x_post));
END $c$;

-- ---------------------------------------------------------------- re-runs: this migration again is a no-op; 20261118180000 again refuses
CREATE FUNCTION pg_temp.c_reruns() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x_new text := 'ok'; x_old text := 'applied'; x_app text := 'applied'; x_md5a text; x_md5b text; x_md5c text;
BEGIN
  BEGIN
    EXECUTE (SELECT v FROM pg_temp.t66_txt WHERE k = 'm20261123170000');
  EXCEPTION WHEN OTHERS THEN x_new := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  SELECT md5(prosrc) INTO x_md5a FROM pg_proc WHERE oid = 'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'::regprocedure;
  BEGIN
    EXECUTE (SELECT v FROM pg_temp.t66_txt WHERE k = 'm20261118180000');
  EXCEPTION WHEN OTHERS THEN x_old := SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  SELECT md5(prosrc) INTO x_md5b FROM pg_proc WHERE oid = 'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'::regprocedure;
  BEGIN
    EXECUTE (SELECT v FROM pg_temp.t66_txt WHERE k = 'a20261118180000');
  EXCEPTION WHEN OTHERS THEN x_app := SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  SELECT md5(prosrc) INTO x_md5c FROM pg_proc WHERE oid = 'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'::regprocedure;
  RETURN pg_temp.all_of(
    pg_temp.pass(x_new = 'ok' AND x_md5a = '@@NEW_MD5@@', 're-run of 20261123170000: ' || x_new || ' md5 ' || coalesce(x_md5a, 'null')),
    -- 20261118180000:36-37: the pre-check accepts only ab6a9345... and 9a33bff2...
    pg_temp.pass(x_old LIKE 'P0001 BACKLOG-4263: public.mcp_exchange_code is not at the expected body%' AND x_md5b = '@@NEW_MD5@@',
                 're-run of 20261118180000: ' || x_old || ' md5 ' || coalesce(x_md5b, 'null')),
    pg_temp.pass(x_app LIKE 'P0001 BACKLOG-4263: public.mcp_exchange_code is not at the expected body%' AND x_md5c = '@@NEW_MD5@@',
                 're-run of backlog-4263-notice/apply-20261118180000.sql: ' || x_app || ' md5 ' || coalesce(x_md5c, 'null')));
END $c$;
