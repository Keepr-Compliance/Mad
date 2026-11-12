-- BACKLOG-4238 harness helpers. Loaded after the migration, inside the same transaction.
-- Every id, digest, secret, address and name below is invented for the harness.
-- PKCE pair: RFC 7636 Appendix B (verifier dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk,
-- challenge E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM).

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT ('00000000-0000-4238-8000-' || lpad(n::text, 12, '0'))::uuid
$h$;
-- an invented 32-byte value standing in for a portal-computed digest
CREATE FUNCTION pg_temp.dg(t text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN t IS NULL THEN NULL ELSE sha256(convert_to('p4238:' || t, 'UTF8')) END
$h$;
CREATE FUNCTION pg_temp.hx(b bytea) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN b IS NULL THEN 'NULL::bytea' ELSE format('decode(%L, %L)', encode(b, 'hex'), 'hex') END
$h$;
CREATE FUNCTION pg_temp.sec() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '__SECRET__' $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://portal.example.test/api/mcp' $h$;
CREATE FUNCTION pg_temp.claude() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://claude.ai/api/mcp/auth_callback' $h$;
CREATE FUNCTION pg_temp.gpt() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://chatgpt.com/connector_platform_oauth_redirect' $h$;
CREATE FUNCTION pg_temp.ver() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' $h$;
CREATE FUNCTION pg_temp.chal() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' $h$;
CREATE FUNCTION pg_temp.cid(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || rpad(k, 22, 'x') $h$;

CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;

-- Run one SELECT as a role: 'anon' (u NULL) or 'authenticated' (u = the user). Returns the jsonb
-- as text, or 'ERR <sqlstate> <message>'. Each call is its own subtransaction.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $h$
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
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
END $h$;

CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
BEGIN RETURN t::jsonb; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $h$;
CREATE FUNCTION pg_temp.err(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(pg_temp.j(t) ->> 'error', CASE WHEN pg_temp.j(t) ->> 'ok' = 'true' THEN 'OK' ELSE t END)
$h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 400), '-') END
$h$;

-- anon calls
CREATE FUNCTION pg_temp.reg(k text, uris text[], ip text, s text DEFAULT '__SECRET__', cid text DEFAULT NULL) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.mcp_register_client(%L, %L, %L, %L::text[], %s)',
         s, coalesce(cid, pg_temp.cid(k)), 'Fixture app ' || k, uris, pg_temp.hx(pg_temp.dg(ip))), 'anon')
$h$;
CREATE FUNCTION pg_temp.beg(k text, redirect text, binding text, chal text DEFAULT 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
                            method text DEFAULT 'S256', resource text DEFAULT 'https://portal.example.test/api/mcp',
                            scope text DEFAULT 'mcp:read', s text DEFAULT '__SECRET__', ip text DEFAULT NULL) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.mcp_authorize_begin(%L, %L, %L, %L, %L, %L, %L, %L, %s, %s)',
         s, pg_temp.cid(k), redirect, chal, method, resource, scope, 'state-' || k,
         pg_temp.hx(pg_temp.dg(binding)), pg_temp.hx(pg_temp.dg(coalesce(ip, 'ipb-' || k)))), 'anon')
$h$;
CREATE FUNCTION pg_temp.exch(code text, verifier text, k text, redirect text, at text, rt text,
                             resource text DEFAULT 'https://portal.example.test/api/mcp', s text DEFAULT '__SECRET__') RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.mcp_exchange_code(%L, %s, %L, %L, %L, %L, %s, %s)',
         s, pg_temp.hx(pg_temp.dg(code)), verifier, pg_temp.cid(k), redirect, resource,
         pg_temp.hx(pg_temp.dg(at)), pg_temp.hx(pg_temp.dg(rt))), 'anon')
