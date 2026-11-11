-- BACKLOG-4170 PR1 harness prelude: pg_temp helpers, fixtures and the P0 matrix (read BEFORE the
-- migration is applied in this transaction). compose.py puts it after the rollback file and before
-- the migration. Venue: keepr-test ONLY (kt-sql refuses the production ref). One transaction ending
-- in RAISE, so nothing persists.
--
-- Fixtures (invented; ids fx(n) = 00000000-0000-4170-8000-<n>, emails p4170p1-<n>@example.test):
--   roles (synthetic, one key each; 101 holds none)
--     101 none  102 users.view  103 organizations.view  104 organizations.edit  105 audit.view
--     106 plans.view  107 billing.view  108 billing.pricebook  109 support.view (decoy)
--   users 1..9 hold roles 101..109 (user n holds role 100+n); 10 = the real Super Admin role;
--         11 = customer (no internal role); anon = no user, role anon
--   org 601 (customer 11 is a member)
--   admin_audit_logs: one 'billing.solo_trial_updated' row (target_id fx(901)) and one 'p4170p1.other'
--         row (fx(902)); every audit call filters on p_target_id '00000000-0000-4170-8000-00000000090'.
--         target_id is uuid-shaped because the body's join casts target_id::uuid (the planner may
--         evaluate the cast before the target_type = 'user' test).

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-4170-8000-' || lpad(n::text, 12, '0'))::uuid
$b$;

CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $b$;

-- run one statement returning jsonb as a role; the reply as text, or 'ERR <sqlstate> <message>'
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
DECLARE j jsonb;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', r, true);
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

CREATE FUNCTION pg_temp.js(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
BEGIN RETURN s::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(s); END $b$;

CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 400) END
$b$;

-- the six functions under test
CREATE FUNCTION pg_temp.sigs() RETURNS TABLE (k text, sig text) LANGUAGE sql IMMUTABLE AS $b$
  VALUES ('search_users', 'public.admin_search_users(text,integer)'),
         ('get_user_detail', 'public.admin_get_user_detail(uuid)'),
         ('list_organizations', 'public.admin_list_organizations()'),
         ('get_audit_logs', 'public.admin_get_audit_logs(integer,integer,text,text,timestamptz,timestamptz)'),
         ('billing_live', 'public.admin_get_brokerage_billing_live()'),
         ('solo_trial', 'public.admin_get_solo_trial_setting()')
$b$;

-- md5(prosrc) / proacl / proconfig / provolatile of the six, one jsonb
CREATE FUNCTION pg_temp.state() RETURNS jsonb LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(s.k, jsonb_build_object('md5', md5(p.prosrc), 'acl', p.proacl::text,
         'config', p.proconfig::text, 'vol', p.provolatile::text))
    FROM pg_temp.sigs() s JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)
$b$;

-- the cases: one call per function, audit three times (p_action NULL / another action / the trial action)
CREATE FUNCTION pg_temp.cases() RETURNS TABLE (n int, c text, q text) LANGUAGE sql AS $b$
  SELECT * FROM (VALUES
    (1, 'search_users', $q$SELECT to_jsonb(count(*)) FROM public.admin_search_users('P4170p1', 50)$q$),
    (2, 'get_user_detail', format('SELECT public.admin_get_user_detail(%L::uuid)', pg_temp.fx(11))),
    (3, 'list_organizations', $q$SELECT public.admin_list_organizations()$q$),
    (4, 'audit_null', $q$SELECT public.admin_get_audit_logs(50, 0, NULL, '00000000-0000-4170-8000-00000000090')$q$),
    (5, 'audit_other', $q$SELECT public.admin_get_audit_logs(50, 0, 'p4170p1.other', '00000000-0000-4170-8000-00000000090')$q$),
    (6, 'audit_trial', $q$SELECT public.admin_get_audit_logs(50, 0, 'billing.solo_trial_updated', '00000000-0000-4170-8000-00000000090')$q$),
    (7, 'billing_live', $q$SELECT to_jsonb(public.admin_get_brokerage_billing_live())$q$),
    (8, 'solo_trial', $q$SELECT public.admin_get_solo_trial_setting()$q$)
  ) v(n, c, q)
