-- BACKLOG-4170 PR4 controls. compose.py order: [applied state] -> rollback -> prelude (fixtures + P0)
-- -> migration TWICE -> this file. Fixtures: see prelude.sql.
-- The rollback, migration, post-md5 and BACKLOG-2345-predecessor placeholders are filled in by compose.py.
-- Output: RAISE 'P4170_RESULT {total, pass, fail, reds}'.

-- keepr-test state of the ten functions (and admin_get_user_detail) before PR4
CREATE FUNCTION pg_temp.base() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
  SELECT jsonb_build_object(
    'suspend', jsonb_build_object('md5', 'c626b20ccdd9e6fc2595b3b33ca07bc6', 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '7df1074bd6f415369eb335bff3ad1781'),
    'unsuspend', jsonb_build_object('md5', '25b70a3e30d2f029a920844097342248', 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '7df1074bd6f415369eb335bff3ad1781'),
    'update_license', jsonb_build_object('md5', 'ab793576ab168fec56e30d428cfc0514', 'acl', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '7df1074bd6f415369eb335bff3ad1781'),
    'adjust_credits', jsonb_build_object('md5', '32260362f3b97ab78b39eb9801510f69', 'acl', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '7df1074bd6f415369eb335bff3ad1781'),
    'reinstate', jsonb_build_object('md5', '8c3026b70a4c7a67d248f15640f3dc78', 'acl', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '7df1074bd6f415369eb335bff3ad1781'),
    'create_license', jsonb_build_object('md5', 'f16cd5585a0d62636a7ac1384fa6073d', 'acl', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '7df1074bd6f415369eb335bff3ad1781'),
    'finalize', jsonb_build_object('md5', 'b6ae1cead90857a8611c70862b569b77', 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '0ed3c263cc20473fc0963c1e9d33adb4'),
    'purchase', jsonb_build_object('md5', 'd44d9c9b68946403230151b958b0a2b3', 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '7df1074bd6f415369eb335bff3ad1781'),
    'refund', jsonb_build_object('md5', '977ff4981212913bb18d0b1f2ff5a1b8', 'acl', '{postgres=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 'v', 'comment', '0047138471f0d0753f469ef1a8a51191'),
    'get_user_detail', jsonb_build_object('md5', 'fe2ed884c110aac7ad0e7075d093cc6c', 'acl', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 'config', '{search_path=public}', 'vol', 's', 'comment', '7df1074bd6f415369eb335bff3ad1781'))
$b$;

-- the proacl each function must hold after PR4, by full string
CREATE FUNCTION pg_temp.post_acl(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE WHEN k IN ('finalize', 'purchase', 'refund') THEN '{postgres=X/postgres,service_role=X/postgres}'
              ELSE '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' END
$b$;

CREATE FUNCTION pg_temp.fn(c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE c WHEN 'suspend' THEN 'admin_suspend_user' WHEN 'unsuspend' THEN 'admin_unsuspend_user'
    WHEN 'update_license' THEN 'admin_update_license' WHEN 'adjust_plus' THEN 'admin_adjust_credits'
    WHEN 'adjust_minus' THEN 'admin_adjust_credits' WHEN 'reinstate' THEN 'reinstate_suspended_account'
    WHEN 'create_other' THEN 'create_active_individual_license' WHEN 'create_self' THEN 'create_active_individual_license'
    WHEN 'finalize' THEN 'finalize_paid_unlock' WHEN 'purchase' THEN 'record_credit_purchase' WHEN 'refund' THEN 'record_refund'
    WHEN 'create_trial' THEN 'create_trial_license' WHEN 'get_user_detail' THEN 'admin_get_user_detail' ELSE 'get_credit_balance' END
$b$;

-- who is allowed each case after PR4
CREATE FUNCTION pg_temp.allowed(c text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE c
    WHEN 'suspend' THEN ARRAY['u_users.suspend', 'u_sa', 'u_sup', 'c_claims']
    WHEN 'unsuspend' THEN ARRAY['u_users.suspend', 'u_sa', 'u_sup', 'c_claims']
    WHEN 'update_license' THEN ARRAY['u_licenses.edit', 'u_sa', 'u_sup', 'u_sales', 'c_claims']
    WHEN 'adjust_plus' THEN ARRAY['u_credits.adjust', 'u_sa', 'u_sup', 'u_sales', 'c_claims']
    WHEN 'adjust_minus' THEN ARRAY['u_credits.adjust', 'u_sa', 'u_sup', 'u_sales', 'c_claims']
    WHEN 'reinstate' THEN ARRAY['u_billing.suspend', 'u_sa', 'u_sup', 'u_sales', 'c_claims']
    WHEN 'create_other' THEN ARRAY['u_licenses.edit', 'u_sa', 'u_sup', 'u_sales', 'svc', 'c_claims']
    WHEN 'create_self' THEN ARRAY['u0_none', 'u_users.suspend', 'u_licenses.edit', 'u_credits.adjust', 'u_billing.suspend',
                                  'u_users.view', 'u_billing.manage', 'u_support.view', 'u_sa', 'u_sup', 'u_sales', 'u_cust', 'c_claims']
    WHEN 'finalize' THEN ARRAY['svc']
    WHEN 'purchase' THEN ARRAY['svc']
    WHEN 'refund' THEN ARRAY['svc']
    WHEN 'create_trial' THEN ARRAY['svc', 'c_claims']
    ELSE ARRAY[]::text[]
  END
$b$;

-- an allowed reply has the function's success shape and its side effect is visible
CREATE FUNCTION pg_temp.ok_reply(lbl text, c text, s text) RETURNS boolean LANGUAGE sql AS $b$
  SELECT CASE c
    WHEN 'suspend' THEN pg_temp.js(pg_temp.rep(s)) ->> 'success' = 'true' AND pg_temp.eff(s) = 'suspended'
    WHEN 'unsuspend' THEN pg_temp.js(pg_temp.rep(s)) ->> 'success' = 'true' AND pg_temp.eff(s) = 'active'
    WHEN 'update_license' THEN pg_temp.js(pg_temp.rep(s)) ->> 'success' = 'true' AND pg_temp.eff(s) = '77'
    WHEN 'adjust_plus' THEN pg_temp.js(pg_temp.rep(s)) ->> 'balance_after' = '15' AND pg_temp.eff(s) = '1'
    WHEN 'adjust_minus' THEN pg_temp.js(pg_temp.rep(s)) ->> 'balance_after' = '9' AND pg_temp.eff(s) = '1'
    WHEN 'reinstate' THEN pg_temp.js(pg_temp.rep(s)) ->> 'reinstated' = 'true' AND pg_temp.eff(s) = 'active'
    WHEN 'create_other' THEN pg_temp.js(pg_temp.rep(s)) ->> 'user_id' = pg_temp.fx(4014)::text AND pg_temp.eff(s) = '1'
    WHEN 'create_self' THEN pg_temp.js(pg_temp.rep(s)) ->> 'user_id' = (SELECT cl.u::text FROM pg_temp.callers() cl WHERE cl.lbl = $1)
                            AND pg_temp.eff(s) = '1'
    WHEN 'finalize' THEN pg_temp.js(pg_temp.rep(s)) ->> 'unlocked' = 'true' AND pg_temp.eff(s) = '1'
    WHEN 'purchase' THEN pg_temp.js(pg_temp.rep(s)) ->> 'ledger_entry_id' IS NOT NULL AND pg_temp.eff(s) = '2'
    WHEN 'refund' THEN pg_temp.js(pg_temp.rep(s)) ->> 'refunded' = 'true'
                       AND pg_temp.js(pg_temp.rep(s)) ->> 'credit_already_consumed' = 'true' AND pg_temp.eff(s) = '1'
    WHEN 'create_trial' THEN pg_temp.js(pg_temp.rep(s)) ->> 'user_id' = pg_temp.fx(4014)::text AND pg_temp.eff(s) = '1'
  END
$b$;

-- the side effect a refused call leaves (nothing written)
CREATE FUNCTION pg_temp.noeff(c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE c WHEN 'suspend' THEN 'active' WHEN 'unsuspend' THEN 'suspended' WHEN 'update_license' THEN '5'
    WHEN 'reinstate' THEN 'suspended' WHEN 'purchase' THEN '1' WHEN 'create_self' THEN '0' ELSE '0' END
$b$;

-- after PR4: 'ALLOWED', 'SAME' (identical to P0, ids masked) or the exact refusal reply
CREATE FUNCTION pg_temp.expect(lbl text, c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE
    WHEN lbl = ANY (pg_temp.allowed(c)) THEN 'ALLOWED'
    WHEN c IN ('balance_other', 'balance_self') THEN 'SAME'
    WHEN c = 'get_user_detail' THEN 'ERR 42883 function public.admin_get_user_detail(uuid) does not exist'
    WHEN c = 'create_self' AND lbl IN ('svc', 'c_noclaims') THEN 'SAME'
    WHEN lbl = 'anon' THEN 'ERR 42501 permission denied for function ' || pg_temp.fn(c)
    WHEN c IN ('finalize', 'purchase', 'refund') AND lbl IN ('c_claims', 'c_noclaims') THEN 'ERR P0001 Unauthorized'
    WHEN c IN ('finalize', 'purchase', 'refund', 'create_trial') AND lbl NOT IN ('svc', 'c_claims', 'c_noclaims')
      THEN 'ERR 42501 permission denied for function ' || pg_temp.fn(c)
    WHEN c IN ('create_other', 'create_trial') THEN 'ERR 42501 Not allowed for this user'
    ELSE 'ERR P0001 Unauthorized'
  END
$b$;

CREATE FUNCTION pg_temp.mask(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT regexp_replace(regexp_replace(s, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'U', 'g'),
                        '\d{4}-\d\d-\d\dT[0-9:.+]+', 'T', 'g')
$b$;

-- the guard IF condition: text between the last IF before the refusal and the refusal
CREATE FUNCTION pg_temp.guard(k text) RETURNS text LANGUAGE sql AS $b$
  WITH p AS (SELECT p.prosrc AS src FROM pg_temp.sigs() s JOIN pg_proc p ON p.oid = to_regprocedure(s.sig) WHERE s.k = $1),
       f AS (SELECT CASE WHEN $1 = 'create_license' THEN 'RAISE EXCEPTION ''Not allowed for this user'''
                         ELSE 'RAISE EXCEPTION ''Unauthorized''' END AS refusal)
  SELECT substring(left(p.src, strpos(p.src, f.refusal) - 1) FROM '.*\mIF\M(.*)$') FROM p, f WHERE strpos(p.src, f.refusal) > 0
$b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; s2 text; g text; x record; ok boolean; e text; n bigint;
  st jsonb; cat jsonb; cat0 jsonb;
  post jsonb := '__POSTMD5__'::jsonb;
  bkey jsonb := jsonb_build_object('suspend', 'users.suspend', 'unsuspend', 'users.suspend', 'update_license', 'licenses.edit',
                                   'adjust_credits', 'credits.adjust', 'reinstate', 'billing.suspend');
BEGIN
  -- ================= P0: the state before PR4 (same transaction, same fixtures) =================
  st := (SELECT p.st FROM p4170p4_p0_state p);
  cat0 := (SELECT p.cat FROM p4170p4_p0_state p);
  r := r || jsonb_build_object('P0_pre_state_is_base', pg_temp.pass(st = pg_temp.base(), st::text));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p4_p0
         WHERE lbl = 'u0_none' AND c IN ('suspend', 'unsuspend', 'update_license', 'adjust_plus', 'adjust_minus', 'reinstate', 'create_other')
           AND NOT coalesce(pg_temp.ok_reply('u0_none', c, res), false));
  r := r || jsonb_build_object('P0_zero_key_internal_runs_every_B_case_before',
    pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p4_p0 WHERE lbl = 'u0_none') = 15, s));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p4_p0
         WHERE lbl = 'u0_none' AND c IN ('finalize', 'purchase') AND NOT coalesce(pg_temp.ok_reply('u0_none', c, res), false));
  r := r || jsonb_build_object('P0_zero_key_internal_runs_finalize_purchase_before', pg_temp.pass(s IS NULL, s));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p4_p0
         WHERE lbl = 'c_claims' AND c IN ('finalize', 'purchase', 'refund') AND NOT coalesce(pg_temp.ok_reply('c_claims', c, res), false));
  r := r || jsonb_build_object('P0_c_claims_passes_C_body_before', pg_temp.pass(s IS NULL, s));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p4_p0
         WHERE lbl = 'c_noclaims' AND c IN ('finalize', 'purchase', 'refund') AND pg_temp.rep(res) = 'ERR P0001 Unauthorized');
  r := r || jsonb_build_object('P0_c_noclaims_passes_C_guard_before',
    pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p4_p0 WHERE lbl = 'c_noclaims' AND c IN ('finalize', 'purchase', 'refund')) = 3, s));
  r := r || jsonb_build_object('P0_catalog_before',
    pg_temp.pass(cat0 ->> 'credits_adjust' = '' AND cat0 -> 'credits_adjust_key' = 'null'::jsonb
                 AND cat0 ->> 'billing_suspend' = 'sales,super-admin', cat0::text));

  -- the synthetic credits.adjust role (the key exists only after the migration)
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(4104), ap.id FROM public.admin_permissions ap WHERE ap.key = 'credits.adjust';
  GET DIAGNOSTICS n = ROW_COUNT;
  r := r || jsonb_build_object('K5_role_4104_granted_credits_adjust', pg_temp.pass(n = 1, n::text));

  -- ================= M: every caller x every case, after PR4 =================
  CREATE TEMP TABLE p4170p4_m AS SELECT * FROM pg_temp.matrix();
  FOR x IN SELECT m.lbl, m.c, m.res, p.res AS res0 FROM p4170p4_m m JOIN p4170p4_p0 p USING (lbl, c) LOOP
    e := pg_temp.expect(x.lbl, x.c);
    IF e = 'ALLOWED' THEN
      ok := pg_temp.ok_reply(x.lbl, x.c, x.res);
    ELSIF e = 'SAME' THEN
      ok := pg_temp.mask(x.res) = pg_temp.mask(x.res0);
      e := 'P0 ' || x.res0;
    ELSIF x.c = 'get_user_detail' THEN
      ok := pg_temp.rep(x.res) = e;
    ELSE
      ok := pg_temp.rep(x.res) = e AND pg_temp.eff(x.res) = CASE WHEN x.c = 'create_self' AND x.lbl = 'u_cust' THEN '1' ELSE pg_temp.noeff(x.c) END;
    END IF;
    r := r || jsonb_build_object('M_' || x.lbl || '_' || x.c, pg_temp.pass(ok, 'expected ' || e || ', got ' || x.res));
  END LOOP;
  r := r || jsonb_build_object('M_count_240', pg_temp.pass((SELECT count(*) FROM p4170p4_m) = 240, (SELECT count(*) FROM p4170p4_m)::text));

  -- ================= B0: Super Admin's B cases succeed before and after =================
  s := (SELECT string_agg(a.c || ': ' || a.res || ' -> ' || b.res, ' ; ') FROM p4170p4_p0 a JOIN p4170p4_m b USING (lbl, c)
         WHERE a.lbl = 'u_sa' AND a.c IN ('suspend', 'unsuspend', 'update_license', 'adjust_plus', 'adjust_minus', 'reinstate', 'create_other', 'create_self')
           AND NOT (coalesce(pg_temp.ok_reply('u_sa', a.c, a.res), false) AND coalesce(pg_temp.ok_reply('u_sa', b.c, b.res), false)));
  r := r || jsonb_build_object('B0_super_admin_B_unchanged', pg_temp.pass(s IS NULL, s));
  -- a credits.adjust-only role: the grant returns its balance (get_credit_balance reads cross-user for it)
  s := (SELECT res FROM p4170p4_m WHERE lbl = 'u_credits.adjust' AND c = 'adjust_plus');
  r := r || jsonb_build_object('B0_credits_adjust_only_gets_balance_after', pg_temp.pass(pg_temp.js(pg_temp.rep(s)) ->> 'balance_after' = '15', s));
  s := (SELECT res FROM p4170p4_m WHERE lbl = 'u_credits.adjust' AND c = 'balance_other');
  r := r || jsonb_build_object('B0_credits_adjust_only_reads_balance_other', pg_temp.pass(pg_temp.rep(s) = '10', s));

  -- ================= K1: guard text =================
  FOR x IN SELECT key AS k, value #>> '{}' AS key FROM jsonb_each(bkey) LOOP
    g := pg_temp.guard(x.k);
    ok := g IS NOT NULL
      AND g ~ 'has_internal_role\('
      AND g ~ '\)\s+OR\s+NOT\s'
      AND NOT g ~ '\mAND\s+NOT\M'
      AND strpos(g, format('public.has_permission(auth.uid(), %L)', x.key)) > 0;
    r := r || jsonb_build_object('K1_guard_' || x.k, pg_temp.pass(ok, coalesce(g, 'no guard found')));
  END LOOP;
  g := pg_temp.guard('create_license');
  ok := g IS NOT NULL
    AND strpos(g, 'COALESCE(auth.role(), '''') <> ''service_role''') > 0
    AND strpos(g, 'p_user_id IS DISTINCT FROM auth.uid()') > 0
    AND regexp_replace(g, '\s+', ' ', 'g') LIKE '%AND NOT (public.has_internal_role(auth.uid()) AND public.has_permission(auth.uid(), ''licenses.edit'')))%';
  r := r || jsonb_build_object('K1_guard_create_license', pg_temp.pass(ok, coalesce(g, 'no guard found')));
  FOR x IN SELECT k FROM (VALUES ('finalize'), ('purchase'), ('refund')) v(k) LOOP
    g := pg_temp.guard(x.k);
    s := (SELECT p.prosrc FROM pg_temp.sigs() sg JOIN pg_proc p ON p.oid = to_regprocedure(sg.sig) WHERE sg.k = x.k);
    ok := btrim(regexp_replace(g, '\s+', ' ', 'g')) = 'COALESCE(auth.role(), '''') <> ''service_role'' THEN'
      AND s !~ '(has_internal_role|internal_roles)';
    r := r || jsonb_build_object('K1_guard_' || x.k, pg_temp.pass(ok, coalesce(g, 'no guard found')));
  END LOOP;
  s := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.record_refund(uuid,text,jsonb)'));
  r := r || jsonb_build_object('K1_refund_keeps_2345_floor',
    pg_temp.pass(strpos(s, 'credit_already_consumed') > 0 AND strpos(s, 'v_refundable := GREATEST(v_purchase_amount - v_debits_drawn, 0);') > 0, left(s, 200)));

  -- ================= K2: proacl per function, by full string =================
  FOR x IN SELECT k, sig FROM pg_temp.sigs() WHERE k <> 'get_user_detail' LOOP
    s := (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig));
    r := r || jsonb_build_object('K2_acl_' || x.k, pg_temp.pass(s = pg_temp.post_acl(x.k), coalesce(s, 'null') || ' vs ' || pg_temp.post_acl(x.k)));
  END LOOP;

  -- ================= K3: applied twice; bodies equal the file; config, volatility, comments =================
  st := pg_temp.state();
  r := r || jsonb_build_object('K3_bodies_equal_file_after_two_applies',
    pg_temp.pass((SELECT bool_and(st -> e2.key ->> 'md5' = e2.value #>> '{}') FROM jsonb_each(post) e2) AND (SELECT count(*) FROM jsonb_object_keys(post)) = 9,
                 st::text || ' vs ' || post::text));
  r := r || jsonb_build_object('K3_config_volatility_unchanged',
    pg_temp.pass((SELECT bool_and(st -> k ->> 'config' = pg_temp.base() -> k ->> 'config' AND st -> k ->> 'vol' = pg_temp.base() -> k ->> 'vol')
                    FROM jsonb_object_keys(post) k), st::text));
  r := r || jsonb_build_object('K3_null_comments_unchanged',
    pg_temp.pass((SELECT bool_and(st -> k ->> 'comment' = pg_temp.base() -> k ->> 'comment')
                    FROM unnest(ARRAY['suspend', 'unsuspend', 'update_license', 'adjust_credits', 'reinstate', 'create_license', 'purchase']) k), st::text));
  s := (SELECT string_agg(obj_description(to_regprocedure(sg.sig), 'pg_proc'), ' || ') FROM pg_temp.sigs() sg WHERE sg.k IN ('finalize', 'refund'));
  r := r || jsonb_build_object('K3_C_comments_service_role_only',
    pg_temp.pass((SELECT bool_and(obj_description(to_regprocedure(sg.sig), 'pg_proc') LIKE '%service_role only%'
                                  AND obj_description(to_regprocedure(sg.sig), 'pg_proc') NOT LIKE '%internal%')
                    FROM pg_temp.sigs() sg WHERE sg.k IN ('finalize', 'refund')), s));

  -- ================= K4: the pre-pin stops =================
  BEGIN
    EXECUTE replace(pg_get_functiondef('public.admin_suspend_user(uuid,text)'::regprocedure), 'BEGIN', 'BEGIN -- drift');
    EXECUTE $mg$__MIGRATION__$mg$;
    RAISE EXCEPTION 'PIN_DONE' USING DETAIL = 'migration applied over a drifted body';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PIN_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K4_pin_stops_on_B_drift', pg_temp.pass(s2 LIKE 'ERR P0001 BACKLOG-4170 PR4: public.admin_suspend_user(uuid,text) body changed%', s2));
  BEGIN
    EXECUTE $c201$__C201__$c201$;
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.record_refund(uuid,text,jsonb)')) <> 'c201419e1dcb0bae2dd34bea95118ef6' THEN
      RAISE EXCEPTION 'PIN_DONE' USING DETAIL = 'the pre-2345 body did not load';
    END IF;
    EXECUTE $mg$__MIGRATION__$mg$;
    RAISE EXCEPTION 'PIN_DONE' USING DETAIL = 'migration applied over the pre-2345 record_refund';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PIN_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K4_pin_stops_on_pre_2345_refund', pg_temp.pass(s2 LIKE 'ERR P0001 BACKLOG-4170 PR4: public.record_refund(uuid,text,jsonb) body changed%', s2));
  BEGIN
    DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261110100000';
    EXECUTE $mg$__MIGRATION__$mg$;
    RAISE EXCEPTION 'PIN_DONE' USING DETAIL = 'migration applied without 20261110100000 recorded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PIN_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K4_pin_stops_without_2345_recorded', pg_temp.pass(s2 LIKE 'ERR P0001 BACKLOG-4170 PR4: migration 20261110100000 (BACKLOG-2345) is not recorded%', s2));

  -- ================= K5: catalog =================
  cat := pg_temp.catalog();
  r := r || jsonb_build_object('K5_catalog',
    pg_temp.pass((cat ->> 'keys')::int = (cat0 ->> 'keys')::int + 1
                 AND (cat ->> 'role_perms')::int = (cat0 ->> 'role_perms')::int + 4
                 AND cat ->> 'credits_adjust' = 'sales,super-admin,support-supervisor'
                 AND cat ->> 'billing_suspend' = 'sales,super-admin,support-supervisor'
                 AND cat -> 'credits_adjust_key' = '{"key": "credits.adjust", "label": "Adjust credits", "category": "billing", "description": "Grant or claw back a user''s credits"}'::jsonb,
                 cat::text || ' vs ' || cat0::text));

  -- ================= K6: admin_get_user_detail dropped =================
  r := r || jsonb_build_object('K6_get_user_detail_absent', pg_temp.pass(to_regprocedure('public.admin_get_user_detail(uuid)') IS NULL, 'present'));

  -- ================= K0: the rollback file restores the pre-PR4 state =================
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s2 := jsonb_build_object('st', pg_temp.state(), 'cat', pg_temp.catalog())::text;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K0_rollback_restores_functions', pg_temp.pass(pg_temp.js(s2) -> 'st' IS NOT DISTINCT FROM pg_temp.base(), s2));
  r := r || jsonb_build_object('K0_rollback_restores_catalog',
    pg_temp.pass(pg_temp.js(s2) -> 'cat' IS NOT DISTINCT FROM cat0, s2 || ' vs ' || cat0::text));
  BEGIN
    EXECUTE replace(pg_get_functiondef('public.create_active_individual_license(uuid)'::regprocedure), 'BEGIN', 'BEGIN -- later change');
    EXECUTE $rb$__ROLLBACK__$rb$;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = 'rollback ran over a later body';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K0_rollback_pin_stops_on_later_body',
    pg_temp.pass(s2 LIKE 'ERR P0001 BACKLOG-4170 PR4 rollback: public.create_active_individual_license(uuid) body is neither%', s2));

  -- ================= KA (applied mode only): keepr-test state before this call equals the file =================
  IF to_regclass('pg_temp.p4170p4_applied') IS NOT NULL THEN
    s2 := (SELECT a.st::text FROM p4170p4_applied a);
    r := r || jsonb_build_object('KA_applied_state_equals_file', pg_temp.pass(s2::jsonb = st, s2 || ' vs ' || st::text));
    s2 := (SELECT a.cat::text FROM p4170p4_applied a);
    r := r || jsonb_build_object('KA_applied_catalog_equals_file', pg_temp.pass(s2::jsonb = cat, s2 || ' vs ' || cat::text));
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
