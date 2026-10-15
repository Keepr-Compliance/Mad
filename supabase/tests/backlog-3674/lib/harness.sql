-- BACKLOG-3674 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory):
-- pg_temp.id('<name>') in SQL run as postgres, '{<name>}' inside statements
-- passed to pg_temp.as_role / as_user / as_anon. Output maps ids back to {<name>}.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3674:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_a','u_b']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3674_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;

-- Run `sql` as p_role ('authenticated' with p_uid as the JWT subject, or 'anon');
-- return 'OK rows=N', 'OK <value>' or 'ERR <sqlstate> <message>'.
-- The statement's effect is rolled back unless keep = true.
CREATE FUNCTION pg_temp.as_role(p_role text, p_uid uuid, p_sql text, p_keep boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', p_role)::text, true);
    PERFORM set_config('role', p_role, true);
    IF p_sql ILIKE 'select%' THEN
      EXECUTE 'select (' || substr(p_sql, 8) || ')::text' INTO msg;
      msg := 'OK ' || coalesce(msg, '<null>');
    ELSE
      EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    END IF;
    PERFORM set_config('role', 'postgres', true);
    IF NOT p_keep THEN RAISE EXCEPTION 't3674_undo' USING DETAIL = msg; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3674_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;
CREATE FUNCTION pg_temp.as_user(p_uid uuid, p_sql text, p_keep boolean DEFAULT false)
RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.as_role('authenticated', p_uid, p_sql, p_keep) $f$;
CREATE FUNCTION pg_temp.as_anon(p_sql text)
RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.as_role('anon', NULL, p_sql, false) $f$;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3674_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- The desktop app's write (supabaseService.dismissTour), as the SQL PostgREST
-- runs for `.update({ tour_dismissed_at: <client ISO time> }).eq("id", <id>)
-- .is("tour_dismissed_at", null)`. The is-null-guard mutant replaces this.
CREATE FUNCTION pg_temp.app_dismiss(p_target text, p_ts text) RETURNS text LANGUAGE sql AS $f$
  SELECT format('update public.users set tour_dismissed_at = %L where id = %L and tour_dismissed_at is null',
                p_ts, '{' || p_target || '}')
$f$;

-- Count of public.users columns on which p_role holds p_priv (column- or table-level).
-- Uses pg_attribute (by attnum) so has_column_privilege is never evaluated
-- against another table's column name.
CREATE FUNCTION pg_temp.priv_count(p_role text, p_priv text) RETURNS int LANGUAGE sql AS $f$
  SELECT count(*)::int FROM pg_attribute a
   WHERE a.attrelid = 'public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege(p_role, a.attrelid, a.attnum, p_priv)
$f$;
CREATE FUNCTION pg_temp.col_count() RETURNS int LANGUAGE sql AS $f$
  SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'
$f$;
CREATE FUNCTION pg_temp.has_col() RETURNS boolean LANGUAGE sql AS $f$
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'tour_dismissed_at')
$f$;
