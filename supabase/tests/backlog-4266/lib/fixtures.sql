-- BACKLOG-4266 harness: fixtures, loaded BEFORE the migration (inside the same rolled-back call).
-- Every id, name, email and secret is invented and derived from 'h4266'; user ids start 00000000-. Rows of any account
-- that existed before this call are never read or written. Only statuses, counts and fixture keys are recorded.
-- Connections are made by the real producers: mcp_authorize_begin (anon), mcp_authorize_view and mcp_authorize_approve
-- (the signed-in user), then mcp_exchange_code (anon). Set directly, for this call only and rolled back with everything:
--   mcp_settings: the portal secret is a fixture value in portal_secret_prev_sha256 (and in portal_secret_sha256 only
--   when that is empty; _mcp_secret_ok accepts either); enabled = true; connect_requires_cloud = false (the setting
--   mcp_authorize_approve reads, 20261118130000:810, so the fixture users need no Cloud plan);
--   one mcp_oauth_clients row (the columns mcp_register_client writes) whose redirect addresses are the two in
--   mcp_redirect_allowlist.
-- Expected answers are transcribed from the bodies:
--   ok:   jsonb_build_object('ok', true, 'token_type', 'Bearer', 'expires_in', 3600, 'scope', v_scope)
--         (20261123170000, the line marked /*SCOPE:exchange*/; v_scope is the connection's scope, CHECK scope =
--         'mcp:read' at 20261118130000:92-93 via _mcp_granted_scope);
--   refused: _mcp_token_fail -> _mcp_refuse(p_code) = {"ok": false, "error": <code>} (20261112170000:254-265, :198).

CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT ('00000000-0000-4000-8000-0000426600' || lpad(n::text, 2, '0'))::uuid $h$;
CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'h66-fixture-portal-secret-' || md5('h4266') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://h66-fixture.example.test/api/mcp' $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || substr(md5('h4266-client'), 1, 22) $h$;
CREATE FUNCTION pg_temp.redir(prov text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE prov WHEN 'anthropic' THEN 'https://claude.ai/api/mcp/auth_callback' ELSE 'https://chatgpt.com/connector_platform_oauth_redirect' END $h$;
-- token digest n as a bytea text literal; code digest and verifier of consent k
CREATE FUNCTION pg_temp.dgl(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT '\x' || encode(sha256(convert_to('h66-at-' || md5('h4266') || n, 'UTF8')), 'hex') $h$;
CREATE FUNCTION pg_temp.cd(k text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('h66-code-' || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.cdl(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.cd(k), 'hex') $h$;
CREATE FUNCTION pg_temp.ver(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'v' || md5(k) || md5(k || 'x') $h$;

-- one call as anon with the claims PostgREST sets, in its own subtransaction: an error inside rolls back everything the
-- call did (as PostgREST rolls back the request's transaction) and comes back as {"sqlerr", "msg"}
CREATE FUNCTION pg_temp.w(q text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE x_r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    EXECUTE q INTO x_r;
  EXCEPTION WHEN OTHERS THEN x_r := jsonb_build_object('sqlerr', SQLSTATE, 'msg', left(SQLERRM, 200));
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.clear_claims();
  RETURN x_r;
END $h$;

-- begin -> view -> approve for user u and provider prov; the code is pg_temp.cd(k), the verifier pg_temp.ver(k)
CREATE FUNCTION pg_temp.consent(k text, u uuid, prov text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE x_bind text := '\x' || encode(sha256(convert_to('h66-bind-' || k, 'UTF8')), 'hex'); x_b jsonb; x_v jsonb; x_a jsonb; x_rid text;
BEGIN
  x_b := pg_temp.w(format('SELECT public.mcp_authorize_begin(%L, %L, %L, %L, %L, %L, %L, NULL, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.client(),
           pg_temp.redir(prov), public._mcp_b64url(sha256(convert_to(pg_temp.ver(k), 'UTF8'))), 'S256', pg_temp.res(), 'mcp:read',
           x_bind, '\x' || encode(sha256(convert_to('h66-ip-' || k, 'UTF8')), 'hex')));
  x_rid := x_b ->> 'request_id';
  IF x_rid IS NULL THEN
    RETURN jsonb_build_object('step', 'begin', 'r', x_b);
  END IF;
  x_v := pg_temp.rpc(u, format('SELECT public.mcp_authorize_view(%L, %L::bytea)', x_rid, x_bind));
  IF x_v ->> 'nonce' IS NULL THEN
    RETURN jsonb_build_object('step', 'view', 'r', x_v);
  END IF;
  x_a := pg_temp.rpc(u, format('SELECT public.mcp_authorize_approve(%L, %L::bytea, %L, %L::bytea)', x_rid, x_bind, x_v ->> 'nonce', pg_temp.cdl(k)));
  RETURN jsonb_build_object('step', 'approve', 'ok', x_a -> 'ok', 'r', x_a - 'redirect_uri' - 'state');
END $h$;
CREATE FUNCTION pg_temp.consented(c jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $h$
  SELECT c ->> 'step' = 'approve' AND c ->> 'ok' = 'true' $h$;

-- the exchange statement for consent k; each override replaces one argument
CREATE FUNCTION pg_temp.q_ex(k text, prov text, n int, ver_o text DEFAULT NULL, code_o text DEFAULT NULL,
                             sec_o text DEFAULT NULL, rt_n int DEFAULT NULL) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT format('SELECT public.mcp_exchange_code(%L, %L::bytea, %L, %L, %L, %L, %L::bytea, %L::bytea)', coalesce(sec_o, pg_temp.secret()),
                coalesce(code_o, pg_temp.cdl(k)), coalesce(ver_o, pg_temp.ver(k)), pg_temp.client(), pg_temp.redir(prov),
                pg_temp.res(), pg_temp.dgl(n), pg_temp.dgl(coalesce(rt_n, n + 500)))
$h$;
CREATE FUNCTION pg_temp.ok_answer() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT '{"ok":true,"token_type":"Bearer","expires_in":3600,"scope":"mcp:read"}'::jsonb $h$;
CREATE FUNCTION pg_temp.refused(code text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('ok', false, 'error', code) $h$;

-- the fixture user key of a user id ('A', 'B', 'C', or '?')
CREATE FUNCTION pg_temp.ukey(u uuid) RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT coalesce((SELECT f.k FROM pg_temp.t66_fx f WHERE f.k IN ('A', 'B', 'C') AND f.v = u::text), '?') $h$;
-- what a user has: connections (status provider), tokens, used codes, notices (provider replaced status)
CREATE FUNCTION pg_temp.effects(u uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object(
    'conns', (SELECT coalesce(jsonb_agg(c.status || ' ' || c.provider ORDER BY c.status, c.provider), '[]') FROM public.mcp_connections c WHERE c.user_id = u),
    'tokens', (SELECT count(*) FROM public.mcp_tokens t JOIN public.mcp_connections c ON c.id = t.connection_id WHERE c.user_id = u),
    'codes_used', (SELECT count(*) FROM public.mcp_authorization_codes x JOIN public.mcp_connections c ON c.id = x.connection_id
                    WHERE c.user_id = u AND x.used_at IS NOT NULL),
    'notices', (SELECT coalesce(jsonb_agg(n.provider || ' ' || n.replaced::text || ' ' || n.status ORDER BY n.connected_at, n.provider, n.replaced), '[]')
                  FROM public.ai_app_connect_notices n WHERE n.user_id = u))
$h$;
-- the code of consent k: used or not, and its connection's status ('gone' when the connection row is gone)
CREATE FUNCTION pg_temp.code_state(k text) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('used', x.used_at IS NOT NULL,
                            'conn', coalesce((SELECT c.status FROM public.mcp_connections c WHERE c.id = x.connection_id), 'gone'))
    FROM public.mcp_authorization_codes x WHERE x.code_sha256 = sha256(pg_temp.cd(k)) $h$;

DO $fx4266$
DECLARE x_s record;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.uid(n), 'h4266-' || substr(md5('h4266'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 3) n;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.put('A', pg_temp.uid(1)::text); PERFORM pg_temp.put('B', pg_temp.uid(2)::text); PERFORM pg_temp.put('C', pg_temp.uid(3)::text);
  SELECT count(*) AS n INTO x_s FROM public.mcp_settings s WHERE s.id;
  PERFORM pg_temp.rec('fx_settings_rows', to_jsonb(x_s.n));
  UPDATE public.mcp_settings
     SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')),
         portal_secret_sha256 = coalesce(portal_secret_sha256, sha256(convert_to('h66-fixture-current-' || md5('h4266'), 'UTF8'))),
         enabled = true, connect_requires_cloud = false
   WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY[pg_temp.redir('anthropic'), pg_temp.redir('openai')], sha256(convert_to('h66-ip', 'UTF8')));
  PERFORM pg_temp.rec('fx_allowlist', jsonb_build_object(
    'anthropic', EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = pg_temp.redir('anthropic') AND a.provider = 'anthropic'),
    'openai', EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = pg_temp.redir('openai') AND a.provider = 'openai')));
  PERFORM pg_temp.rec('fx_users', to_jsonb((SELECT count(*) FROM auth.users u WHERE u.id IN (pg_temp.uid(1), pg_temp.uid(2), pg_temp.uid(3)))));
  PERFORM pg_temp.rec('fx_notices_before', to_jsonb((SELECT count(*) FROM public.ai_app_connect_notices)));
END
$fx4266$;