$b$;

-- the callers: (label, user id or NULL, db role)
CREATE FUNCTION pg_temp.callers() RETURNS TABLE (n int, lbl text, u uuid, r text) LANGUAGE sql AS $b$
  SELECT * FROM (VALUES
    (1, 'u0_none', pg_temp.fx(1), 'authenticated'),
    (2, 'u_users.view', pg_temp.fx(2), 'authenticated'),
    (3, 'u_organizations.view', pg_temp.fx(3), 'authenticated'),
    (4, 'u_organizations.edit', pg_temp.fx(4), 'authenticated'),
    (5, 'u_audit.view', pg_temp.fx(5), 'authenticated'),
    (6, 'u_plans.view', pg_temp.fx(6), 'authenticated'),
    (7, 'u_billing.view', pg_temp.fx(7), 'authenticated'),
    (8, 'u_billing.pricebook', pg_temp.fx(8), 'authenticated'),
    (9, 'u_support.view', pg_temp.fx(9), 'authenticated'),
    (10, 'u_sa', pg_temp.fx(10), 'authenticated'),
    (11, 'u_cust', pg_temp.fx(11), 'authenticated'),
    (12, 'anon', NULL::uuid, 'anon')
  ) v(n, lbl, u, r)
$b$;

-- every caller x every case
CREATE FUNCTION pg_temp.matrix() RETURNS TABLE (lbl text, c text, res text) LANGUAGE sql AS $b$
  SELECT cl.lbl, cs.c, pg_temp.call_as(cl.u, cs.q, cl.r)
    FROM pg_temp.callers() cl CROSS JOIN pg_temp.cases() cs ORDER BY cl.n, cs.n
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4170p1-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 11) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4170p1-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4170p1 user ' || x
    FROM generate_series(1, 11) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.admin_roles (id, name, slug, description, is_system)
  SELECT pg_temp.fx(100 + x), 'P4170p1 role ' || x, 'p4170p1-role-' || x, 'fixture', false
    FROM generate_series(1, 9) x;
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(v.n), ap.id
    FROM (VALUES (102, 'users.view'), (103, 'organizations.view'), (104, 'organizations.edit'), (105, 'audit.view'),
                 (106, 'plans.view'), (107, 'billing.view'), (108, 'billing.pricebook'), (109, 'support.view')) AS v(n, k)
    JOIN public.admin_permissions ap ON ap.key = v.k;
  IF (SELECT count(*) FROM public.admin_role_permissions WHERE role_id IN (SELECT pg_temp.fx(100 + x) FROM generate_series(1, 9) x)) <> 8 THEN
    RAISE EXCEPTION 'P4170 fixture: a permission key is missing from admin_permissions';
  END IF;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(x), pg_temp.fx(100 + x) FROM generate_series(1, 9) x;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(10), ar.id FROM public.admin_roles ar WHERE ar.slug = 'super-admin';

  INSERT INTO public.organizations (id, name, slug) VALUES (pg_temp.fx(601), 'P4170p1 org 601', 'p4170p1-org-601');
  ALTER TABLE public.organization_members DISABLE TRIGGER USER;
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by)
  VALUES (pg_temp.fx(601), pg_temp.fx(11), 'agent', 'active', 'manual');

  INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata) VALUES
    (pg_temp.fx(10), 'billing.solo_trial_updated', 'fixture', pg_temp.fx(901)::text, '{}'),
    (pg_temp.fx(10), 'p4170p1.other', 'fixture', pg_temp.fx(902)::text, '{}');
END $b$;

-- ===== fixtures + P0, BEFORE the migration is applied in this transaction =====
DO $p0$
BEGIN
  PERFORM pg_temp.setup();
  CREATE TEMP TABLE p4170p1_p0 AS SELECT * FROM pg_temp.matrix();
  CREATE TEMP TABLE p4170p1_p0_state AS SELECT pg_temp.state() AS st;
END
$p0$;
