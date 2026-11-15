-- BACKLOG-4244 harness helpers. Loaded after the migrations, inside the same transaction.
-- Every id, digest, secret, address, name, email and phone is invented. Ids are derived from a value
-- chosen at random for each run (__RUN__, filled by harness.py), so two runs never share an id.

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT md5('p4244:__RUN__:' || n)::uuid
$h$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex')
$h$;
-- the 32-byte value the portal would send for token k
CREATE FUNCTION pg_temp.dg(k text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$
  SELECT sha256(convert_to('p4244:__RUN__:' || k, 'UTF8'))
$h$;
CREATE FUNCTION pg_temp.sec() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '__SECRET__' $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://portal.example.test/api/mcp' $h$;

CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;

-- Run one statement as a role. A SELECT returns its single value as text; any other statement returns
-- '"rows=<n>"'; an error returns 'ERR <sqlstate> <message>'. Own subtransaction.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $h$
DECLARE j jsonb; n bigint;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', r, true);
    EXECUTE format('SET LOCAL ROLE %I', r);
    IF q ~* '^\s*(select|with)\M' THEN
      EXECUTE q INTO j;
    ELSE
      EXECUTE q; GET DIAGNOSTICS n = ROW_COUNT; j := to_jsonb('rows=' || n);
    END IF;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN coalesce(j::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160);
  END;
END $h$;

CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
BEGIN RETURN t::jsonb; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $h$;
-- 'OK' | the error code | the raw text
CREATE FUNCTION pg_temp.err(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(pg_temp.j(t) ->> 'error', CASE WHEN pg_temp.j(t) ->> 'ok' = 'true' OR pg_temp.j(t) ->> 'success' = 'true' THEN 'OK' ELSE left(t, 300) END)
$h$;
CREATE FUNCTION pg_temp.res_of(t text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN pg_temp.j(t) ->> 'ok' = 'true' THEN pg_temp.j(t) -> 'result' END
$h$;
CREATE FUNCTION pg_temp.cid(t text, n int DEFAULT 0) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT (pg_temp.j(t) -> 'results' -> n ->> 'cloud_id')::uuid
$h$;
CREATE FUNCTION pg_temp.st(t text, n int DEFAULT 0) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN pg_temp.j(t) ->> 'ok' = 'true'
              THEN (pg_temp.j(t) -> 'results' -> n ->> 'status') || coalesce(':' || (pg_temp.j(t) -> 'results' -> n ->> 'reason'), '')
              ELSE 'ERROR:' || pg_temp.err(t) END
$h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 600), '-') END
$h$;
-- several checks: PASS when every one is PASS, else the failing ones
CREATE FUNCTION pg_temp.all_of(VARIADIC r text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN bool_and(x = 'PASS') THEN 'PASS'
              ELSE 'FAIL: ' || string_agg(CASE WHEN x <> 'PASS' THEN '#' || o || ' ' || x END, ' | ') END
    FROM unnest(r) WITH ORDINALITY t(x, o)
$h$;

-- Cloud writes as the user (the 13 writes take the user as their first argument)
CREATE FUNCTION pg_temp.onoff(u uuid, en boolean, nv integer DEFAULT 1) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.set_my_cloud_autosave(%L::uuid, %L::boolean, %L::integer)', u, en, nv))
$h$;
CREATE FUNCTION pg_temp.deal(u uuid, payload jsonb) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.cloud_upsert_deal(%L::uuid, %L::jsonb)', u, payload))
$h$;
CREATE FUNCTION pg_temp.up(u uuid, fn text, inst uuid, deal uuid, rows jsonb) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.%I(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)', fn, u, inst, deal, rows))
$h$;
CREATE FUNCTION pg_temp.tomb(u uuid, inst uuid, kind text, ids uuid[]) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.cloud_tombstone(%L::uuid, %L::uuid, %L, %L::uuid[])', u, inst, kind, ids))
$h$;
CREATE FUNCTION pg_temp.mark(u uuid, inst uuid, deal uuid) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', u, inst, deal))
$h$;
CREATE FUNCTION pg_temp.deldeal(u uuid, deal uuid) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.cloud_delete_deal(%L::uuid, %L::uuid)', u, deal))
$h$;
CREATE FUNCTION pg_temp.assign(org uuid, u uuid, on_ boolean) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.assign_member_addon(%L::uuid, %L::uuid, %L, %L::boolean, NULL::timestamptz)',
                                      org, u, 'cloud_autosave', on_), 'service_role')
