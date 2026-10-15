-- BACKLOG-3714 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory):
-- pg_temp.id('<name>') in SQL run as postgres, '{<name>}' inside statements
-- passed to pg_temp.as_role. Output maps ids back to {<name>}.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3714:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['u_self','u_other','u_admin']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3714_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO t3714_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- Run `sql` as p_role ('authenticated' | 'anon' | 'service_role') with the JWT
-- claims PostgREST would set (sub = p_uid, omitted when p_uid is null).
-- Returns 'OK rows=N' or 'ERR <sqlstate> <message>'.
-- The statement's effect is rolled back unless p_keep = true.
CREATE FUNCTION pg_temp.as_role(p_role text, p_uid uuid, p_sql text, p_keep boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_strip_nulls(json_build_object('sub', p_uid, 'role', p_role))::text, true);
    PERFORM set_config('role', p_role, true);
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    PERFORM set_config('role', 'postgres', true);
    IF NOT p_keep THEN RAISE EXCEPTION 't3714_undo' USING DETAIL = msg; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3714_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

-- The whole stored row for a fixture, read as postgres.
CREATE FUNCTION pg_temp.snap(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT to_jsonb(u) FROM public.users u WHERE u.id = pg_temp.id(p_name) $f$;

-- The 16 columns the migration grants UPDATE on to authenticated, and the 23
-- it leaves without. Together they must be every column of public.users
-- (c2 asserts that, so a column added to the table fails the check).
CREATE FUNCTION pg_temp.keep_cols() RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT ARRAY['id','email','first_name','last_name','display_name','avatar_url',
    'last_login_at','updated_at','terms_accepted_at','terms_version_accepted',
    'privacy_policy_accepted_at','privacy_policy_version_accepted',
    'email_onboarding_completed_at','onboarding_completed_at','oauth_provider','oauth_id'] $f$;
CREATE FUNCTION pg_temp.locked_cols() RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT ARRAY['subscription_tier','subscription_status','trial_ends_at',
    'subscription_started_at','status','is_active','created_at','login_count',
    'signup_source','do_not_sell_data','ccpa_opt_out_date','scim_external_id',
    'provisioning_source','is_managed','suspended_at','suspension_reason','sso_only',
    'last_sso_login_at','last_sso_provider','jit_provisioned','jit_provisioned_at',
    'idp_claims','current_onboarding_step'] $f$;

-- Columns of public.users on which p_role holds `p_priv`, sorted.
CREATE FUNCTION pg_temp.priv_cols(p_role text, p_priv text) RETURNS text[] LANGUAGE sql AS $f$
  SELECT coalesce(array_agg(a.attname::text ORDER BY a.attname), '{}')
    FROM pg_attribute a
   WHERE a.attrelid = 'public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege(p_role, 'public.users', a.attname, p_priv) $f$;
CREATE FUNCTION pg_temp.sorted(p text[]) RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM unnest(p) x $f$;
CREATE FUNCTION pg_temp.all_cols() RETURNS text[] LANGUAGE sql AS $f$
  SELECT coalesce(array_agg(attname::text ORDER BY attname), '{}') FROM pg_attribute
   WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped $f$;
-- Columns that carry a column-level ACL (attacl), sorted.
CREATE FUNCTION pg_temp.attacl_cols() RETURNS text[] LANGUAGE sql AS $f$
  SELECT coalesce(array_agg(attname::text ORDER BY attname), '{}') FROM pg_attribute
   WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped
     AND attacl IS NOT NULL AND cardinality(attacl) > 0 $f$;

-- A single-column UPDATE of p_col on the fixture's own row, with a value that
-- differs from the fixture's stored value and satisfies the table's CHECKs.
CREATE FUNCTION pg_temp.set_one(p_col text, p_target text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE t text; v text;
BEGIN
  SELECT udt_name INTO t FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = p_col;
  IF t IS NULL THEN RAISE EXCEPTION 'set_one: no column %', p_col; END IF;
  v := CASE p_col
    WHEN 'subscription_tier'   THEN quote_literal('enterprise')
    WHEN 'subscription_status' THEN quote_literal('active')
    WHEN 'status'              THEN quote_literal('suspended')
    WHEN 'provisioning_source' THEN quote_literal('scim')
    ELSE CASE t
      WHEN 'text'        THEN quote_literal('x3714')
      WHEN 'bool'        THEN format('NOT coalesce(%I, false)', p_col)
      WHEN 'timestamptz' THEN quote_literal('2001-02-03T04:05:06Z')
      WHEN 'int4'        THEN '7777'
      WHEN 'jsonb'       THEN quote_literal('{"x":3714}')
    END END;
  IF v IS NULL THEN RAISE EXCEPTION 'set_one: no value for % (%)', p_col, t; END IF;
  RETURN format('update public.users set %I = %s where id = ''{%s}''', p_col, v, p_target);
END $f$;

-- Sweep: every locked column, one single-column UPDATE each, as p_role
-- (p_uid null for anon). Each statement is KEPT if it succeeds, so a write
-- that lands shows up in the stored row. Per column: PASS only when the
-- result is SQLSTATE 42501 AND u_self's whole stored row is unchanged.
-- A 0-row result does not pass.
CREATE FUNCTION pg_temp.sweep(p_label text, p_role text, p_uid uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c text; m text; before jsonb; n int := 0;
BEGIN
  FOREACH c IN ARRAY pg_temp.locked_cols() LOOP
    before := pg_temp.snap('u_self');
    m := pg_temp.as_role(p_role, p_uid, pg_temp.set_one(c, 'u_self'), true);
    PERFORM pg_temp.check(format('%s: %s refused with 42501, row unchanged', p_label, c),
      m LIKE 'ERR 42501 %' AND pg_temp.snap('u_self') = before, m);
    n := n + 1;
  END LOOP;
  PERFORM pg_temp.check(format('%s: swept 23 columns', p_label), n = 23, n::text);
END $f$;
