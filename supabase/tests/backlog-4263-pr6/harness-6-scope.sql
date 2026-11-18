-- harness-6-scope.sql: BACKLOG-4263 PR-6, migration 20261118140000 (mcp_list_my_connections returns `scope`), as ONE
-- call that ends in RAISE (nothing persists). Venue: the test project through ~/.claude/bin/kt-sql; afterwards:
-- select extensions.pg_stat_statements_reset(). Fixtures: two invented users, one invented OAuth client, three
-- invented connections; nothing else is read or written. Records statuses, key sets and counts only.
-- Controls: C1-C6 on the real new body; then three mutants inside the same call (each must turn its control red):
--   M1 no user filter -> C2 red; M2 scope recomputed instead of the stored column -> C5 red; M3 anon granted -> C3 red.
CREATE TEMP TABLE p6s_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.p6s_out (k, v) VALUES (k, v) $h$;
CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$ SELECT md5('p4263:pr6-scope:' || n)::uuid $h$;
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
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN coalesce(j::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'ERR ' || SQLSTATE;
  END;
END $h$;
-- the before-shape (the body this migration replaces): key set of one connection row
CREATE TEMP TABLE p6s_before AS SELECT 1 AS x;

DO $setup$
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr6-scope'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 2) n;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES ('kpr_c_' || substr(md5('pr6-scope-client'), 1, 22), 'Fixture client', ARRAY['https://fixture.example.test/cb'], sha256('x'::bytea));
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, consented_at, activated_at)
  VALUES
    (pg_temp.fx(11), pg_temp.fx(1), 'kpr_c_' || substr(md5('pr6-scope-client'), 1, 22), 'anthropic', 'Fixture A1', 'https://fixture.example.test/cb', 'https://fixture.example.test/mcp', 'mcp:todos', 1, 'active', now() - interval '2 hours', now()),
    (pg_temp.fx(12), pg_temp.fx(1), 'kpr_c_' || substr(md5('pr6-scope-client'), 1, 22), 'openai', 'Fixture A2', 'https://fixture.example.test/cb', 'https://fixture.example.test/mcp', 'mcp:read', 1, 'active', now() - interval '1 hour', now()),
    (pg_temp.fx(21), pg_temp.fx(2), 'kpr_c_' || substr(md5('pr6-scope-client'), 1, 22), 'anthropic', 'Fixture B1', 'https://fixture.example.test/cb', 'https://fixture.example.test/mcp', 'mcp:todos', 1, 'active', now(), now());
  SET LOCAL session_replication_role = origin;
END
$setup$;

DO $before$
DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as(pg_temp.fx(1), 'SELECT public.mcp_list_my_connections()')::jsonb;
  PERFORM pg_temp.rec('B_old_row_keys', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(r -> 'connections' -> 0) k));
  PERFORM pg_temp.rec('B_old_body_md5', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.mcp_list_my_connections()'))));
END
$before$;

-- ============================================================== the migration, verbatim
-- ============================================================================
-- Migration: AI-app connections list the scope each one was granted (BACKLOG-4263 PR-6)
--
-- Replaced: mcp_list_my_connections() (20261112170000 :943-962). The ONLY change: each connection also carries
--   'scope', the stored mcp_connections.scope ('mcp:read' or 'mcp:todos', set once at consent; 20261118130000).
--   It is not recomputed: whether a connection can change todos right now ALSO needs the write switch, which the
--   portal page does not show ("Allowed" is the grant).
-- Caller check unchanged: auth.uid() IS NULL -> not_signed_in; rows WHERE user_id = auth.uid() AND status = 'active'.
-- Grants restated on the full signature: EXECUTE for authenticated only (PUBLIC, anon, service_role revoked).
-- Order: the portal that accepts the answer with or without 'scope' (BACKLOG-4263 PR-6) is deployed FIRST. A portal
--   built before it checks the exact key set and reads the new answer as a failure ("could not load"): never apply
--   this file ahead of that deploy.
-- Pre-check: the body this replaces is the traced one (md5 55da44d56f11890f938b4718a47e0475); otherwise nothing changes.
-- Rollback: supabase/tests/backlog-4263-pr6/rollback-20261118140000.sql.
-- ============================================================================
DO $pre4263p6$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_list_my_connections()');
  IF v_md5 IS DISTINCT FROM '55da44d56f11890f938b4718a47e0475' THEN
    RAISE EXCEPTION '20261118140000: public.mcp_list_my_connections() is not the traced body (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$pre4263p6$;

CREATE OR REPLACE FUNCTION public.mcp_list_my_connections()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  RETURN jsonb_build_object('ok', true, 'connections', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', c.id,
             'client_name', c.client_name,
             'provider', c.provider,
             'redirect_host', substring(c.redirect_uri FROM '^https://([^/]+)'),
             'consented_at', c.consented_at,
             'last_used_at', c.last_used_at,
             'scope', c.scope) ORDER BY c.consented_at DESC)
      FROM public.mcp_connections c
     WHERE c.user_id = v_uid AND c.status = 'active'), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_list_my_connections() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_list_my_connections() TO authenticated;

