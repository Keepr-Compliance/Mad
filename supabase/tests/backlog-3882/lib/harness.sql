-- BACKLOG-3882 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids and tenant ids are derived from names (no id literals in this
-- directory): pg_temp.id('<name>') in SQL run as postgres, '{<name>}' inside
-- statements passed to pg_temp.run_as / run_as_keep. Output maps ids back to
-- {<name>}. Tenant ids are lowercase uuid text, the shape production stores.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3882:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.tid(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT pg_temp.id(p_name)::text $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_a1','u_a2','u_x','u_cons','u_g','u_badmin','u_p','u_inviter',
                      't_a','t_b','t_x','t_p','t_g','org_b','org_p','oid_x','u_r','t_r','org_r']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP
    p := replace(p, '{' || upper(n) || '}', upper(pg_temp.id(n)::text));
    p := replace(p, '{' || n || '}', pg_temp.id(n)::text);
  END LOOP;
  IF p ~ '\{[A-Za-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP
    p := replace(p, pg_temp.id(n)::text, '{' || n || '}');
    p := replace(p, upper(pg_temp.id(n)::text), '{' || upper(n) || '}');
  END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3882_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t3882_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- Run `sql` as a PostgREST caller (p_role 'anon' | 'authenticated' |
-- 'service_role'; p_uid NULL = no subject), with request.jwt.claims set as
-- PostgREST sets it. Returns 'OK <first column of the first row>' or
-- 'ERR <sqlstate> <message>'. run_as undoes the statement's effect;
-- run_as_keep keeps it (the run's outer transaction still rolls back).
CREATE FUNCTION pg_temp.run_impl(p_role text, p_uid uuid, p_sql text, p_keep boolean)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)
           ELSE json_build_object('sub', p_uid, 'role', p_role) END::text, true);
    PERFORM set_config('role', p_role, true);
    EXECUTE p_sql INTO r; msg := 'OK ' || coalesce(r, '<null>');
    PERFORM set_config('role', 'postgres', true);
    IF NOT p_keep THEN RAISE EXCEPTION 't3882_undo' USING DETAIL = msg; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3882_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;
CREATE FUNCTION pg_temp.run_as(p_role text, p_uid uuid, p_sql text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.run_impl(p_role, p_uid, p_sql, false) $f$;
CREATE FUNCTION pg_temp.run_as_keep(p_role text, p_uid uuid, p_sql text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.run_impl(p_role, p_uid, p_sql, true) $f$;

-- provision as an authenticated caller; keeps the effect
CREATE FUNCTION pg_temp.provision(p_uid uuid, p_tenant text, p_keep boolean DEFAULT true) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.run_impl('authenticated', p_uid,
    format('SELECT public.auto_provision_it_admin(%L, %L, %L)::text', p_tenant, 'Fixture Org 3882', 'fixture-org-3882'), p_keep) $f$;

-- check that the result equals p_want, or, when p_want starts with '~',
-- matches that regex.
CREATE FUNCTION pg_temp.want(p_label text, p_got text, p_want text)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_temp.check(p_label,
    CASE WHEN left(p_want, 1) = '~' THEN p_got ~ substr(p_want, 2) ELSE p_got = p_want END,
    'want ' || p_want || ' got ' || coalesce(p_got, '<null>'));
END $f$;

CREATE FUNCTION pg_temp.role_in(p_uid uuid, p_tenant text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce((SELECT m.role::text FROM public.organization_members m
                     JOIN public.organizations o ON o.id = m.organization_id
                    WHERE m.user_id = p_uid AND o.microsoft_tenant_id = p_tenant), '<none>') $f$;
CREATE FUNCTION pg_temp.org_count(p_tenant text) RETURNS text LANGUAGE sql AS $f$
  SELECT count(*)::text FROM public.organizations WHERE lower(microsoft_tenant_id) = lower(p_tenant) $f$;

CREATE FUNCTION pg_temp.fn_md5(p_fn text DEFAULT 'auto_provision_it_admin') RETURNS text LANGUAGE sql AS $f$
  SELECT md5(prosrc) FROM pg_proc WHERE oid = ('public.' || p_fn || '(text,text,text)')::regprocedure $f$;
CREATE FUNCTION pg_temp.can_exec(p_role text, p_fn text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT has_function_privilege(p_role, ('public.' || p_fn || '(text,text,text)')::regprocedure, 'EXECUTE') $f$;
-- PUBLIC holds EXECUTE when the ACL is NULL (default) or has an '=X' entry
CREATE FUNCTION pg_temp.public_exec(p_fn text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
    FROM pg_proc WHERE oid = ('public.' || p_fn || '(text,text,text)')::regprocedure $f$;
CREATE FUNCTION pg_temp.fn_meta(p_fn text) RETURNS text LANGUAGE sql AS $f$
  SELECT 'secdef=' || prosecdef || ' cfg=' || coalesce(proconfig::text, '') || ' ret=' || prorettype::regtype
    FROM pg_proc WHERE oid = ('public.' || p_fn || '(text,text,text)')::regprocedure $f$;
-- exec grants as one string, for before/after comparison
CREATE FUNCTION pg_temp.grants(p_fn text) RETURNS text LANGUAGE sql AS $f$
  SELECT 'public=' || pg_temp.public_exec(p_fn) || ' anon=' || pg_temp.can_exec('anon', p_fn)
      || ' authenticated=' || pg_temp.can_exec('authenticated', p_fn)
      || ' service_role=' || pg_temp.can_exec('service_role', p_fn) $f$;

-- Production values, read 2026-10-10 from the production catalog (SELECT only).
CREATE FUNCTION pg_temp.prod_md5() RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT 'b0541c6347baf9457cf949f5ec5be1e5' $f$;
CREATE FUNCTION pg_temp.new_md5()  RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT 'a88466cc17f1f28a9824ec62c73a2589' $f$;
CREATE FUNCTION pg_temp.google_md5() RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT '621ee65d5283a0224ee05826e5f16eb5' $f$;
CREATE FUNCTION pg_temp.prod_grants() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT 'public=true anon=true authenticated=true service_role=true' $f$;

-- harness: drift. Changes one literal in auto_provision_it_admin's body.
CREATE FUNCTION pg_temp.drift() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d text := pg_get_functiondef('public.auto_provision_it_admin(text,text,text)'::regprocedure);
BEGIN
  IF position('''Not authenticated''' IN d) = 0 THEN RAISE EXCEPTION 'drift: anchor not found'; END IF;
  EXECUTE replace(d, '''Not authenticated''', '''Not authenticated.''');
END $f$;
