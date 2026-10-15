-- BACKLOG-3856 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory).
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3856:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_susp','u_susp2','u_susp_lic','u_active','u_admin']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3856_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3856_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- Run a one-column SELECT as p_role with the JWT claims PostgREST would set
-- (sub = p_uid, omitted when null). Returns 'OK <value>' or 'ERR <sqlstate> <message>'.
-- Effects are KEPT unless p_keep = false.
CREATE FUNCTION pg_temp.as_role(p_role text, p_uid uuid, p_sql text, p_keep boolean DEFAULT true)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_strip_nulls(json_build_object('sub', p_uid, 'role', p_role))::text, true);
    PERFORM set_config('role', p_role, true);
    EXECUTE p_sql INTO v; msg := 'OK ' || coalesce(v, '<null>');
    PERFORM set_config('role', 'postgres', true);
    IF NOT p_keep THEN RAISE EXCEPTION 't3856_undo' USING DETAIL = msg; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3856_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

-- The stored licence row for a fixture (NULL when none), read as postgres.
CREATE FUNCTION pg_temp.lic(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT to_jsonb(l) FROM public.licenses l WHERE l.user_id = pg_temp.id(p_name) $f$;

CREATE FUNCTION pg_temp.fp() RETURNS text LANGUAGE sql AS $f$
  SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.create_active_individual_license(uuid)'::regprocedure $f$;
