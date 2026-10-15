-- BACKLOG-3845 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory).

-- Venue check first: _override_effective needs pg_input_is_valid (PG 16+).
DO $v$ BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'BACKLOG-3845 harness: venue is PostgreSQL %, needs 16+', current_setting('server_version');
  END IF;
END $v$;

CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3845:' || p_name)::uuid $f$;
-- u_live:  licensed, personal org (not is_test)         -> the ordinary live customer
-- u_test:  licensed, personal org flagged is_test       -> a test account
-- u_susp:  licensed (licence suspended), personal org
-- u_noorg: no licence, no personal org
-- u_team:  member of the team-plan brokerage t_org (no personal org)
-- t_org:   brokerage on the Team plan; x_org: an is_test brokerage
-- p_ind / p_team: the Individual and Team plans; s_upload: a submission
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_live','u_test','u_susp','u_noorg','u_team','t_org','x_org','p_team','s_upload']) $f$;
CREATE FUNCTION pg_temp.users() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT n FROM pg_temp.id_names() n WHERE n LIKE 'u\_%' $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3845_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3845_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- Outcome of each harness step that may raise.
CREATE TEMP TABLE t3845_step (step text PRIMARY KEY, ok boolean, err text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.step_ok(p_step text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT ok FROM t3845_step WHERE step = p_step $f$;
CREATE FUNCTION pg_temp.step_err(p_step text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(err, '<none>') FROM t3845_step WHERE step = p_step $f$;
CREATE FUNCTION pg_temp.run_step(p_step text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO t3845_step VALUES (p_step, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO t3845_step VALUES (p_step, false, SQLSTATE || ' ' || SQLERRM);
  END;
END $f$;

-- DML without RETURNING cannot be EXECUTEd INTO a variable.
CREATE FUNCTION pg_temp.returns_nothing(p_sql text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
  SELECT p_sql ~* '^\s*(insert|update|delete)\M' AND p_sql !~* '\mreturning\M' $f$;

-- Run one statement (a one-column SELECT, or DML) as p_role with the JWT
-- claims PostgREST would set. Returns 'OK <value>' or 'ERR <sqlstate> <msg>'.
-- A statement that raises is rolled back to the subtransaction.
CREATE FUNCTION pg_temp.as_role(p_role text, p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_strip_nulls(json_build_object('sub', p_uid, 'role', p_role))::text, true);
    PERFORM set_config('role', p_role, true);
    IF pg_temp.returns_nothing(p_sql) THEN EXECUTE p_sql; ELSE EXECUTE p_sql INTO v; END IF;
    msg := 'OK ' || coalesce(v, '<null>');
    PERFORM set_config('role', 'postgres', true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

-- Same, as postgres (service paths, triggers, RPCs called by the service role).
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text; st text;
BEGIN
  BEGIN
    p_sql := pg_temp.subst(p_sql);
    IF pg_temp.returns_nothing(p_sql) THEN EXECUTE p_sql; ELSE EXECUTE p_sql INTO v; END IF;
    RETURN pg_temp.unsubst('OK ' || coalesce(v, '<null>'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RETURN pg_temp.unsubst('ERR ' || st || ' ' || SQLERRM);
  END;
END $f$;

-- Set one feature override on an org (as postgres; bypasses client guards).
CREATE FUNCTION pg_temp.set_override(p_org uuid, p_key text, p_override jsonb) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.organization_plans
     SET feature_overrides = COALESCE(feature_overrides, '{}'::jsonb) || jsonb_build_object(p_key, p_override)
   WHERE organization_id = p_org $f$;
CREATE FUNCTION pg_temp.clear_override(p_org uuid, p_key text) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.organization_plans SET feature_overrides = COALESCE(feature_overrides, '{}'::jsonb) - p_key
   WHERE organization_id = p_org $f$;

-- The three resolvers' answer for (member p_user, org p_org, feature p_key),
-- each run as `authenticated` with p_user's JWT. Value: 'true' / 'false' plus
-- source, or the ERR text when a resolver raised.
CREATE FUNCTION pg_temp.resolve3(p_user uuid, p_org uuid, p_key text)
RETURNS TABLE (resolver text, answer text) LANGUAGE plpgsql AS $f$
BEGIN
  resolver := 'get_org_features';
  answer := pg_temp.as_role('authenticated', p_user, format(
    'SELECT (f->''features''->%L->>''enabled'') || ''/'' || (f->''features''->%L->>''source'') FROM public.get_org_features(%L::uuid) f',
    p_key, p_key, p_org));
  RETURN NEXT;
  resolver := 'broker_get_org_features';
  answer := pg_temp.as_role('authenticated', p_user, format(
    'SELECT (f->''features''->%L->>''enabled'') || ''/'' || (f->''features''->%L->>''source'') FROM public.broker_get_org_features(%L::uuid) f',
    p_key, p_key, p_org));
  RETURN NEXT;
  resolver := 'check_feature_access';
  answer := pg_temp.as_role('authenticated', p_user, format(
    'SELECT (f->>''allowed'') || ''/'' || (f->>''source'') FROM public.check_feature_access(%L::uuid, %L) f',
    p_org, p_key));
  RETURN NEXT;
END $f$;

-- Check all three resolvers return exactly p_expect ('OK true/override' ...).
CREATE FUNCTION pg_temp.check3(p_label text, p_user uuid, p_org uuid, p_key text, p_expect text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_temp.resolve3(p_user, p_org, p_key) LOOP
    PERFORM pg_temp.check(p_label || ' [' || r.resolver || ']', r.answer = p_expect,
                          'got ' || r.answer || ', want ' || p_expect);
  END LOOP;
END $f$;

CREATE FUNCTION pg_temp.porg(p_name text) RETURNS uuid LANGUAGE sql AS $f$
  SELECT o.id FROM public.organizations o WHERE o.personal_owner_user_id = pg_temp.id(p_name) $f$;

-- Fingerprint of everything the rollback must restore.
CREATE FUNCTION pg_temp.fp() RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'resolvers', (SELECT jsonb_object_agg(p.proname, md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || ' ' || coalesce(p.proconfig::text, ''))
                    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                     AND p.proname IN ('get_org_features', 'broker_get_org_features', 'check_feature_access')),
    'columns',   (SELECT jsonb_agg(c.table_name || '.' || c.column_name ORDER BY c.table_name, c.column_name)
                    FROM information_schema.columns c
                   WHERE c.table_schema = 'public' AND c.table_name IN ('stripe_customers', 'payment_intents', 'organizations')),
    'constraints', (SELECT jsonb_agg(conname || ' ' || pg_get_constraintdef(oid) ORDER BY conname)
                      FROM pg_constraint WHERE conrelid IN ('public.stripe_customers'::regclass, 'public.payment_intents'::regclass)),
    'policies',  (SELECT jsonb_agg(tablename || '.' || policyname || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') ORDER BY tablename, policyname)
                    FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('stripe_customers', 'payment_intents')),
    'triggers',  (SELECT coalesce(jsonb_agg(tgname ORDER BY tgname), '[]') FROM pg_trigger
                   WHERE tgrelid IN ('public.stripe_customers'::regclass, 'public.payment_intents'::regclass) AND NOT tgisinternal),
    'new_objects', (SELECT jsonb_build_array(
                      to_regclass('public.billing_subscriptions')::text, to_regclass('public.billing_outbox')::text,
                      to_regprocedure('public._override_effective(jsonb)')::text,
                      to_regprocedure('public._guard_stripe_mode_is_test()')::text,
                      to_regprocedure('public.billing_outbox_claim(text,integer)')::text,
                      to_regprocedure('public.grant_unlimited_from_subscription(uuid,timestamptz,text)')::text,
                      to_regprocedure('public.revoke_unlimited_from_subscription(uuid,text)')::text)))
$f$;
CREATE TEMP TABLE t3845_snap (name text PRIMARY KEY, s jsonb) ON COMMIT DROP;
CREATE FUNCTION pg_temp.snap(p_name text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t3845_snap VALUES (p_name, pg_temp.fp()) ON CONFLICT (name) DO UPDATE SET s = EXCLUDED.s $f$;
CREATE FUNCTION pg_temp.snapshot(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT s FROM t3845_snap WHERE name = p_name $f$;
CREATE FUNCTION pg_temp.diff(a jsonb, b jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(string_agg(k, ','), '<same>') FROM jsonb_object_keys(a) k WHERE a->k IS DISTINCT FROM b->k $f$;

-- Run a call in its OWN statement and keep its result for the next statement.
-- (A state check in the same statement as the call reads the statement's
-- snapshot, taken before the call wrote anything.)
CREATE TEMP TABLE t3845_last (k int PRIMARY KEY, r text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.run(p_sql text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t3845_last VALUES (1, pg_temp.try(p_sql)) ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r $f$;
CREATE FUNCTION pg_temp.last() RETURNS text LANGUAGE sql AS $f$ SELECT r FROM t3845_last WHERE k = 1 $f$;
CREATE FUNCTION pg_temp.overrides(p_org uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT feature_overrides FROM public.organization_plans WHERE organization_id = p_org $f$;
