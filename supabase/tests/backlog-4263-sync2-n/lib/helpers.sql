-- BACKLOG-4263 sync 2.49, P11 (T-N) harness helpers. Loaded inside the one call (which ends in RAISE, so nothing persists).
-- Every id is made at run time (gen_random_uuid); every name, address and secret is invented ('@example.test').
CREATE TEMP TABLE t_out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
CREATE TEMP TABLE t_fx (k text PRIMARY KEY, v uuid) ON COMMIT DROP;
CREATE TEMP TABLE t_txt (k text PRIMARY KEY, v text) ON COMMIT DROP;
-- the statements of T-N (kind 'tn') and of its rollback file (kind 'rb'), pristine and per mutant (a NULL stmt drops one)
CREATE TEMP TABLE t_tn (variant text, kind text, ord numeric, stmt text, PRIMARY KEY (variant, kind, ord)) ON COMMIT DROP;
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.t_out VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v
$h$;
CREATE FUNCTION pg_temp.f(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v FROM pg_temp.t_fx WHERE t_fx.k = f.k $h$;
CREATE FUNCTION pg_temp.s(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT v::text FROM pg_temp.t_fx WHERE t_fx.k = s.k $h$;
CREATE FUNCTION pg_temp.put(k text, v uuid) RETURNS uuid LANGUAGE sql AS $h$
  INSERT INTO pg_temp.t_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v RETURNING v
$h$;
CREATE FUNCTION pg_temp.tx(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT v FROM pg_temp.t_txt WHERE t_txt.k = tx.k $h$;
CREATE FUNCTION pg_temp.put_tx(k text, v text) RETURNS text LANGUAGE sql AS $h$
  INSERT INTO pg_temp.t_txt VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v RETURNING v
$h$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $h$;
CREATE FUNCTION pg_temp.hx(b bytea) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(b, 'hex') $h$;
CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
BEGIN RETURN t::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(t); END $h$;
-- PASS when every value of the object is true; otherwise FAIL with the keys that are not
CREATE FUNCTION pg_temp.verdict(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE e.value IS DISTINCT FROM 'true'::jsonb) AND v <> '{}'::jsonb
              THEN 'PASS' ELSE 'FAIL: ' || left(coalesce((SELECT string_agg(e.key, ',' ORDER BY e.key) FROM jsonb_each(v) e
                                                      WHERE e.value IS DISTINCT FROM 'true'::jsonb), 'empty'), 900) END
$h$;
CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;
-- One statement as an API role with the user's claims (own subtransaction). Returns its single value as text, or
-- 'ERR <sqlstate> <message>'.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text) RETURNS text LANGUAGE plpgsql AS $h$
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
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
END $h$;
-- public.<fn>(args) as fixture user k (authenticated); args is a format() list of %L placeholders.
CREATE FUNCTION pg_temp.as_user(k text, fn text, args text, VARIADIC vals text[]) RETURNS jsonb LANGUAGE plpgsql AS $h$
BEGIN
  RETURN pg_temp.j(pg_temp.call_as(pg_temp.f(k), format('SELECT to_jsonb(public.' || quote_ident(fn) || '(' || args || '))', VARIADIC vals), 'authenticated'));
END $h$;
CREATE FUNCTION pg_temp.as_user0(k text, fn text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(pg_temp.f(k), format('SELECT to_jsonb(public.%I())', fn), 'authenticated'))
$h$;

-- MCP fixtures: the portal secret sits in mcp_settings.portal_secret_prev_sha256 for this call only.
CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql STABLE AS $h$ SELECT 'p4263n-portal-secret-' || pg_temp.s('RUN') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://p4263n-fixture.example.test/api/mcp' $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql STABLE AS $h$ SELECT 'kpr_c_' || substr(md5('p4263n-client-' || pg_temp.s('RUN')), 1, 22) $h$;
-- the two allowlisted redirect addresses (20261112170000:60-63)
CREATE FUNCTION pg_temp.redir(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE p WHEN 'claude' THEN 'https://claude.ai/api/mcp/auth_callback' ELSE 'https://chatgpt.com/connector_platform_oauth_redirect' END
$h$;
-- per connection key k: access and refresh token digests, PKCE verifier, browser binding, code digest, address digest
CREATE FUNCTION pg_temp.dg(k text) RETURNS bytea LANGUAGE sql STABLE AS $h$ SELECT sha256(convert_to('p4263n-at-' || pg_temp.s('RUN') || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.rg(k text) RETURNS bytea LANGUAGE sql STABLE AS $h$ SELECT sha256(convert_to('p4263n-rt-' || pg_temp.s('RUN') || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.ver(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT 'v' || md5(pg_temp.s('RUN') || k) || md5(k || 'x') $h$;
CREATE FUNCTION pg_temp.bind(k text) RETURNS bytea LANGUAGE sql STABLE AS $h$ SELECT sha256(convert_to('p4263n-bind-' || pg_temp.s('RUN') || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.code(k text) RETURNS bytea LANGUAGE sql STABLE AS $h$ SELECT sha256(convert_to('p4263n-code-' || pg_temp.s('RUN') || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.ip(k text) RETURNS bytea LANGUAGE sql STABLE AS $h$ SELECT sha256(convert_to('p4263n-ip-' || pg_temp.s('RUN') || k, 'UTF8')) $h$;

-- ---------------------------------------------------------------- the approval chain, through the real functions only
-- begin (anon, portal secret: 20261118130000 mcp_authorize_begin) -> view (signed in: 20261118170000) -> approve
-- (signed in: 20261118130000:810-871) -> exchange (anon: 20261118180000). Keys stored: 'rid:<k>' request id,
-- 'nonce:<k>' the latest view's nonce; connection id under <k> once exchanged.
CREATE FUNCTION pg_temp.begin_req(k text, p text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb;
BEGIN
  r := pg_temp.j(pg_temp.call_as(NULL, format('SELECT public.mcp_authorize_begin(%L, %L, %L, %L, %L, %L, %L, NULL, %L::bytea, %L::bytea)',
         pg_temp.secret(), pg_temp.client(), pg_temp.redir(p), public._mcp_b64url(sha256(convert_to(pg_temp.ver(k), 'UTF8'))), 'S256',
         pg_temp.res(), 'mcp:read', pg_temp.hx(pg_temp.bind(k)), pg_temp.hx(pg_temp.ip(k))), 'anon'));
  IF r ->> 'request_id' IS NOT NULL THEN PERFORM pg_temp.put_tx('rid:' || k, r ->> 'request_id'); END IF;
  RETURN r;
END $h$;
CREATE FUNCTION pg_temp.view_req(k text, u text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb;
BEGIN
  r := pg_temp.j(pg_temp.call_as(pg_temp.f(u), format('SELECT public.mcp_authorize_view(%L, %L::bytea)', pg_temp.tx('rid:' || k),
         pg_temp.hx(pg_temp.bind(k))), 'authenticated'));
  IF r ->> 'nonce' IS NOT NULL THEN PERFORM pg_temp.put_tx('nonce:' || k, r ->> 'nonce'); END IF;
  RETURN r;
END $h$;
CREATE FUNCTION pg_temp.approve_req(k text, u text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(pg_temp.f(u), format('SELECT public.mcp_authorize_approve(%L, %L::bytea, %L, %L::bytea)', pg_temp.tx('rid:' || k),
         pg_temp.hx(pg_temp.bind(k)), pg_temp.tx('nonce:' || k), pg_temp.hx(pg_temp.code(k))), 'authenticated'))
$h$;
CREATE FUNCTION pg_temp.exchange_req(k text, p text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb; c uuid;
BEGIN
  r := pg_temp.j(pg_temp.call_as(NULL, format('SELECT public.mcp_exchange_code(%L, %L::bytea, %L, %L, %L, %L, %L::bytea, %L::bytea)',
         pg_temp.secret(), pg_temp.hx(pg_temp.code(k)), pg_temp.ver(k), pg_temp.client(), pg_temp.redir(p), pg_temp.res(),
         pg_temp.hx(pg_temp.dg(k)), pg_temp.hx(pg_temp.rg(k))), 'anon'));
  SELECT t.connection_id INTO c FROM public.mcp_tokens t WHERE t.token_sha256 = sha256(pg_temp.dg(k));
  IF c IS NOT NULL THEN PERFORM pg_temp.put(k, c); END IF;
  RETURN r;
END $h$;
-- the whole chain for user u on provider p; answers each step
CREATE FUNCTION pg_temp.chain(k text, u text, p text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE b jsonb; v jsonb; a jsonb; e jsonb;
BEGIN
  b := pg_temp.begin_req(k, p);
  v := pg_temp.view_req(k, u);
  a := pg_temp.approve_req(k, u);
  e := pg_temp.exchange_req(k, p);
  RETURN jsonb_build_object('begin_ok', b -> 'ok', 'view_version', v -> 'notice_version', 'approve_ok', a -> 'ok', 'exchange_ok', e -> 'ok',
                            'approve', a ->> 'error', 'view', v ->> 'error');
END $h$;
-- the version stored on connection k, and on the connection a code of request k created (VOLATILE: product tables)
CREATE FUNCTION pg_temp.conn_version(k text) RETURNS int LANGUAGE sql VOLATILE AS $h$
  SELECT c.notice_version::int FROM public.mcp_connections c WHERE c.id = pg_temp.f(k)
$h$;
CREATE FUNCTION pg_temp.code_version(k text) RETURNS int LANGUAGE sql VOLATILE AS $h$
  SELECT c.notice_version::int FROM public.mcp_authorization_codes x JOIN public.mcp_connections c ON c.id = x.connection_id
   WHERE x.code_sha256 = sha256(pg_temp.code(k))
$h$;
CREATE FUNCTION pg_temp.req_live(k text) RETURNS boolean LANGUAGE sql VOLATILE AS $h$
  SELECT r.status = 'pending' AND r.expires_at > now() FROM public.mcp_authorization_requests r WHERE r.id = pg_temp.tx('rid:' || k)
$h$;
CREATE FUNCTION pg_temp.setting_version() RETURNS int LANGUAGE sql VOLATILE AS $h$
  SELECT s.notice_version::int FROM public.mcp_settings s WHERE s.id
$h$;

-- A tool call as the portal does it (anon role, portal secret, access token digest of connection k). The per-minute
-- counters of the fixture users and of the connection are cleared first. Returns the answer text or 'ERR ...'.
CREATE FUNCTION pg_temp.tool(fn text, k text, extra text) RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  DELETE FROM public.mcp_rate_counters
   WHERE bucket IN ('call_conn:' || coalesce(pg_temp.s(k), '-'), 'call_user:' || pg_temp.s('A'), 'call_user:' || pg_temp.s('B'));
  RETURN pg_temp.call_as(NULL, format('SELECT public.%I(%L, %L::bytea, %L%s)', fn, pg_temp.secret(), pg_temp.hx(pg_temp.dg(k)), pg_temp.res(),
                                       CASE WHEN extra = '' THEN '' ELSE ', ' || extra END), 'anon');
END $h$;
CREATE FUNCTION pg_temp.lst(k text, deal text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.tool('mcp_list_deal_messages', k, format('%L, NULL, NULL, NULL::integer, NULL', pg_temp.s(deal))))
$h$;
CREATE FUNCTION pg_temp.access(k text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.tool('mcp_message_access', k, ''))
$h$;
CREATE FUNCTION pg_temp.refresh(k text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(NULL, format('SELECT public.mcp_refresh(%L, %L::bytea, %L, %L, %L::bytea, %L::bytea)', pg_temp.secret(),
         pg_temp.hx(pg_temp.rg(k)), pg_temp.client(), pg_temp.res(), pg_temp.hx(pg_temp.dg(k || '-r')), pg_temp.hx(pg_temp.rg(k || '-r'))), 'anon'))
$h$;
-- reads and last_outcome are VOLATILE: a STABLE function reads with the snapshot of the statement that calls it, so in
-- an expression that also makes a tool call it would not see the rows that call wrote
CREATE FUNCTION pg_temp.reads(u text) RETURNS bigint LANGUAGE sql VOLATILE AS $h$
  SELECT count(*) FROM public.mcp_message_reads WHERE user_id = pg_temp.f(u)
$h$;
CREATE FUNCTION pg_temp.last_outcome(k text) RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT outcome FROM public.mcp_call_log WHERE connection_id = pg_temp.f(k) ORDER BY id DESC LIMIT 1
$h$;
CREATE FUNCTION pg_temp.has_trigger(t text) RETURNS boolean LANGUAGE sql VOLATILE AS $h$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgname = t AND NOT g.tgisinternal)
$h$;
CREATE FUNCTION pg_temp.fn_acl(sig text) RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT coalesce((SELECT CASE WHEN p.proacl IS NULL THEN 'acl:default'
                               ELSE (SELECT string_agg(x.item::text, ',' ORDER BY x.item::text) FROM unnest(p.proacl) AS x(item)) END
                     FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(sig)), 'absent')
$h$;

-- ---------------------------------------------------------------- T-N and its rollback, as text (pg_temp.t_tn)
-- The variant in force is t_txt 'variant' (default 'pristine'). A mutant's rows replace the pristine statement of the same
-- (kind, ord), add one at a new ord, or drop one (stmt NULL). Every statement runs through EXECUTE, in order.
CREATE FUNCTION pg_temp.run_text(kd text) RETURNS void LANGUAGE plpgsql AS $h$
DECLARE r record; v text := coalesce(pg_temp.tx('variant'), 'pristine');
BEGIN
  FOR r IN
    SELECT x.stmt FROM (
      SELECT p.ord, CASE WHEN m.ord IS NOT NULL THEN m.stmt ELSE p.stmt END AS stmt
        FROM pg_temp.t_tn p LEFT JOIN pg_temp.t_tn m ON m.variant = v AND m.kind = p.kind AND m.ord = p.ord AND v <> 'pristine'
       WHERE p.variant = 'pristine' AND p.kind = kd
      UNION ALL
      SELECT m.ord, m.stmt FROM pg_temp.t_tn m
       WHERE m.variant = v AND v <> 'pristine' AND m.kind = kd
         AND NOT EXISTS (SELECT 1 FROM pg_temp.t_tn p WHERE p.variant = 'pristine' AND p.kind = kd AND p.ord = m.ord)) x
     WHERE x.stmt IS NOT NULL
     ORDER BY x.ord
  LOOP
    EXECUTE r.stmt;
  END LOOP;
END $h$;
CREATE FUNCTION pg_temp.tn() RETURNS void LANGUAGE sql AS $h$ SELECT pg_temp.run_text('tn') $h$;
CREATE FUNCTION pg_temp.rb() RETURNS void LANGUAGE sql AS $h$ SELECT pg_temp.run_text('rb') $h$;
-- T-N, or its rollback, in a block of its own: 'ok' or 'ERR <sqlstate> <message>'
CREATE FUNCTION pg_temp.try(kd text) RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM pg_temp.run_text(kd);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
END $h$;
CREATE FUNCTION pg_temp.req_expires(k text) RETURNS timestamptz LANGUAGE sql VOLATILE AS $h$
  SELECT r.expires_at FROM public.mcp_authorization_requests r WHERE r.id = pg_temp.tx('rid:' || k)
$h$;