$h$;
CREATE FUNCTION pg_temp.refr(rt text, k text, nat text, nrt text, resource text DEFAULT 'https://portal.example.test/api/mcp',
                             s text DEFAULT '__SECRET__') RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.mcp_refresh(%L, %s, %L, %L, %s, %s)',
         s, pg_temp.hx(pg_temp.dg(rt)), pg_temp.cid(k), resource, pg_temp.hx(pg_temp.dg(nat)), pg_temp.hx(pg_temp.dg(nrt))), 'anon')
$h$;
CREATE FUNCTION pg_temp.st(at text, s text DEFAULT '__SECRET__', resource text DEFAULT 'https://portal.example.test/api/mcp') RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.mcp_get_status(%L, %s, %L)', s, pg_temp.hx(pg_temp.dg(at)), resource), 'anon')
$h$;
CREATE FUNCTION pg_temp.chk(at text, s text DEFAULT '__SECRET__', resource text DEFAULT 'https://portal.example.test/api/mcp') RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.mcp_check_access(%L, %s, %L)', s, pg_temp.hx(pg_temp.dg(at)), resource), 'anon')
$h$;
-- signed-in calls
CREATE FUNCTION pg_temp.vw(u uuid, req text, binding text) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.mcp_authorize_view(%L, %s)', req, pg_temp.hx(pg_temp.dg(binding))))
$h$;
CREATE FUNCTION pg_temp.appr(u uuid, req text, binding text, nonce text, code text) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.mcp_authorize_approve(%L, %s, %L, %s)', req, pg_temp.hx(pg_temp.dg(binding)), nonce, pg_temp.hx(pg_temp.dg(code))))
$h$;
CREATE FUNCTION pg_temp.deny(u uuid, req text, binding text, nonce text) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.mcp_authorize_deny(%L, %s, %L)', req, pg_temp.hx(pg_temp.dg(binding)), nonce))
$h$;

-- Full flow up to an issued code: register (claude + chatgpt callbacks), begin, view, approve.
-- Returns {reg, beg, view, appr, req, nonce}. The code is 'c-'||k.
CREATE FUNCTION pg_temp.to_code(u uuid, k text, redirect text DEFAULT 'https://claude.ai/api/mcp/auth_callback', reg boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE a text := 'skip'; b text; v text; p text; req text; nonce text;
BEGIN
  IF reg THEN
    a := pg_temp.reg(k, ARRAY[pg_temp.claude(), pg_temp.gpt()], 'ipr-' || k);
  END IF;
  b := pg_temp.beg(k, redirect, 'b-' || k);
  req := pg_temp.j(b) ->> 'request_id';
  v := pg_temp.vw(u, req, 'b-' || k);
  nonce := pg_temp.j(v) ->> 'nonce';
  p := pg_temp.appr(u, req, 'b-' || k, nonce, 'c-' || k);
  RETURN jsonb_build_object('reg', a, 'beg', b, 'view', v, 'appr', p, 'req', req, 'nonce', nonce);
END $h$;

-- Full flow to tokens 'at-'||k / 'rt-'||k. Returns to_code's object plus {exch, ok, conn}.
CREATE FUNCTION pg_temp.connect(u uuid, k text, redirect text DEFAULT 'https://claude.ai/api/mcp/auth_callback', reg boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE c jsonb; e text;
BEGIN
  c := pg_temp.to_code(u, k, redirect, reg);
  e := pg_temp.exch('c-' || k, pg_temp.ver(), k, redirect, 'at-' || k, 'rt-' || k);
  RETURN c || jsonb_build_object('exch', e, 'ok', pg_temp.err(e) = 'OK',
    'conn', (SELECT t.connection_id FROM public.mcp_tokens t WHERE t.token_sha256 = sha256(pg_temp.dg('at-' || k))));
END $h$;

CREATE FUNCTION pg_temp.nlog() RETURNS bigint LANGUAGE sql AS $h$ SELECT count(*) FROM public.mcp_call_log $h$;
CREATE FUNCTION pg_temp.nctr() RETURNS bigint LANGUAGE sql AS $h$ SELECT coalesce(sum(count), 0) FROM public.mcp_rate_counters $h$;
