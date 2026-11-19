-- BACKLOG-4263 mcp_authorize_view age harness: controls. Each returns 'PASS' or 'FAIL: ...'.

-- a control in its own rolled-back subtransaction
CREATE FUNCTION pg_temp.iso(c text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE v text;
BEGIN
  BEGIN
    EXECUTE format('SELECT pg_temp.%I()', c) INTO v;
    RAISE EXCEPTION USING ERRCODE = 'MX001';
  EXCEPTION WHEN SQLSTATE 'MX001' THEN NULL;
    WHEN OTHERS THEN v := 'FAIL: ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  RETURN v;
END $h$;

-- the age for requests created 0, 0.999, 1, 40, 40.6, 178.999 and 179 seconds before now(): a JSON number, a whole
-- number, equal to floor(extract(epoch FROM now() - created_at))
CREATE FUNCTION pg_temp.age_check(p_keys text[], p_want int[]) RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v_a uuid := pg_temp.id('A'); v jsonb; v_floor int; res text[] := '{}'; i int;
BEGIN
  res := res || pg_temp.pass(clock_timestamp() - now() >= interval '1.1 seconds', 'clock gap ' || (clock_timestamp() - now())::text);
  FOR i IN 1 .. array_length(p_keys, 1) LOOP
    v := pg_temp.view_as(v_a, p_keys[i]);
    SELECT floor(extract(epoch FROM now() - q.created_at))::int INTO v_floor
      FROM public.mcp_authorization_requests q WHERE q.id = pg_temp.rid(p_keys[i]);
    res := res || pg_temp.pass(v ->> 'ok' = 'true' AND v ? 'age_seconds' AND jsonb_typeof(v -> 'age_seconds') = 'number'
                               AND (v -> 'age_seconds')::text ~ '^[0-9]+$' AND (v ->> 'age_seconds')::numeric = greatest(0, v_floor)
                               AND greatest(0, v_floor) = p_want[i],
             p_keys[i] || ' got ' || coalesce((v -> 'age_seconds')::text, 'absent') || ' floor ' || coalesce(v_floor::text, '-')
               || ' want ' || p_want[i] || ' answer ' || left(coalesce(v::text, '-'), 160));
  END LOOP;
  RETURN pg_temp.all_of(res);
END $c$;
CREATE FUNCTION pg_temp.c_age() RETURNS text LANGUAGE sql AS $c$
  SELECT pg_temp.age_check(ARRAY['R0', 'R0999', 'R1', 'R40', 'R406', 'R178999', 'R179'], ARRAY[0, 0, 1, 40, 40, 178, 179])
$c$;
-- created 0.4 and 30 seconds AFTER now() (clock skew): 0, never negative
CREATE FUNCTION pg_temp.c_future() RETURNS text LANGUAGE sql AS $c$
  SELECT pg_temp.age_check(ARRAY['RF04', 'RF30'], ARRAY[0, 0])
$c$;

-- every refusal is exactly {"ok": false, "error": <code>} (so it has no age_seconds)
CREATE FUNCTION pg_temp.c_refusals() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r record; n jsonb; res text[] := '{}';
BEGIN
  FOR r IN SELECT * FROM pg_temp.ag_cases x WHERE NOT x.ok_ ORDER BY x.ck LOOP
    n := pg_temp.one('mcp_authorize_view', r.rk, CASE WHEN r.who = 'A' THEN pg_temp.id('A') END,
                     CASE WHEN r.bk IS NOT NULL THEN pg_temp.bindl(r.bk) END, r.wr, r.off_);
    res := res || pg_temp.pass(n -> 'answer' = jsonb_build_object('ok', false, 'error', r.code) AND NOT ((n -> 'answer') ? 'age_seconds'),
                               r.ck || ' ' || coalesce(n::text, '-'));
  END LOOP;
  RETURN pg_temp.all_of(res);
END $c$;

-- grants: anon and service_role are refused (42501), authenticated can call, another user's request is refused
CREATE FUNCTION pg_temp.c_grants() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v_an text; v_sr text; v_au jsonb; v_other jsonb; v_acl text;
BEGIN
  v_an := pg_temp.view_as(NULL, 'R40', NULL, 'mcp_authorize_view', 'anon')::text;
  v_sr := pg_temp.view_as(NULL, 'R40', NULL, 'mcp_authorize_view', 'service_role')::text;
  v_au := pg_temp.view_as(pg_temp.id('A'), 'R40');
  v_other := pg_temp.view_as(pg_temp.id('A'), 'X_other_user');
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = 'public.mcp_authorize_view(text,bytea)'::regprocedure;
  RETURN pg_temp.all_of(ARRAY[
    pg_temp.pass(v_an LIKE '"ERR 42501%', 'anon ' || v_an),
    pg_temp.pass(v_sr LIKE '"ERR 42501%', 'service_role ' || v_sr),
    pg_temp.pass(v_au ->> 'ok' = 'true', 'authenticated ' || left(v_au::text, 200)),
    pg_temp.pass(v_other = '{"ok": false, "error": "request_invalid"}'::jsonb, 'other user ' || v_other::text),
    pg_temp.pass(v_acl = '{postgres=X/postgres,authenticated=X/postgres}', 'acl ' || coalesce(v_acl, '-')),
    pg_temp.pass(NOT has_function_privilege('anon', 'public.mcp_authorize_view(text,bytea)'::regprocedure, 'EXECUTE'), 'anon privilege')]);
END $c$;

-- old vs new: the old body (20261118130000) under a temporary name, each call in its own rolled-back subtransaction
-- so both see the same row. Success: the new answer minus age_seconds and nonce equals the old answer minus nonce;
-- both nonces are 43 characters and stored as their digest; the row left behind is the same. Refusal: equal answers,
-- no age_seconds, the same row.
CREATE FUNCTION pg_temp.c_equal() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r record; o jsonb; n jsonb; u uuid; b text; res text[] := '{}'; v_repl jsonb := '[]'; v_scopes jsonb := '[]';
BEGIN
  -- the copy gets a new oid on every call: look it up at run time (a ::regprocedure constant is fixed in the cached plan)
  EXECUTE @@OLDCOPY@@;
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.mcp_authorize_view_x4263age_old(text, bytea) TO authenticated';
  res := res || pg_temp.pass((SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_authorize_view_x4263age_old(text,bytea)')) = '@@OLD_MD5@@',
                             'old copy md5');
  FOR r IN SELECT * FROM pg_temp.ag_cases x ORDER BY x.ck LOOP
    u := CASE WHEN r.who = 'A' THEN pg_temp.id('A') END;
    b := CASE WHEN r.bk IS NOT NULL THEN pg_temp.bindl(r.bk) END;
    o := pg_temp.one('mcp_authorize_view_x4263age_old', r.rk, u, b, r.wr, r.off_);
    n := pg_temp.one('mcp_authorize_view', r.rk, u, b, r.wr, r.off_);
    IF r.ok_ THEN
      res := res || pg_temp.pass(o -> 'answer' ->> 'ok' = 'true' AND (n -> 'answer') ? 'age_seconds'
                                 AND ((n -> 'answer') - 'age_seconds' - 'nonce') = ((o -> 'answer') - 'nonce')
                                 AND (n -> 'answer' ->> 'nonce') ~ '^[A-Za-z0-9_-]{43}$' AND (o -> 'answer' ->> 'nonce') ~ '^[A-Za-z0-9_-]{43}$'
                                 AND n -> 'row' = o -> 'row' AND (n -> 'row' ->> 'nonce_stored_matches')::boolean,
                                 r.ck || ' old ' || left(coalesce(o::text, '-'), 260) || ' new ' || left(coalesce(n::text, '-'), 260));
      v_repl := v_repl || jsonb_build_array(o -> 'answer' -> 'replaces_existing');
      v_scopes := v_scopes || jsonb_build_array(o -> 'answer' -> 'scope');
    ELSE
      res := res || pg_temp.pass(o -> 'answer' ->> 'ok' = 'false' AND n -> 'answer' = o -> 'answer' AND NOT ((n -> 'answer') ? 'age_seconds')
                                 AND (n -> 'row') IS NOT DISTINCT FROM (o -> 'row'),
                                 r.ck || ' old ' || coalesce(o::text, '-') || ' new ' || coalesce(n::text, '-'));
    END IF;
  END LOOP;
  -- the cases are not vacuous: both scopes and both replacing values were compared
  res := res || pg_temp.pass(v_repl @> '[true]' AND v_repl @> '[false]' AND v_scopes @> '["mcp:read"]' AND v_scopes @> '["mcp:todos"]',
                             'coverage ' || v_repl::text || ' ' || v_scopes::text);
  EXECUTE 'DROP FUNCTION public.mcp_authorize_view_x4263age_old(text, bytea)';
  RETURN pg_temp.all_of(res);
END $c$;

-- the full-snapshot post-check of the apply file, run again
CREATE FUNCTION pg_temp.c_catalog() RETURNS text LANGUAGE plpgsql AS $c$
BEGIN
  EXECUTE @@POSTCHECK@@;
  RETURN 'PASS';
EXCEPTION WHEN OTHERS THEN
  RETURN 'FAIL: ' || left(SQLERRM, 600);
END $c$;
