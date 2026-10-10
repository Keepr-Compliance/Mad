-- BACKLOG-3857 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory):
-- pg_temp.id('<name>') in SQL run as postgres, '{<name>}' inside statements
-- passed to pg_temp.run_as / run_as_keep. Output maps ids back to {<name>}.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3857:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_admin','u_ind','u_team','u_new','u_seed','r_admin','l_ind','l_team']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3857_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t3857_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- Run `sql` as a PostgREST caller (p_role 'anon' | 'authenticated' |
-- 'service_role'; p_uid NULL = no subject). Returns 'OK rows=N' or
-- 'ERR <sqlstate> <message>'. The statement's effect is always undone.
CREATE FUNCTION pg_temp.run_as(p_role text, p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)
           ELSE json_build_object('sub', p_uid, 'role', p_role) END::text, true);
    PERFORM set_config('role', p_role, true);
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    PERFORM set_config('role', 'postgres', true);
    RAISE EXCEPTION 't3857_undo' USING DETAIL = msg;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3857_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

-- Same as run_as, but a successful statement's effect is KEPT (the run's
-- outer transaction still rolls everything back at the end), so a control can
-- read the row afterwards.
CREATE FUNCTION pg_temp.run_as_keep(p_role text, p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)
           ELSE json_build_object('sub', p_uid, 'role', p_role) END::text, true);
    PERFORM set_config('role', p_role, true);
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

-- check that the result equals p_want, or, when p_want starts with '~',
-- matches that regex.
CREATE FUNCTION pg_temp.want(p_label text, p_got text, p_want text)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_temp.check(p_label,
    CASE WHEN left(p_want, 1) = '~' THEN p_got ~ substr(p_want, 2) ELSE p_got = p_want END,
    'want ' || p_want || ' got ' || coalesce(p_got, '<null>'));
END $f$;

CREATE FUNCTION pg_temp.type_check_def() RETURNS text LANGUAGE sql AS $f$
  SELECT pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid = 'public.licenses'::regclass AND conname = 'licenses_license_type_check' $f$;
CREATE FUNCTION pg_temp.col_default(p_col text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(column_default, '<none>') FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'licenses' AND column_name = p_col $f$;
CREATE FUNCTION pg_temp.defaults() RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(c || '=' || pg_temp.col_default(c), '; ' ORDER BY c)
    FROM unnest(ARRAY['license_type','trial_status','trial_started_at','trial_expires_at']) c $f$;
CREATE FUNCTION pg_temp.fn_md5() RETURNS text LANGUAGE sql AS $f$
  SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.admin_update_license(uuid,jsonb)'::regprocedure $f$;
CREATE FUNCTION pg_temp.fn_acl() RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(proacl::text, '<default>') || ' secdef=' || prosecdef || ' cfg=' || coalesce(proconfig::text, '')
    FROM pg_proc WHERE oid = 'public.admin_update_license(uuid,jsonb)'::regprocedure $f$;

-- Production values, read 2026-10-10 from the production catalog (SELECT only)
-- and identical on the NAS venue.
CREATE FUNCTION pg_temp.prod_check_def() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT 'CHECK ((license_type = ANY (ARRAY[''trial''::text, ''individual''::text, ''team''::text])))' $f$;
CREATE FUNCTION pg_temp.new_check_def() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT 'CHECK ((license_type = ANY (ARRAY[''individual''::text, ''team''::text])))' $f$;
CREATE FUNCTION pg_temp.prod_defaults() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT 'license_type=''trial''::text; trial_expires_at=(now() + ''14 days''::interval); trial_started_at=now(); trial_status=''active''::text' $f$;
CREATE FUNCTION pg_temp.new_defaults() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT 'license_type=''individual''::text; trial_expires_at=<none>; trial_started_at=<none>; trial_status=<none>' $f$;
CREATE FUNCTION pg_temp.prod_md5() RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT '7e27a1d38e49eec91def8d2cc584bf3e' $f$;
CREATE FUNCTION pg_temp.new_md5()  RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT 'ab793576ab168fec56e30d428cfc0514' $f$;
CREATE FUNCTION pg_temp.prod_acl() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres} secdef=true cfg={search_path=public}' $f$;

CREATE FUNCTION pg_temp.new_acl() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} secdef=true cfg={search_path=public}' $f$;

-- harness: drift. Changes one literal in admin_update_license's body.
CREATE FUNCTION pg_temp.drift_admin_update_license() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d text := pg_get_functiondef('public.admin_update_license(uuid,jsonb)'::regprocedure);
BEGIN
  IF position('''Unauthorized''' IN d) = 0 THEN RAISE EXCEPTION 'drift: anchor not found'; END IF;
  EXECUTE replace(d, '''Unauthorized''', '''Unauthorised''');
END $f$;