$h$;

-- An active AI-app connection with access token k for user u (rows written as the database owner).
CREATE FUNCTION pg_temp.conn(u uuid, k text, provider text DEFAULT 'anthropic', expired boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE c uuid := gen_random_uuid(); cl text := 'kpr_c_' || rpad(left(md5('__RUN__' || k), 16), 22, 'x');
BEGIN
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (cl, 'Fixture app ' || k, ARRAY['https://claude.ai/api/mcp/auth_callback'], sha256(convert_to('ip' || k, 'UTF8')));
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (c, u, cl, provider, 'Fixture app ' || k, 'https://claude.ai/api/mcp/auth_callback', pg_temp.res(), 'mcp:read', 1, 'active', now());
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, issued_at, expires_at)
  VALUES (sha256(pg_temp.dg(k)), c, 'access', (SELECT s.pepper_version FROM public.mcp_settings s WHERE s.id),
          CASE WHEN expired THEN now() - interval '2 hours' ELSE now() END,
          CASE WHEN expired THEN now() - interval '1 hour' ELSE now() + interval '1 hour' END);
  RETURN c;
END $h$;

-- Tool calls as anon. Rate counters for calls are cleared first (inside the transaction), so a long
-- control list is not refused by the per-minute limit.
CREATE FUNCTION pg_temp.anon(q text) RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  DELETE FROM public.mcp_rate_counters WHERE bucket LIKE 'call\_%';
  RETURN pg_temp.call_as(NULL, q, 'anon');
END $h$;
CREATE FUNCTION pg_temp.ld(k text, st text DEFAULT NULL, q text DEFAULT NULL, lim integer DEFAULT NULL, cur text DEFAULT NULL,
                           s text DEFAULT '__SECRET__') RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.anon(format('SELECT public.mcp_list_deals(%L, decode(%L, %L), %L, %L, %L, %L::integer, %L)',
         s, encode(pg_temp.dg(k), 'hex'), 'hex', pg_temp.res(), st, q, lim, cur))
$h$;
CREATE FUNCTION pg_temp.gd(k text, id text, s text DEFAULT '__SECRET__') RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.anon(format('SELECT public.mcp_get_deal(%L, decode(%L, %L), %L, %L)',
         s, encode(pg_temp.dg(k), 'hex'), 'hex', pg_temp.res(), id))
$h$;
CREATE FUNCTION pg_temp.gc(k text, id text, only_open boolean DEFAULT NULL, cl text DEFAULT NULL, s text DEFAULT '__SECRET__') RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.anon(format('SELECT public.mcp_get_deal_checklists(%L, decode(%L, %L), %L, %L, %L::boolean, %L)',
         s, encode(pg_temp.dg(k), 'hex'), 'hex', pg_temp.res(), id, only_open, cl))
$h$;
-- deal ids in a list_deals result, in order
CREATE FUNCTION pg_temp.ids(t text) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg((x ->> 'deal_id')::uuid ORDER BY o), ARRAY[]::uuid[])
    FROM jsonb_array_elements(coalesce(pg_temp.res_of(t) -> 'deals', '[]'::jsonb)) WITH ORDINALITY y(x, o)
$h$;
CREATE FUNCTION pg_temp.deal_of(t text, id uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT x FROM jsonb_array_elements(coalesce(pg_temp.res_of(t) -> 'deals', '[]'::jsonb)) x WHERE (x ->> 'deal_id')::uuid = id
$h$;
CREATE FUNCTION pg_temp.keys(o jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg(k ORDER BY k COLLATE "C"), ARRAY[]::text[]) FROM jsonb_object_keys(o) k
$h$;
CREATE FUNCTION pg_temp.nlog(tool text, outcome text) RETURNS bigint LANGUAGE sql AS $h$
  SELECT count(*) FROM public.mcp_call_log l WHERE l.tool = nlog.tool AND l.outcome = nlog.outcome
$h$;
