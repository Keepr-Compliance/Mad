-- BACKLOG-4170 PR4 harness prelude: pg_temp helpers, fixtures and the P0 matrix (read BEFORE the
-- migration is applied in this transaction). compose.py puts it after the rollback file and before
-- the migration. Venue: keepr-test ONLY (kt-sql refuses the production ref). One transaction ending
-- in RAISE, so nothing persists. Every write case runs through pg_temp.rb, which reads the reply and a
-- side-effect query and then raises, so one case never sees another case's writes.
--
-- Fixtures (invented; ids fx(n) = 00000000-0000-4170-8400-<n>, emails p4170p4-<n>@example.test):
--   roles (synthetic, one key each; 4101 holds none; 4104's credits.adjust row is added in
--   controls.sql after the migration creates the key)
--     4101 none  4102 users.suspend  4103 licenses.edit  4104 credits.adjust  4105 billing.suspend
--     4106 users.view  4107 billing.manage (decoy)  4108 support.view (decoy)
--   users 4001..4008 hold roles 4101..4108; 4009 super-admin, 4010 support-supervisor, 4011 sales
--         (the real roles, by slug)
--   4012 customer: active, active license fx(4512), ledger +10 adjustment, one purchase-funded unlock
--        'p4170p4-tx1' (written by finalize_paid_unlock as service_role, so its credit is spent)
--   4013 customer: suspended user, suspended license, one account_suspensions 'suspended' row
--   4014 customer: no license
--   callers also include anon, service_role (svc), a service_role database role carrying an
--   authenticated JWT for user 4009 (c_claims), and postgres with no JWT claims (c_noclaims)

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-4170-8400-' || lpad(n::text, 12, '0'))::uuid
$b$;

CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $b$;

-- run one statement returning jsonb as database role r with JWT role cr (NULL = no claims at all);
-- the reply as text, or 'ERR <sqlstate> <message>'
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text, cr text) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE j jsonb;
BEGIN
  BEGIN
    PERFORM pg_temp.clear_claims();
    IF cr IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', cr)::text, true);
      PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
      PERFORM set_config('request.jwt.claim.role', cr, true);
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE q INTO j;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN coalesce(j::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
END $b$;

-- call_as, then the side-effect query (as the harness owner), then roll both back:
-- returns '<reply> ## <side effect>'
CREATE FUNCTION pg_temp.rb(u uuid, q text, r text, cr text, chk text) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE s text; c text;
BEGIN
  BEGIN
    s := pg_temp.call_as(u, q, r, cr);
    EXECUTE chk INTO c;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s || ' ## ' || coalesce(c, 'null');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 100); END IF;
  END;
  RETURN s;
END $b$;

CREATE FUNCTION pg_temp.js(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
BEGIN RETURN s::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(s); END $b$;

CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 400) END
$b$;

