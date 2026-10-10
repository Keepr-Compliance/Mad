-- BACKLOG-3858 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory).
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3858:' || p_name)::uuid $f$;
-- c_*: in the cohort (licence, no membership). m_*: licensed, already a member
-- of the brokerage b_org. d_desk: licensed, personal org made by the desktop
-- path in fixtures. u_nolic: no licence, no membership.
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['c_ind1','c_ind2','c_team','c_susp','c_expinv',
                      'm_active','m_pending','m_susp','d_desk','u_nolic','b_org']) $f$;
CREATE FUNCTION pg_temp.users() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT n FROM pg_temp.id_names() n WHERE n <> 'b_org' $f$;
CREATE FUNCTION pg_temp.cohort() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT n FROM pg_temp.id_names() n WHERE n LIKE 'c\_%' $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP
    p := replace(p, pg_temp.id(n)::text, '{' || n || '}');
    p := replace(p, replace(pg_temp.id(n)::text, '-', ''), '{' || n || '}');
  END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3858_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3858_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- Outcome of each harness step that may raise: step -> ok / error text.
CREATE TEMP TABLE t3858_step (step text PRIMARY KEY, ok boolean, err text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.step_ok(p_step text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT ok FROM t3858_step WHERE step = p_step $f$;
CREATE FUNCTION pg_temp.step_err(p_step text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(err, '<none>') FROM t3858_step WHERE step = p_step $f$;
CREATE FUNCTION pg_temp.run_step(p_step text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO t3858_step VALUES (p_step, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO t3858_step VALUES (p_step, false, SQLSTATE || ' ' || SQLERRM);
  END;
END $f$;

-- Run a one-column SELECT as p_role with the JWT claims PostgREST would set.
-- Returns 'OK <value>' or 'ERR <sqlstate> <message>'. Effects are kept.
CREATE FUNCTION pg_temp.as_role(p_role text, p_uid uuid, p_sql text)
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
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

-- Everything the migration or the rollback could touch, as one comparable
-- value: every row of organizations / organization_members /
-- organization_plans / checklist_templates / checklist_template_items (whole row, ordered by id), plus
-- whether the bookkeeping table exists and its rows.
CREATE FUNCTION pg_temp.state() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb; b jsonb := 'null';
BEGIN
  SELECT jsonb_build_object(
    'organizations',       (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]') FROM public.organizations o),
    'organization_members',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]') FROM public.organization_members m),
    'organization_plans',  (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]') FROM public.organization_plans p),
    'checklist_templates', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM public.checklist_templates t),
    'checklist_template_items', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]') FROM public.checklist_template_items i))
  INTO v;
  IF to_regclass('public.backlog_3858_personal_org_backfill') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.user_id), ''[]'') FROM public.backlog_3858_personal_org_backfill b' INTO b;
  END IF;
  RETURN v || jsonb_build_object('backfill', b);
END $f$;
CREATE TEMP TABLE t3858_snap (name text PRIMARY KEY, s jsonb) ON COMMIT DROP;
CREATE FUNCTION pg_temp.snap(p_name text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t3858_snap VALUES (p_name, pg_temp.state()) $f$;
CREATE FUNCTION pg_temp.snapshot(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT s FROM t3858_snap WHERE name = p_name $f$;
-- Which top-level parts of two states differ (for FAIL details).
CREATE FUNCTION pg_temp.diff(a jsonb, b jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(string_agg(k, ','), '<same>') FROM jsonb_object_keys(a) k WHERE a->k IS DISTINCT FROM b->k $f$;

-- Membership rows of a fixture user (whole rows), and their personal org.
CREATE FUNCTION pg_temp.members_of(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]') FROM public.organization_members m WHERE m.user_id = pg_temp.id(p_name) $f$;
CREATE FUNCTION pg_temp.porg(p_name text) RETURNS uuid LANGUAGE sql AS $f$
  SELECT o.id FROM public.organizations o WHERE o.personal_owner_user_id = pg_temp.id(p_name) $f$;

CREATE FUNCTION pg_temp.fp() RETURNS text LANGUAGE sql AS $f$
  SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._ensure_personal_organization_for(uuid)'::regprocedure $f$;