-- ============================================================== controls
CREATE FUNCTION pg_temp.controls(tag text) RETURNS void LANGUAGE plpgsql AS $h$
DECLARE a jsonb; b jsonb; an text; sr text;
BEGIN
  a := pg_temp.call_as(pg_temp.fx(1), 'SELECT public.mcp_list_my_connections()')::jsonb;
  b := pg_temp.call_as(pg_temp.fx(2), 'SELECT public.mcp_list_my_connections()')::jsonb;
  an := pg_temp.call_as(NULL, 'SELECT public.mcp_list_my_connections()', 'anon');
  sr := pg_temp.call_as(NULL, 'SELECT public.mcp_list_my_connections()', 'service_role');
  PERFORM pg_temp.rec(tag || '_C1_keys', (SELECT jsonb_agg(DISTINCT ks) FROM (SELECT (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(x) k) ks FROM jsonb_array_elements(a -> 'connections') x) z));
  PERFORM pg_temp.rec(tag || '_C2_own_only', to_jsonb(
      (SELECT bool_and(x ->> 'id' IN (pg_temp.fx(11)::text, pg_temp.fx(12)::text)) FROM jsonb_array_elements(a -> 'connections') x)
      AND jsonb_array_length(a -> 'connections') = 2
      AND (SELECT bool_and(x ->> 'id' = pg_temp.fx(21)::text) FROM jsonb_array_elements(b -> 'connections') x)
      AND jsonb_array_length(b -> 'connections') = 1));
  PERFORM pg_temp.rec(tag || '_C3_anon_refused', to_jsonb(an LIKE 'ERR 42501%'));
  PERFORM pg_temp.rec(tag || '_C4_service_role_refused', to_jsonb(sr LIKE 'ERR 42501%'));
  PERFORM pg_temp.rec(tag || '_C5_scope_is_stored', to_jsonb(
      (SELECT bool_and(x ->> 'scope' = (SELECT c.scope FROM public.mcp_connections c WHERE c.id = (x ->> 'id')::uuid)) FROM jsonb_array_elements(a -> 'connections') x)
      AND (SELECT count(*) FROM jsonb_array_elements(a -> 'connections') x WHERE x ->> 'scope' = 'mcp:todos') = 1));
  PERFORM pg_temp.rec(tag || '_C6_signed_out', to_jsonb(pg_temp.call_as(NULL, 'SELECT public.mcp_list_my_connections()')::jsonb ->> 'error'));
  PERFORM pg_temp.rec(tag || '_anon_mcp_count', to_jsonb((SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))));
  PERFORM pg_temp.rec(tag || '_body_md5', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.mcp_list_my_connections()'))));
END $h$;
SELECT pg_temp.controls('REAL');

-- ============================================================== mutants (each must turn its control red)
CREATE OR REPLACE FUNCTION public.mcp_list_my_connections() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $mfn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  RETURN jsonb_build_object('ok', true, 'connections', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', c.id,
             'client_name', c.client_name,
             'provider', c.provider,
             'redirect_host', substring(c.redirect_uri FROM '^https://([^/]+)'),
             'consented_at', c.consented_at,
             'last_used_at', c.last_used_at,
             'scope', c.scope) ORDER BY c.consented_at DESC)
      FROM public.mcp_connections c
     WHERE c.status = 'active'), '[]'::jsonb));
END
$mfn$;
SELECT pg_temp.controls('M1');
CREATE OR REPLACE FUNCTION public.mcp_list_my_connections() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $mfn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  RETURN jsonb_build_object('ok', true, 'connections', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', c.id,
             'client_name', c.client_name,
             'provider', c.provider,
             'redirect_host', substring(c.redirect_uri FROM '^https://([^/]+)'),
             'consented_at', c.consented_at,
             'last_used_at', c.last_used_at,
             'scope', 'mcp:read'::text) ORDER BY c.consented_at DESC)
      FROM public.mcp_connections c
     WHERE c.user_id = v_uid AND c.status = 'active'), '[]'::jsonb));
END
$mfn$;
SELECT pg_temp.controls('M2');
CREATE OR REPLACE FUNCTION public.mcp_list_my_connections() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $mfn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  RETURN jsonb_build_object('ok', true, 'connections', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', c.id,
             'client_name', c.client_name,
             'provider', c.provider,
             'redirect_host', substring(c.redirect_uri FROM '^https://([^/]+)'),
             'consented_at', c.consented_at,
             'last_used_at', c.last_used_at,
             'scope', c.scope) ORDER BY c.consented_at DESC)
      FROM public.mcp_connections c
     WHERE c.user_id = v_uid AND c.status = 'active'), '[]'::jsonb));
END
$mfn$;
GRANT EXECUTE ON FUNCTION public.mcp_list_my_connections() TO anon;
SELECT pg_temp.controls('M3');

DO $end$ BEGIN RAISE EXCEPTION 'P6S_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p6s_out); END $end$;
