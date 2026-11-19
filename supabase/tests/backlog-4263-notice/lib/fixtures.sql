-- BACKLOG-4263 PR-10.7 harness: helpers and fixtures, loaded BEFORE the migration (inside the same rolled-back call).
-- Every id, name, email and secret is invented and derived from 'notice-harness'; user ids start 00000000-. Rows of
-- the reserved account and of the live AI-app connection are never read or written. Only counts, fixture keys and
-- statuses are recorded.
-- Connections are made by the real producers: mcp_authorize_begin (anon), mcp_authorize_view and
-- mcp_authorize_approve (the signed-in user), then mcp_exchange_code (anon). Set directly, each for this call only and
-- rolled back with everything else:
--   mcp_settings: the portal secret is a fixture value in portal_secret_prev_sha256 (and in portal_secret_sha256 only
--   when that is empty); enabled = true; connect_requires_cloud = false (the setting approve reads, so the fixture
--   users need no Cloud plan);
--   mcp_authorization_codes.expires_at of one code, moved to the past (approve writes now() + 60 s; one transaction
--   cannot wait for it);
--   rows of ai_app_connect_notices for the claim and done controls (their columns are the ones the exchange and the
--   two functions write; connected_at, attempts and lease_until are moved in time for the same reason).

CREATE TEMP TABLE pn_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.pn_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE pn_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.pn_fx WHERE pn_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.pn_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;
-- a fixture user id: 00000000-0000-4000-8000-0000426307<n, 2 digits>
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT ('00000000-0000-4000-8000-0000426307' || lpad(n::text, 2, '0'))::uuid $h$;

CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'pn-fixture-portal-secret-' || md5('notice-harness') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://pn-fixture.example.test/api/mcp' $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || substr(md5('notice-harness-client'), 1, 22) $h$;
CREATE FUNCTION pg_temp.redir(prov text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE prov WHEN 'anthropic' THEN 'https://claude.ai/api/mcp/auth_callback' ELSE 'https://chatgpt.com/connector_platform_oauth_redirect' END $h$;
-- token digest n (what the portal sends) as a bytea text literal; code digest and verifier of consent k
CREATE FUNCTION pg_temp.dgl(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT '\x' || encode(sha256(convert_to('pn-at-' || md5('notice-harness') || n, 'UTF8')), 'hex') $h$;
CREATE FUNCTION pg_temp.cd(k text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('pn-code-' || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.cdl(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.cd(k), 'hex') $h$;
CREATE FUNCTION pg_temp.ver(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'v' || md5(k) || md5(k || 'x') $h$;

-- one call as anon with the claims PostgREST sets; an error comes back as {"sqlerr", "msg"}
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
DECLARE x_bind text := '\x' || encode(sha256(convert_to('pn-bind-' || k, 'UTF8')), 'hex'); x_b jsonb; x_v jsonb; x_a jsonb; x_rid text;
BEGIN
  x_b := pg_temp.w(format('SELECT public.mcp_authorize_begin(%L, %L, %L, %L, %L, %L, %L, NULL, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.client(),
           pg_temp.redir(prov), public._mcp_b64url(sha256(convert_to(pg_temp.ver(k), 'UTF8'))), 'S256', pg_temp.res(), 'mcp:read',
           x_bind, '\x' || encode(sha256(convert_to('pn-ip-' || k, 'UTF8')), 'hex')));
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

-- the exchange call (function fn) for consent k; each override replaces one argument
CREATE FUNCTION pg_temp.q_ex(k text, prov text, n int, fn text DEFAULT 'mcp_exchange_code', ver_o text DEFAULT NULL, code_o text DEFAULT NULL,
                             sec_o text DEFAULT NULL, redir_o text DEFAULT NULL, res_o text DEFAULT NULL, rt_n int DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.%I(%L, %L::bytea, %L, %L, %L, %L, %L::bytea, %L::bytea)', fn, coalesce(sec_o, pg_temp.secret()),
                coalesce(code_o, pg_temp.cdl(k)), coalesce(ver_o, pg_temp.ver(k)), pg_temp.client(), coalesce(redir_o, pg_temp.redir(prov)),
                coalesce(res_o, pg_temp.res()), pg_temp.dgl(n), pg_temp.dgl(coalesce(rt_n, n + 500)))
$h$;
CREATE FUNCTION pg_temp.ok_answer() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT '{"ok":true,"token_type":"Bearer","expires_in":3600,"scope":"mcp:read"}'::jsonb $h$;

-- the notices, by fixture user key ('A', 'B', 'C', or '?' for a user that is not a fixture)
CREATE FUNCTION pg_temp.ukey(u uuid) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT coalesce((SELECT f.k FROM pg_temp.pn_fx f WHERE f.k IN ('A', 'B', 'C') AND f.v = u::text), '?') $h$;
-- what an exchange changes besides the notices: the user's connections, tokens, used codes and log events
CREATE FUNCTION pg_temp.effects(u uuid) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT jsonb_build_object(
    'conns', (SELECT coalesce(jsonb_agg(c.status || ' ' || c.provider ORDER BY c.status, c.provider), '[]') FROM public.mcp_connections c WHERE c.user_id = u),
    'tokens', (SELECT count(*) FROM public.mcp_tokens t JOIN public.mcp_connections c ON c.id = t.connection_id WHERE c.user_id = u),
    'codes_used', (SELECT count(*) FROM public.mcp_authorization_codes x JOIN public.mcp_connections c ON c.id = x.connection_id
                    WHERE c.user_id = u AND x.used_at IS NOT NULL),
    'log', (SELECT coalesce(jsonb_agg(l.event || ' ' || l.outcome ORDER BY l.event, l.outcome), '[]') FROM public.mcp_call_log l WHERE l.user_id = u),
    'tok_fail', (SELECT coalesce(sum(r.count), 0) FROM public.mcp_rate_counters r WHERE r.bucket = 'tok_fail:' || pg_temp.client()))
$h$;

DO $fxn$
DECLARE x_s record;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.uid(n), 'p4263-notice-' || substr(md5('notice-harness'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 3) n;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.put('A', pg_temp.uid(1)::text); PERFORM pg_temp.put('B', pg_temp.uid(2)::text); PERFORM pg_temp.put('C', pg_temp.uid(3)::text);

  SELECT s.enabled, s.connect_requires_cloud, s.portal_secret_sha256 IS NOT NULL AS has_current INTO x_s FROM public.mcp_settings s WHERE s.id;
  PERFORM pg_temp.rec('fx_settings_before', jsonb_build_object('enabled', x_s.enabled, 'connect_requires_cloud', x_s.connect_requires_cloud,
                                                               'current_secret_set', x_s.has_current));
  UPDATE public.mcp_settings
     SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')),
         portal_secret_sha256 = coalesce(portal_secret_sha256, sha256(convert_to('pn-fixture-current-' || md5('notice-harness'), 'UTF8'))),
         enabled = true, connect_requires_cloud = false
   WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY[pg_temp.redir('anthropic'), pg_temp.redir('openai')], sha256(convert_to('pn-ip', 'UTF8')));
  PERFORM pg_temp.rec('fx_allowlist', jsonb_build_object(
    'anthropic', EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = pg_temp.redir('anthropic') AND a.provider = 'anthropic'),
    'openai', EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = pg_temp.redir('openai') AND a.provider = 'openai')));
END
$fxn$;