-- reply part / side-effect part of an rb() result
CREATE FUNCTION pg_temp.rep(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$ SELECT split_part(s, ' ## ', 1) $b$;
CREATE FUNCTION pg_temp.eff(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$ SELECT split_part(s, ' ## ', 2) $b$;

-- the ten functions changed by PR4, plus admin_get_user_detail (dropped)
CREATE FUNCTION pg_temp.sigs() RETURNS TABLE (k text, sig text) LANGUAGE sql IMMUTABLE AS $b$
  VALUES ('suspend', 'public.admin_suspend_user(uuid,text)'),
         ('unsuspend', 'public.admin_unsuspend_user(uuid)'),
         ('update_license', 'public.admin_update_license(uuid,jsonb)'),
         ('adjust_credits', 'public.admin_adjust_credits(uuid,integer,text,jsonb)'),
         ('reinstate', 'public.reinstate_suspended_account(uuid,text)'),
         ('create_license', 'public.create_active_individual_license(uuid)'),
         ('finalize', 'public.finalize_paid_unlock(uuid,text,integer,uuid,jsonb)'),
         ('purchase', 'public.record_credit_purchase(uuid,integer,integer,jsonb)'),
         ('refund', 'public.record_refund(uuid,text,jsonb)'),
         ('get_user_detail', 'public.admin_get_user_detail(uuid)')
$b$;

-- md5(prosrc) / proacl / proconfig / provolatile / md5 of the comment, one jsonb ('absent' when dropped)
CREATE FUNCTION pg_temp.state() RETURNS jsonb LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(s.k, CASE WHEN p.oid IS NULL THEN to_jsonb('absent'::text) ELSE jsonb_build_object(
           'md5', md5(p.prosrc), 'acl', p.proacl::text, 'config', p.proconfig::text, 'vol', p.provolatile::text,
           'comment', md5(coalesce(obj_description(p.oid, 'pg_proc'), '<null>'))) END)
    FROM pg_temp.sigs() s LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)
$b$;

-- catalog rows outside the fixture roles: key count, role-permission count, the two key holders
CREATE FUNCTION pg_temp.catalog() RETURNS jsonb LANGUAGE sql AS $b$
  SELECT jsonb_build_object(
    'keys', (SELECT count(*) FROM public.admin_permissions),
    'role_perms', (SELECT count(*) FROM public.admin_role_permissions rp JOIN public.admin_roles r ON r.id = rp.role_id
                    WHERE r.slug NOT LIKE 'p4170p4-%'),
    'credits_adjust', (SELECT coalesce(string_agg(r.slug, ',' ORDER BY r.slug), '') FROM public.admin_role_permissions rp
                         JOIN public.admin_roles r ON r.id = rp.role_id JOIN public.admin_permissions p ON p.id = rp.permission_id
                        WHERE p.key = 'credits.adjust' AND r.slug NOT LIKE 'p4170p4-%'),
    'billing_suspend', (SELECT coalesce(string_agg(r.slug, ',' ORDER BY r.slug), '') FROM public.admin_role_permissions rp
                          JOIN public.admin_roles r ON r.id = rp.role_id JOIN public.admin_permissions p ON p.id = rp.permission_id
                         WHERE p.key = 'billing.suspend' AND r.slug NOT LIKE 'p4170p4-%'),
    'credits_adjust_key', (SELECT row_to_json(x)::jsonb FROM (SELECT key, label, description, category FROM public.admin_permissions
                            WHERE key = 'credits.adjust') x))
$b$;

-- the cases: (n, label, query, side-effect query); ':self' is replaced by the caller's id
CREATE FUNCTION pg_temp.cases() RETURNS TABLE (n int, c text, q text, chk text) LANGUAGE sql AS $b$
  SELECT * FROM (VALUES
    (1, 'suspend', format('SELECT public.admin_suspend_user(%L::uuid, ''p4170p4'')', pg_temp.fx(4012)),
        format('SELECT status FROM public.users WHERE id = %L', pg_temp.fx(4012))),
    (2, 'unsuspend', format('SELECT public.admin_unsuspend_user(%L::uuid)', pg_temp.fx(4013)),
        format('SELECT status FROM public.users WHERE id = %L', pg_temp.fx(4013))),
    (3, 'update_license', format('SELECT public.admin_update_license(%L::uuid, ''{"transaction_limit": 77}''::jsonb)', pg_temp.fx(4512)),
        format('SELECT transaction_limit::text FROM public.licenses WHERE id = %L', pg_temp.fx(4512))),
    (4, 'adjust_plus', format('SELECT public.admin_adjust_credits(%L::uuid, 5, ''p4170p4 grant'')', pg_temp.fx(4012)),
        format('SELECT count(*)::text FROM public.credit_ledger WHERE user_id = %L AND reason = ''p4170p4 grant''', pg_temp.fx(4012))),
    (5, 'adjust_minus', format('SELECT public.admin_adjust_credits(%L::uuid, -1, ''p4170p4 clawback'')', pg_temp.fx(4012)),
        format('SELECT count(*)::text FROM public.credit_ledger WHERE user_id = %L AND reason = ''p4170p4 clawback''', pg_temp.fx(4012))),
    (6, 'reinstate', format('SELECT public.reinstate_suspended_account(%L::uuid, ''p4170p4'')', pg_temp.fx(4013)),
        format('SELECT status FROM public.licenses WHERE user_id = %L', pg_temp.fx(4013))),
    (7, 'create_other', format('SELECT to_jsonb(public.create_active_individual_license(%L::uuid))', pg_temp.fx(4014)),
        format('SELECT count(*)::text FROM public.licenses WHERE user_id = %L', pg_temp.fx(4014))),
    (8, 'create_self', 'SELECT to_jsonb(public.create_active_individual_license(:self))',
        'SELECT count(*)::text FROM public.licenses WHERE user_id = :self'),
    (9, 'balance_other', format('SELECT to_jsonb(public.get_credit_balance(%L::uuid))', pg_temp.fx(4012)), 'SELECT 1::text'),
    (10, 'balance_self', 'SELECT to_jsonb(public.get_credit_balance(:self))', 'SELECT 1::text'),
    (11, 'finalize', format('SELECT public.finalize_paid_unlock(%L::uuid, ''p4170p4-tx2'', 1500, NULL::uuid, ''{}''::jsonb)', pg_temp.fx(4012)),
        format('SELECT count(*)::text FROM public.transaction_unlocks WHERE user_id = %L AND local_transaction_id = ''p4170p4-tx2''', pg_temp.fx(4012))),
    (12, 'purchase', format('SELECT public.record_credit_purchase(%L::uuid, 1, 1500, ''{}''::jsonb)', pg_temp.fx(4012)),
        format('SELECT count(*)::text FROM public.credit_ledger WHERE user_id = %L AND entry_type = ''purchase''', pg_temp.fx(4012))),
    (13, 'refund', format('SELECT public.record_refund(%L::uuid, ''p4170p4-tx1'', ''{}''::jsonb)', pg_temp.fx(4012)),
        format('SELECT count(*)::text FROM public.transaction_unlocks WHERE user_id = %L AND local_transaction_id = ''p4170p4-tx1'' AND refunded_at IS NOT NULL', pg_temp.fx(4012))),
    (14, 'create_trial', format('SELECT to_jsonb(public.create_trial_license(%L::uuid))', pg_temp.fx(4014)),
        format('SELECT count(*)::text FROM public.licenses WHERE user_id = %L', pg_temp.fx(4014))),
    (15, 'get_user_detail', format('SELECT public.admin_get_user_detail(%L::uuid)', pg_temp.fx(4012)), 'SELECT 1::text')
  ) v(n, c, q, chk)
$b$;

-- the callers: (n, label, user id or NULL, database role, JWT role or NULL for no claims)
CREATE FUNCTION pg_temp.callers() RETURNS TABLE (n int, lbl text, u uuid, r text, cr text) LANGUAGE sql AS $b$
  SELECT * FROM (VALUES
    (1, 'u0_none', pg_temp.fx(4001), 'authenticated', 'authenticated'),
    (2, 'u_users.suspend', pg_temp.fx(4002), 'authenticated', 'authenticated'),
    (3, 'u_licenses.edit', pg_temp.fx(4003), 'authenticated', 'authenticated'),
    (4, 'u_credits.adjust', pg_temp.fx(4004), 'authenticated', 'authenticated'),
    (5, 'u_billing.suspend', pg_temp.fx(4005), 'authenticated', 'authenticated'),
    (6, 'u_users.view', pg_temp.fx(4006), 'authenticated', 'authenticated'),
    (7, 'u_billing.manage', pg_temp.fx(4007), 'authenticated', 'authenticated'),
    (8, 'u_support.view', pg_temp.fx(4008), 'authenticated', 'authenticated'),
    (9, 'u_sa', pg_temp.fx(4009), 'authenticated', 'authenticated'),
    (10, 'u_sup', pg_temp.fx(4010), 'authenticated', 'authenticated'),
    (11, 'u_sales', pg_temp.fx(4011), 'authenticated', 'authenticated'),
    (12, 'u_cust', pg_temp.fx(4012), 'authenticated', 'authenticated'),
    (13, 'anon', NULL::uuid, 'anon', 'anon'),
    (14, 'svc', NULL::uuid, 'service_role', 'service_role'),
    (15, 'c_claims', pg_temp.fx(4009), 'service_role', 'authenticated'),
    (16, 'c_noclaims', NULL::uuid, 'postgres', NULL::text)
  ) v(n, lbl, u, r, cr)
$b$;

-- every caller x every case
CREATE FUNCTION pg_temp.matrix() RETURNS TABLE (lbl text, c text, res text) LANGUAGE sql AS $b$
  SELECT cl.lbl, cs.c,
         pg_temp.rb(cl.u, replace(cs.q, ':self', coalesce(quote_literal(cl.u) || '::uuid', 'NULL::uuid')), cl.r, cl.cr,
                    replace(cs.chk, ':self', coalesce(quote_literal(cl.u) || '::uuid', 'NULL::uuid')))
    FROM pg_temp.callers() cl CROSS JOIN pg_temp.cases() cs ORDER BY cl.n, cs.n
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
DECLARE v text;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4170p4-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(4001, 4014) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4170p4-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4170p4 user ' || x
    FROM generate_series(4001, 4014) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
  UPDATE public.users SET status = 'active', suspended_at = NULL WHERE id = pg_temp.fx(4012);
  UPDATE public.users SET status = 'suspended', suspended_at = now(), suspension_reason = 'fixture' WHERE id = pg_temp.fx(4013);

  INSERT INTO public.admin_roles (id, name, slug, description, is_system)
  SELECT pg_temp.fx(x), 'P4170p4 role ' || x, 'p4170p4-role-' || x, 'fixture', false
    FROM generate_series(4101, 4108) x;
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(v.n), ap.id
    FROM (VALUES (4102, 'users.suspend'), (4103, 'licenses.edit'), (4105, 'billing.suspend'), (4106, 'users.view'),
                 (4107, 'billing.manage'), (4108, 'support.view')) AS v(n, k)
    JOIN public.admin_permissions ap ON ap.key = v.k;
  IF (SELECT count(*) FROM public.admin_role_permissions WHERE role_id IN (SELECT pg_temp.fx(x) FROM generate_series(4101, 4108) x)) <> 6 THEN
    RAISE EXCEPTION 'P4170 fixture: a permission key is missing from admin_permissions';
  END IF;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(x), pg_temp.fx(x + 100) FROM generate_series(4001, 4008) x;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(v.u), ar.id FROM (VALUES (4009, 'super-admin'), (4010, 'support-supervisor'), (4011, 'sales')) v(u, slug)
    JOIN public.admin_roles ar ON ar.slug = v.slug;
  IF (SELECT count(*) FROM public.internal_roles WHERE user_id IN (SELECT pg_temp.fx(x) FROM generate_series(4001, 4011) x)) <> 11 THEN
    RAISE EXCEPTION 'P4170 fixture: a real role slug is missing';
  END IF;

  INSERT INTO public.licenses (id, user_id, license_key, license_type, status, transaction_limit)
  VALUES (pg_temp.fx(4512), pg_temp.fx(4012), 'P4170P4-4012', 'individual', 'active', 5),
         (pg_temp.fx(4513), pg_temp.fx(4013), 'P4170P4-4013', 'individual', 'suspended', 5);
  INSERT INTO public.account_suspensions (user_id, event_type, reason, previous_license_status)
  VALUES (pg_temp.fx(4013), 'suspended', 'fixture', 'active');
  INSERT INTO public.credit_ledger (user_id, entry_type, amount, reason)
  VALUES (pg_temp.fx(4012), 'adjustment', 10, 'p4170p4 seed');

  -- one purchase-funded unlock for 4012 (purchase +1, debit -1: its credit is spent)
  v := pg_temp.call_as(NULL, format('SELECT public.finalize_paid_unlock(%L::uuid, ''p4170p4-tx1'', 1500, NULL::uuid, ''{}''::jsonb)', pg_temp.fx(4012)),
                       'service_role', 'service_role');
  IF pg_temp.js(v) ->> 'unlocked' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'P4170 fixture: finalize_paid_unlock seed failed: %', v;
  END IF;
END $b$;

-- ===== fixtures + P0, BEFORE the migration is applied in this transaction =====
DO $p0$
BEGIN
  PERFORM pg_temp.setup();
  CREATE TEMP TABLE p4170p4_p0 AS SELECT * FROM pg_temp.matrix();
  CREATE TEMP TABLE p4170p4_p0_state AS SELECT pg_temp.state() AS st, pg_temp.catalog() AS cat;
END
$p0$;
