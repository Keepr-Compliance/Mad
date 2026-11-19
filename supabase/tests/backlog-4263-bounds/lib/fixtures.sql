-- BACKLOG-4263 PR-10.4 harness: helpers and fixtures, loaded BEFORE the migration (inside the same rolled-back call).
-- Every id, name, email, address digest and secret is invented and derived from 'bounds-harness'; user ids start
-- 00000000-. Rows of the reserved account and of the live AI-app connection are never read or written. Only counts,
-- fixture keys, statuses, md5s and timings are recorded.
-- Connections used by the refresh controls are made by the real producers: mcp_authorize_begin (anon),
-- mcp_authorize_view and mcp_authorize_approve (the signed-in user), then mcp_exchange_code (anon).
-- Written directly, each for this call only and rolled back with everything else:
--   mcp_settings: the portal secret is a fixture value in portal_secret_prev_sha256 (and in portal_secret_sha256 only
--   when that is empty); enabled = true; connect_requires_cloud = false;
--   mcp_rate_counters rows set just under a bound (so a bound is reached with one or two calls), and one refresh_conn
--   row moved one hour back (the window passing);
--   mcp_oauth_clients rows for the cleanup controls with created_at moved back (registration cannot back-date), and
--   their mcp_connections / mcp_authorization_requests rows (the columns approve and begin write).
-- The app registrations that existed before this call are snapshotted (key, xmin, xmax, ctid) and must come out
-- identical: never deleted, updated or locked.

CREATE TEMP TABLE pb_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.pb_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE pb_fx (k text PRIMARY KEY, v text);
-- the cron jobs before this call (compared, never printed)
CREATE TEMP TABLE pb_cron_before AS SELECT j.jobid, j.jobname, j.schedule, j.command, j.username, j.active FROM cron.job j;
-- the app registrations that exist before anything in this call runs (keys and row versions; never printed)
CREATE TEMP TABLE pb_real AS
  SELECT c.client_id, c.xmin::text AS xmin_t, c.xmax::text AS xmax_t, c.ctid::text AS ctid_t FROM public.mcp_oauth_clients c;
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.pb_fx WHERE pb_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.pb_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;
-- a fixture user id: 00000000-0000-4000-8000-0000426319<n, 2 digits>
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT ('00000000-0000-4000-8000-0000426319' || lpad(n::text, 2, '0'))::uuid $h$;

CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'pb-fixture-portal-secret-' || md5('bounds-harness') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://pb-fixture.example.test/api/mcp' $h$;
-- an app registration id for fixture key k (the format registration enforces)
CREATE FUNCTION pg_temp.cid(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || substr(md5('bounds-harness-client-' || k), 1, 22) $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT pg_temp.cid('main') $h$;
CREATE FUNCTION pg_temp.redir(prov text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE prov WHEN 'anthropic' THEN 'https://claude.ai/api/mcp/auth_callback' ELSE 'https://chatgpt.com/connector_platform_oauth_redirect' END $h$;
-- token digest n (what the portal sends) as a bytea text literal; code digest and verifier of consent k
CREATE FUNCTION pg_temp.dgl(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT '\x' || encode(sha256(convert_to('pb-tok-' || md5('bounds-harness') || n, 'UTF8')), 'hex') $h$;
CREATE FUNCTION pg_temp.cd(k text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('pb-code-' || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.cdl(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.cd(k), 'hex') $h$;
CREATE FUNCTION pg_temp.ver(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'v' || md5(k) || md5(k || 'x') $h$;
-- an address digest for key k (what the register route sends), as bytea, as a bytea literal and as the bucket's hex
CREATE FUNCTION pg_temp.ipd(k text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('pb-ip-' || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.ipl(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.ipd(k), 'hex') $h$;
CREATE FUNCTION pg_temp.iph(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT encode(pg_temp.ipd(k), 'hex') $h$;

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
DECLARE x_bind text := '\x' || encode(sha256(convert_to('pb-bind-' || k, 'UTF8')), 'hex'); x_b jsonb; x_v jsonb; x_a jsonb; x_rid text;
BEGIN
  x_b := pg_temp.w(format('SELECT public.mcp_authorize_begin(%L, %L, %L, %L, %L, %L, %L, NULL, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.client(),
           pg_temp.redir(prov), public._mcp_b64url(sha256(convert_to(pg_temp.ver(k), 'UTF8'))), 'S256', pg_temp.res(), 'mcp:read',
           x_bind, '\x' || encode(sha256(convert_to('pb-cip-' || k, 'UTF8')), 'hex')));
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
-- consent k, then the exchange with access digest at_n and refresh digest rt_n; answers {consent, exchange, conn}
CREATE FUNCTION pg_temp.connect(k text, u uuid, prov text, at_n int, rt_n int) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE x_c jsonb; x_e jsonb; x_id uuid;
BEGIN
  x_c := pg_temp.consent(k, u, prov);
  x_e := pg_temp.w(format('SELECT public.mcp_exchange_code(%L, %L::bytea, %L, %L, %L, %L, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.cdl(k),
           pg_temp.ver(k), pg_temp.client(), pg_temp.redir(prov), pg_temp.res(), pg_temp.dgl(at_n), pg_temp.dgl(rt_n)));
  SELECT x.connection_id INTO x_id FROM public.mcp_authorization_codes x WHERE x.code_sha256 = sha256(pg_temp.cd(k));
  PERFORM pg_temp.put('conn:' || k, x_id::text);
  RETURN jsonb_build_object('consent', x_c ->> 'step', 'exchange', x_e, 'conn', x_id IS NOT NULL);
END $h$;
-- the refresh call (function fn) presenting refresh digest rt_n, asking for new digests at_n / new_rt_n
CREATE FUNCTION pg_temp.q_rf(rt_n int, at_n int, new_rt_n int, fn text DEFAULT 'mcp_refresh', sec_o text DEFAULT NULL,
                             client_o text DEFAULT NULL, res_o text DEFAULT NULL, null_secret boolean DEFAULT false) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.%I(%L, %L::bytea, %L, %L, %L::bytea, %L::bytea)', fn,
                CASE WHEN null_secret THEN NULL ELSE coalesce(sec_o, pg_temp.secret()) END, pg_temp.dgl(rt_n),
                coalesce(client_o, pg_temp.client()), coalesce(res_o, pg_temp.res()), pg_temp.dgl(at_n), pg_temp.dgl(new_rt_n))
$h$;
-- the registration call (function fn) for registration id key ck from address key ik
CREATE FUNCTION pg_temp.q_reg(ck text, ik text, fn text DEFAULT 'mcp_register_client', sec_o text DEFAULT NULL, null_secret boolean DEFAULT false,
                              cid_o text DEFAULT NULL, name_o text DEFAULT NULL, redir_o text[] DEFAULT NULL, ip_o text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.%I(%L, %L, %L, %L::text[], %L::bytea)', fn,
                CASE WHEN null_secret THEN NULL ELSE coalesce(sec_o, pg_temp.secret()) END, coalesce(cid_o, pg_temp.cid(ck)),
                coalesce(name_o, 'Fixture app ' || ck), coalesce(redir_o, ARRAY[pg_temp.redir('anthropic')]), coalesce(ip_o, pg_temp.ipl(ik)))
$h$;
CREATE FUNCTION pg_temp.ok_answer() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT '{"ok":true,"token_type":"Bearer","expires_in":3600,"scope":"mcp:read"}'::jsonb $h$;
CREATE FUNCTION pg_temp.refusal(code text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$ SELECT jsonb_build_object('ok', false, 'error', code) $h$;
CREATE FUNCTION pg_temp.reg_ok(ck text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('ok', true, 'client_id', pg_temp.cid(ck), 'client_name', 'Fixture app ' || ck,
                            'redirect_uris', jsonb_build_array(pg_temp.redir('anthropic'))) $h$;

-- counters: the count of bucket b in the current window of length win; set it (upsert) to n
CREATE FUNCTION pg_temp.cnt(b text, win interval) RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT coalesce((SELECT r.count FROM public.mcp_rate_counters r WHERE r.bucket = b AND r.window_start = public._mcp_window(win)), 0)::bigint $h$;
CREATE FUNCTION pg_temp.rows_of(b text) RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT count(*) FROM public.mcp_rate_counters r WHERE r.bucket = b $h$;
CREATE FUNCTION pg_temp.setc(b text, win interval, n int) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO public.mcp_rate_counters AS rc (bucket, window_start, count) VALUES (b, public._mcp_window(win), n)
  ON CONFLICT (bucket, window_start) DO UPDATE SET count = excluded.count $h$;

-- cleanup fixtures: an app registration created `age` ago; a connection (status st) or an authorization request
-- (status st; expired when exp) naming it
CREATE FUNCTION pg_temp.pclient(k text, age interval) RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256, created_at)
  VALUES (pg_temp.cid(k), 'Fixture app ' || k, ARRAY[pg_temp.redir('anthropic')], pg_temp.ipd('p-' || k), now() - age);
END $h$;
CREATE FUNCTION pg_temp.pconn(k text, st text) RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  INSERT INTO public.mcp_connections (user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (pg_temp.id('B'), pg_temp.cid(k), 'anthropic', 'Fixture app ' || k, pg_temp.redir('anthropic'), pg_temp.res(), 'mcp:read', 1, st,
          CASE WHEN st = 'active' THEN now() END);
END $h$;
CREATE FUNCTION pg_temp.preq(k text, st text, exp boolean) RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  INSERT INTO public.mcp_authorization_requests (id, client_id, redirect_uri, code_challenge, resource, scope, browser_binding_sha256, status, claimed_by, expires_at)
  VALUES (substr(translate(encode(sha256(convert_to('pb-req-' || k || st, 'UTF8')), 'base64'), '+/=', '-_x'), 1, 22), pg_temp.cid(k), pg_temp.redir('anthropic'),
          substr(translate(encode(sha256(convert_to('pb-cc-' || k || st, 'UTF8')), 'base64'), '+/=', '-_x'), 1, 43), pg_temp.res(), 'mcp:read',
          sha256(convert_to('pb-bb-' || k, 'UTF8')), st, CASE WHEN st = 'pending' THEN NULL ELSE pg_temp.id('B') END,
          now() + CASE WHEN exp THEN interval '-1 day' ELSE interval '10 minutes' END);
END $h$;
CREATE FUNCTION pg_temp.has_client(k text) RETURNS boolean LANGUAGE sql STABLE AS $h$
  SELECT EXISTS (SELECT 1 FROM public.mcp_oauth_clients c WHERE c.client_id = pg_temp.cid(k)) $h$;
-- the registrations that existed before this call: how many differ now (gone, updated or locked), by count only
CREATE FUNCTION pg_temp.real_changed() RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT count(*) FROM pg_temp.pb_real b
   WHERE NOT EXISTS (SELECT 1 FROM public.mcp_oauth_clients c
                      WHERE c.client_id = b.client_id AND c.xmin::text = b.xmin_t AND c.xmax::text = b.xmax_t AND c.ctid::text = b.ctid_t) $h$;
-- of those, how many the cleanup's own selection would pick now
CREATE FUNCTION pg_temp.real_selectable() RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT count(*) FROM public.mcp_oauth_clients k JOIN pg_temp.pb_real b ON b.client_id = k.client_id
   WHERE k.created_at < now() - interval '30 days'
     AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)
     AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id) $h$;

-- the tables with a foreign key to mcp_oauth_clients, from the catalogue: with their ON DELETE action
CREATE FUNCTION pg_temp.children() RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce(jsonb_agg(c.relnamespace::regnamespace::text || '.' || c.relname::text || ':' || k.confdeltype::text ORDER BY c.relname::text COLLATE "C"), '[]')
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.contype = 'f' AND k.confrelid = 'public.mcp_oauth_clients'::regclass $h$;

DO $fxb$
DECLARE x_s record;
BEGIN
  PERFORM pg_temp.rec('fx_real_clients', to_jsonb((SELECT count(*) FROM pg_temp.pb_real)));
  PERFORM pg_temp.rec('fx_real_older_than_28d', to_jsonb((SELECT count(*) FROM public.mcp_oauth_clients c WHERE c.created_at < now() - interval '28 days')));
  PERFORM pg_temp.rec('fx_real_without_children', to_jsonb((SELECT count(*) FROM public.mcp_oauth_clients k
     WHERE NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)
       AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id))));
  PERFORM pg_temp.rec('fx_real_with_children', to_jsonb((SELECT count(*) FROM public.mcp_oauth_clients k
     WHERE EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)
        OR EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id))));
  IF EXISTS (SELECT 1 FROM public.mcp_oauth_clients c WHERE c.created_at < now() - interval '28 days') THEN
    RAISE EXCEPTION 'BOUNDS_ABORT: an existing app registration is older than 28 days; the cleanup controls would select it';
  END IF;
  PERFORM pg_temp.rec('fx_cron_jobs_before', to_jsonb((SELECT count(*) FROM cron.job)));

  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.uid(n), 'p4263-bounds-' || substr(md5('bounds-harness'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 2) n;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.put('A', pg_temp.uid(1)::text); PERFORM pg_temp.put('B', pg_temp.uid(2)::text);

  SELECT s.enabled, s.connect_requires_cloud, s.portal_secret_sha256 IS NOT NULL AS has_current INTO x_s FROM public.mcp_settings s WHERE s.id;
  PERFORM pg_temp.rec('fx_settings_before', jsonb_build_object('enabled', x_s.enabled, 'connect_requires_cloud', x_s.connect_requires_cloud,
                                                               'current_secret_set', x_s.has_current));
  UPDATE public.mcp_settings
     SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')),
         portal_secret_sha256 = coalesce(portal_secret_sha256, sha256(convert_to('pb-fixture-current-' || md5('bounds-harness'), 'UTF8'))),
         enabled = true, connect_requires_cloud = false
   WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY[pg_temp.redir('anthropic'), pg_temp.redir('openai')], sha256(convert_to('pb-ip', 'UTF8'))),
         (pg_temp.cid('other'), 'Fixture other app', ARRAY[pg_temp.redir('anthropic')], sha256(convert_to('pb-ip-o', 'UTF8')));
END
$fxb$;
