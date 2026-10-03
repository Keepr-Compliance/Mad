-- BACKLOG-3679 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory):
-- pg_temp.id('<name>') in SQL run as postgres, '{<name>}' inside statements
-- passed to pg_temp.as_role. Output maps ids back to {<name>}.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3679:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_a','u_b','u_c','u_d','u_e','org1','org2','org_pa',
                      'inv_a','inv_d','inv_exp','m_admin1','m_member','m_admin2','m_pa','org_pb','m_pb','m_c_o2']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3679_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;

-- Run `sql` as a client role with JWT claims; return 'OK rows=N', 'OK <value>' or 'ERR <sqlstate> <message>'.
-- The statement's effect is rolled back unless keep = true.
CREATE FUNCTION pg_temp.as_role(p_role text, p_uid uuid, p_email text, p_sql text, p_keep boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', p_role, 'email', p_email)::text, true);
    PERFORM set_config('role', p_role, true);
    IF p_sql ILIKE 'select%' THEN
      EXECUTE 'select (' || substr(p_sql, 8) || ')::text' INTO msg;
      msg := 'OK ' || coalesce(msg, '<null>');
    ELSE
      EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    END IF;
    PERFORM set_config('role', 'postgres', true);
    IF NOT p_keep THEN RAISE EXCEPTION 't3679_undo' USING DETAIL = msg; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3679_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

CREATE FUNCTION pg_temp.as_user(p_uid uuid, p_email text, p_sql text, p_keep boolean DEFAULT false)
RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.as_role('authenticated', p_uid, p_email, p_sql, p_keep) $f$;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3679_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- A refusal is an error or zero rows touched.
CREATE FUNCTION pg_temp.refused(m text) RETURNS boolean LANGUAGE sql AS $f$ SELECT m LIKE 'ERR %' OR m = 'OK rows=0' $f$;

-- Snapshot of a member row as text (as postgres), for unchanged-after checks.
CREATE FUNCTION pg_temp.snap(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT (to_jsonb(m) - 'updated_at')::text FROM public.organization_members m WHERE m.id = p_id $f$;

-- Users
CREATE FUNCTION pg_temp.ua() RETURNS uuid LANGUAGE sql AS $$ SELECT pg_temp.id('u_a') $$;
CREATE FUNCTION pg_temp.ub() RETURNS uuid LANGUAGE sql AS $$ SELECT pg_temp.id('u_b') $$;
CREATE FUNCTION pg_temp.uc() RETURNS uuid LANGUAGE sql AS $$ SELECT pg_temp.id('u_c') $$;
CREATE FUNCTION pg_temp.ud() RETURNS uuid LANGUAGE sql AS $$ SELECT pg_temp.id('u_d') $$;

-- Catalogue fingerprint for the objects 3679 touches.
CREATE FUNCTION pg_temp.fp() RETURNS text LANGUAGE sql AS $f$
  SELECT md5(
    coalesce((SELECT string_agg(concat_ws('|', policyname, cmd, roles::text, permissive, qual, with_check), E'\n' ORDER BY policyname)
              FROM pg_policies WHERE schemaname='public' AND tablename='organization_members'), '') || E'\n#\n' ||
    coalesce((SELECT string_agg(pg_get_triggerdef(oid) || tgenabled::text, E'\n' ORDER BY tgname)
              FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass AND NOT tgisinternal), '') || E'\n#\n' ||
    coalesce((SELECT string_agg(p.oid::regprocedure::text || coalesce(p.proacl::text,''), E'\n')
              FROM pg_proc p WHERE p.proname='guard_invite_acceptance'), '') )
$f$;
