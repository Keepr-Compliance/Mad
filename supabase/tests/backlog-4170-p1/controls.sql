-- BACKLOG-4170 PR1 controls. compose.py order: [applied state] -> rollback -> prelude (fixtures + P0)
-- -> migration TWICE -> this file. Fixtures: see prelude.sql.
-- The rollback, migration and post-md5 placeholders are filled in by compose.py.
-- Output: RAISE 'P4170_RESULT {total, pass, fail, reds}'.

CREATE FUNCTION pg_temp.prod() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
  SELECT jsonb_build_object(
    'search_users', jsonb_build_object('md5', '3b2bf87eaad57515208cc5cb9e7747ee', 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 's'),
    'get_user_detail', jsonb_build_object('md5', 'e690d13b157f1ec88cd664f59cfacde4', 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 's'),
    'list_organizations', jsonb_build_object('md5', 'cb0100fd0402877d93f02599b18a7a69', 'acl', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v'),
    'get_audit_logs', jsonb_build_object('md5', 'eaf915a01751b05e0da618dbed3a5cd5', 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v'),
    'billing_live', jsonb_build_object('md5', '90a6fabf60de43968c1c3aa84dd083c9', 'acl', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{"search_path=\"\""}', 'vol', 's'),
    'solo_trial', jsonb_build_object('md5', '833a9f7049885faeccdb36a0f03ad543', 'acl', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{"search_path=\"\""}', 'vol', 's'))
$b$;

-- who is allowed each case after PR1
CREATE FUNCTION pg_temp.allowed(c text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE c
    WHEN 'search_users' THEN ARRAY['u_users.view', 'u_sa']
    WHEN 'get_user_detail' THEN ARRAY['u_users.view', 'u_sa']
    WHEN 'list_organizations' THEN ARRAY['u_organizations.view', 'u_sa']
    WHEN 'audit_null' THEN ARRAY['u_audit.view', 'u_sa']
    WHEN 'audit_other' THEN ARRAY['u_audit.view', 'u_sa']
    WHEN 'audit_trial' THEN ARRAY['u_audit.view', 'u_plans.view', 'u_sa']
    WHEN 'billing_live' THEN ARRAY['u_organizations.view', 'u_organizations.edit', 'u_billing.view', 'u_sa']
    WHEN 'solo_trial' THEN ARRAY['u_plans.view', 'u_billing.pricebook', 'u_sa']
  END
$b$;

-- an allowed reply has the function's success shape
CREATE FUNCTION pg_temp.ok_reply(lbl text, c text, s text) RETURNS boolean LANGUAGE sql AS $b$
  SELECT CASE c
    WHEN 'search_users' THEN s = '11'
    -- admin_get_user_detail's production body reads devices.created_at, a column that does not exist
    -- (production and keepr-test); every caller past the guard gets this error. The body is out of
    -- scope for PR1 and copied verbatim, so "allowed" means "reached the body".
    WHEN 'get_user_detail' THEN s = 'ERR 42703 column d.created_at does not exist'
    WHEN 'list_organizations' THEN pg_temp.js(s) ->> 'success' = 'true'
    WHEN 'audit_null' THEN (pg_temp.js(s) ->> 'total') = '2'
    WHEN 'audit_other' THEN (pg_temp.js(s) ->> 'total') = '1' AND pg_temp.js(s) -> 'logs' -> 0 ->> 'action' = 'p4170p1.other'
    WHEN 'audit_trial' THEN (pg_temp.js(s) ->> 'total') = '1' AND pg_temp.js(s) -> 'logs' -> 0 ->> 'action' = 'billing.solo_trial_updated'
    WHEN 'billing_live' THEN s IN ('true', 'false')
    WHEN 'solo_trial' THEN pg_temp.js(s) ? 'enabled'
         AND (pg_temp.js(s) ->> 'can_edit') = (CASE WHEN lbl IN ('u_billing.pricebook', 'u_sa') THEN 'true' ELSE 'false' END)
  END
$b$;

-- the exact refusal each function gave before PR1 (signed-in caller without access), or anon's grant error
CREATE FUNCTION pg_temp.refusal(lbl text, c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE
    WHEN lbl = 'anon' THEN 'ERR 42501 permission denied for function ' || CASE
      WHEN c = 'search_users' THEN 'admin_search_users' WHEN c = 'get_user_detail' THEN 'admin_get_user_detail'
      WHEN c = 'list_organizations' THEN 'admin_list_organizations' WHEN c LIKE 'audit%' THEN 'admin_get_audit_logs'
      WHEN c = 'billing_live' THEN 'admin_get_brokerage_billing_live' ELSE 'admin_get_solo_trial_setting' END
    WHEN c IN ('search_users', 'get_user_detail', 'audit_null', 'audit_other', 'audit_trial')
      THEN 'ERR P0001 Unauthorized: internal role required'
    WHEN c = 'list_organizations' THEN '{"error": "not_authorized", "success": false}'
    ELSE 'ERR 42501 Not authorized'
  END
$b$;

-- the guard IF condition: text between the last IF before the refusal and the refusal
CREATE FUNCTION pg_temp.guard(k text) RETURNS text LANGUAGE sql AS $b$
  WITH p AS (SELECT p.prosrc AS src FROM pg_temp.sigs() s JOIN pg_proc p ON p.oid = to_regprocedure(s.sig) WHERE s.k = $1),
       f AS (SELECT CASE WHEN $1 IN ('search_users', 'get_user_detail', 'get_audit_logs') THEN 'RAISE EXCEPTION ''Unauthorized: internal role required'''
                         WHEN $1 = 'list_organizations' THEN 'RETURN jsonb_build_object(''success'', false'
                         ELSE 'RAISE EXCEPTION ''Not authorized''' END AS refusal)
  SELECT substring(left(p.src, strpos(p.src, f.refusal) - 1) FROM '.*\mIF\M(.*)$') FROM p, f WHERE strpos(p.src, f.refusal) > 0
$b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; s2 text; g text; x record; ok boolean;
  post jsonb := '__POSTMD5__'::jsonb;
  frag jsonb := jsonb_build_object(
    'search_users', jsonb_build_array('public.has_permission(auth.uid(), ''users.view'')'),
    'get_user_detail', jsonb_build_array('public.has_permission(auth.uid(), ''users.view'')'),
    'list_organizations', jsonb_build_array('public.has_permission(auth.uid(), ''organizations.view'')'),
    'get_audit_logs', jsonb_build_array('public.has_permission(auth.uid(), ''audit.view'')',
                                        'p_action IS NOT DISTINCT FROM ''billing.solo_trial_updated''',
                                        'public.has_permission(auth.uid(), ''plans.view'')'),
    'billing_live', jsonb_build_array('public.has_any_permission(v_uid, ARRAY[''organizations.view'', ''organizations.edit'', ''billing.view''])'),
    'solo_trial', jsonb_build_array('public.has_any_permission(v_uid, ARRAY[''plans.view'', ''billing.pricebook''])'));
BEGIN
  -- ================= P0: the state before PR1 (same transaction, same fixtures) =================
  s := (SELECT st::text FROM p4170p1_p0_state);
  r := r || jsonb_build_object('P0_pre_state_is_prod', pg_temp.pass(s::jsonb = pg_temp.prod(), s));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p1_p0 WHERE lbl = 'u0_none' AND NOT pg_temp.ok_reply('u0_none', c, res));
  r := r || jsonb_build_object('P0_zero_key_internal_reads_all_before',
    pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p1_p0 WHERE lbl = 'u0_none') = 8, s));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p1_p0 WHERE lbl = 'anon'
         AND res IS DISTINCT FROM CASE WHEN c IN ('search_users', 'get_user_detail', 'audit_null', 'audit_other', 'audit_trial')
                                       THEN 'ERR P0001 Unauthorized: internal role required' ELSE pg_temp.refusal('anon', c) END);
  r := r || jsonb_build_object('P0_anon_reached_three_bodies_before', pg_temp.pass(s IS NULL, s));

  -- ================= M: every caller x every case, after PR1 =================
  CREATE TEMP TABLE p4170p1_m AS SELECT * FROM pg_temp.matrix();
  FOR x IN SELECT m.lbl, m.c, m.res FROM p4170p1_m m LOOP
    IF x.lbl = ANY (pg_temp.allowed(x.c)) THEN
      ok := pg_temp.ok_reply(x.lbl, x.c, x.res);
    ELSIF x.c = 'list_organizations' AND x.lbl <> 'anon' THEN
      ok := pg_temp.js(x.res) = pg_temp.refusal(x.lbl, x.c)::jsonb;
    ELSE
      ok := x.res = pg_temp.refusal(x.lbl, x.c);
    END IF;
    r := r || jsonb_build_object('M_' || x.lbl || '_' || x.c,
      pg_temp.pass(ok, CASE WHEN x.lbl = ANY (pg_temp.allowed(x.c)) THEN 'expected allowed, got ' ELSE 'expected ' || pg_temp.refusal(x.lbl, x.c) || ', got ' END || x.res));
  END LOOP;
  r := r || jsonb_build_object('M_count_96', pg_temp.pass((SELECT count(*) FROM p4170p1_m) = 96, (SELECT count(*) FROM p4170p1_m)::text));

  -- ================= B0: Super Admin and customer replies identical before and after =================
  s := (SELECT string_agg(a.c || ': ' || a.res || ' -> ' || b.res, ' ; ') FROM p4170p1_p0 a JOIN p4170p1_m b USING (lbl, c)
         WHERE a.lbl = 'u_sa' AND a.res IS DISTINCT FROM b.res);
  r := r || jsonb_build_object('B0_super_admin_unchanged',
    pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p1_m WHERE lbl = 'u_sa') = 8, s));
  s := (SELECT string_agg(a.c || ': ' || a.res || ' -> ' || b.res, ' ; ') FROM p4170p1_p0 a JOIN p4170p1_m b USING (lbl, c)
         WHERE a.lbl = 'u_cust' AND a.res IS DISTINCT FROM b.res);
  r := r || jsonb_build_object('B0_customer_refusal_unchanged',
    pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p1_m WHERE lbl = 'u_cust') = 8, s));

  -- ================= K1: the guard IF line holds the internal check AND the key =================
  FOR x IN SELECT k FROM pg_temp.sigs() LOOP
    g := pg_temp.guard(x.k);
    ok := g IS NOT NULL
      AND g ~ '(has_internal_role\(|internal_roles)'
      AND g ~ '\)\s+OR\s+NOT\s'
      AND NOT g ~ '\mAND\s+NOT\M'
      AND (SELECT bool_and(strpos(g, e) > 0) FROM jsonb_array_elements_text(frag -> x.k) e);
    r := r || jsonb_build_object('K1_guard_' || x.k, pg_temp.pass(ok, coalesce(g, 'no guard found')));
  END LOOP;

  -- ================= K2: grants =================
  FOR x IN SELECT k, sig FROM pg_temp.sigs() LOOP
    ok := NOT has_function_privilege('anon', x.sig, 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure(x.sig) AND a.grantee = 0)
      AND has_function_privilege('authenticated', x.sig, 'EXECUTE')
      AND has_function_privilege('service_role', x.sig, 'EXECUTE');
    r := r || jsonb_build_object('K2_grants_' || x.k, pg_temp.pass(ok, (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(x.sig))));
  END LOOP;

  -- ================= K3: applied twice; bodies equal the file; config and volatility unchanged =================
  s := pg_temp.state()::text;
  r := r || jsonb_build_object('K3_bodies_equal_file_after_two_applies',
    pg_temp.pass((SELECT bool_and(s::jsonb -> e.key ->> 'md5' = e.value #>> '{}') FROM jsonb_each(post) e) AND (SELECT count(*) FROM jsonb_object_keys(post)) = 6, s || ' vs ' || post::text));
  r := r || jsonb_build_object('K3_config_volatility_unchanged',
    pg_temp.pass((SELECT bool_and(s::jsonb -> k ->> 'config' = pg_temp.prod() -> k ->> 'config' AND s::jsonb -> k ->> 'vol' = pg_temp.prod() -> k ->> 'vol')
                    FROM jsonb_object_keys(pg_temp.prod()) k), s));

  -- ================= K4: the pre-pin stops on a changed body =================
  BEGIN
    EXECUTE replace(pg_get_functiondef('public.admin_list_organizations()'::regprocedure), 'BEGIN', 'BEGIN -- drift');
    EXECUTE $mg$__MIGRATION__$mg$;
    RAISE EXCEPTION 'PIN_DONE' USING DETAIL = 'migration applied over a drifted body';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PIN_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K4_pin_stops_on_drift', pg_temp.pass(s2 LIKE 'ERR P0001 BACKLOG-4170 PR1: public.admin_list_organizations() body changed%', s2));

  -- ================= K0: the rollback file restores production md5 / ACL / config / volatility =================
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s2 := pg_temp.state()::text;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K0_rollback_restores_prod', pg_temp.pass(pg_temp.js(s2) = pg_temp.prod(), s2));

  -- ================= KA (applied mode only): keepr-test state before this call equals the file =================
  IF to_regclass('pg_temp.p4170p1_applied') IS NOT NULL THEN
    s2 := (SELECT st::text FROM p4170p1_applied);
    r := r || jsonb_build_object('KA_applied_state_equals_file', pg_temp.pass(s2::jsonb = s::jsonb, s2 || ' vs ' || s));
  END IF;

  RETURN r;
END $f$;

DO $drv$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4170_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
