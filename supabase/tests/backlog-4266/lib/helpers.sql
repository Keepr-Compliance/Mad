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
