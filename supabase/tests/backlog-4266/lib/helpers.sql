-- BACKLOG-4266 harness: helpers (generic; no product table is read here except where marked VOLATILE).
-- Every helper that reads a product table is VOLATILE (the plpgsql/sql default, never STABLE), so it sees the rows
-- written by the statement before it; no helper is called inside the statement of the call it observes.
CREATE TEMP TABLE t66_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.t66_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE t66_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.f(k text) RETURNS text LANGUAGE sql VOLATILE AS $h$ SELECT v FROM pg_temp.t66_fx WHERE t66_fx.k = f.k $h$;
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql VOLATILE AS $h$ SELECT v::uuid FROM pg_temp.t66_fx WHERE t66_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.t66_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;
CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;
-- one statement as an API role with the user's claims, in its own subtransaction; a SELECT returns its single value as
-- text; an error returns 'ERR <sqlstate> <message>'
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
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
END $h$;
CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
BEGIN RETURN t::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(t); END $h$;
CREATE FUNCTION pg_temp.rpc(u uuid, q text) RETURNS jsonb LANGUAGE sql AS $h$ SELECT pg_temp.j(pg_temp.call_as(u, q)) $h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 700), '-') END
$h$;
CREATE FUNCTION pg_temp.all_of(VARIADIC r text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN bool_and(x = 'PASS') THEN 'PASS'
              ELSE 'FAIL: ' || string_agg(CASE WHEN x <> 'PASS' THEN '#' || o || ' ' || x END, ' | ') END
    FROM unnest(r) WITH ORDINALITY t(x, o)
$h$;

-- Rows that exist before this call's fixtures: one md5 of each row's text per table, taken here, before any fixture
-- row exists. pg_temp.foreign_rows() compares them with the tables at the moment it is called: every one of them must
-- still be there, unchanged. No row content is kept or printed; only counts. Not included, because this call changes
-- them on purpose or the product's own cleanup may: the ONE mcp_settings row (the fixtures set the portal secret, then
-- the final RAISE restores it), mcp_rate_counters (_mcp_bump deletes stale buckets), and authorization requests that
-- had already expired when the call began (mcp_authorize_begin deletes those). All of them come back with the RAISE.
CREATE FUNCTION pg_temp.row_hashes() RETURNS TABLE (t text, h text) LANGUAGE sql VOLATILE AS $h$
  SELECT 'ai_app_connect_notices'::text, md5(x::text) FROM public.ai_app_connect_notices x
  UNION ALL SELECT 'mcp_connections', md5(x::text) FROM public.mcp_connections x
  UNION ALL SELECT 'mcp_tokens', md5(x::text) FROM public.mcp_tokens x
  UNION ALL SELECT 'mcp_authorization_codes', md5(x::text) FROM public.mcp_authorization_codes x
  UNION ALL SELECT 'mcp_authorization_requests', md5(x::text) FROM public.mcp_authorization_requests x WHERE x.expires_at >= now()
  UNION ALL SELECT 'mcp_call_log', md5(x::text) FROM public.mcp_call_log x
  UNION ALL SELECT 'mcp_oauth_clients', md5(x::text) FROM public.mcp_oauth_clients x
  UNION ALL SELECT 'auth.users', md5(x::text) FROM auth.users x
$h$;
CREATE TEMP TABLE t66_pre AS SELECT * FROM pg_temp.row_hashes();
CREATE FUNCTION pg_temp.foreign_rows() RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  WITH now_ AS (SELECT * FROM pg_temp.row_hashes()),
       tbls(t) AS (VALUES ('ai_app_connect_notices'), ('mcp_connections'), ('mcp_tokens'), ('mcp_authorization_codes'),
                          ('mcp_authorization_requests'), ('mcp_call_log'), ('mcp_oauth_clients'), ('auth.users'))
  SELECT jsonb_object_agg(b.t, jsonb_build_object(
           'before', (SELECT count(*) FROM pg_temp.t66_pre p WHERE p.t = b.t),
           'gone_or_changed', (SELECT count(*) FROM pg_temp.t66_pre p WHERE p.t = b.t AND NOT EXISTS (SELECT 1 FROM now_ n WHERE n.t = p.t AND n.h = p.h))))
    FROM tbls b
$h$;
