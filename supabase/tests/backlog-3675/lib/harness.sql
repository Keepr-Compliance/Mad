-- BACKLOG-3675 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory):
-- pg_temp.id('<name>') in SQL run as postgres, '{<name>}' inside statements
-- passed to pg_temp.as_user. Output maps ids back to {<name>}.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3675:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_owner','u_other','org_p','org_o','m_owner','m_other']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3675_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;

-- Run `sql` as an authenticated user; return 'OK rows=N', 'OK <value>' or 'ERR <sqlstate> <message>'.
-- The statement's effect is rolled back unless keep = true.
CREATE FUNCTION pg_temp.as_user(p_uid uuid, p_sql text, p_keep boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    IF p_sql ILIKE 'select%' THEN
      EXECUTE 'select (' || substr(p_sql, 8) || ')::text' INTO msg;
      msg := 'OK ' || coalesce(msg, '<null>');
    ELSE
      EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    END IF;
    PERFORM set_config('role', 'postgres', true);
    IF NOT p_keep THEN RAISE EXCEPTION 't3675_undo' USING DETAIL = msg; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3675_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3675_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- A refusal is an error or zero rows touched.
CREATE FUNCTION pg_temp.refused(m text) RETURNS boolean LANGUAGE sql AS $f$ SELECT m LIKE 'ERR %' OR m = 'OK rows=0' $f$;

-- get_org_features' entry for the key, read AS the given user (the desktop's call).
CREATE FUNCTION pg_temp.unlimited_as(p_uid uuid, p_org text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_user(p_uid,
    'select public.get_org_features(''{' || p_org || '}'') -> ''features'' -> ''unlimited_transactions''')
$f$;

-- Write an override on a fixture org as postgres (the support / service_role path).
CREATE FUNCTION pg_temp.grant_override(p_org uuid, p_value jsonb) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.organization_plans
     SET feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object('unlimited_transactions', p_value)
   WHERE organization_id = p_org
$f$;
