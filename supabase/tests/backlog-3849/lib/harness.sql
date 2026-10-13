-- BACKLOG-3849 S4 harness helpers (pg_temp, inside the run's one transaction).
-- No check prints a secret: secret-bearing results are reduced to booleans or
-- lengths before they reach a detail column.

CREATE TEMP TABLE t3849_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3849_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), p_detail) $f$;

CREATE TEMP TABLE t3849_step (step text PRIMARY KEY, ok boolean, err text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.step_ok(p_step text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT ok FROM t3849_step WHERE step = p_step $f$;
CREATE FUNCTION pg_temp.step_err(p_step text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(err, '<none>') FROM t3849_step WHERE step = p_step $f$;
CREATE FUNCTION pg_temp.run_step(p_step text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO t3849_step VALUES (p_step, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO t3849_step VALUES (p_step, false, SQLSTATE || ' ' || SQLERRM);
  END;
END $f$;

-- Run a one-column SELECT as p_role (NULL = stay postgres) with the JWT claims
-- PostgREST would set for p_claim_role. Returns 'OK <value>' or 'ERR <sqlstate> <msg>'.
CREATE FUNCTION pg_temp.as_role(p_role text, p_claim_role text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text; msg text; st text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_strip_nulls(json_build_object('role', p_claim_role))::text, true);
    IF p_role IS NOT NULL THEN PERFORM set_config('role', p_role, true); END IF;
    EXECUTE p_sql INTO v;
    msg := 'OK ' || coalesce(v, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN msg;
END $f$;
