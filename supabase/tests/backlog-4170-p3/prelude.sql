-- BACKLOG-4170 PR3 harness prelude: pg_temp helpers, fixtures and the P0 baseline (read BEFORE PR3 is
-- applied in this transaction). compose.py puts it after the rollback file and before the migration.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). One transaction ending in RAISE.
--
-- Fixtures (invented; ids fx(n) = 00000000-0000-4170-8300-<n>, emails p4170p3-<n>@example.test):
--   internal users, one synthetic single-key role each (roles fx(200+k)):
--      1 u0, role 201 with ZERO keys          2 support.view (202), ASSIGNED ticket 301 (requester 5)
--      3 support.view (202), nothing assigned  4 support.admin (203)
--     12 users.view (205)    13 users.edit (206)    14 billing.view (207)     15 audit.view (208)
--     16 roles.view (209)    17 roles.manage (210)  18 internal_users.view (211)
--     19 internal_users.manage (212)  20 analytics.view (213)  21 organizations.view (214)
--     22 plans.view (215)    23 support.manage (216)
--     24 support.admin + analytics.view (217) + support-sla report viewer (SLA write check only)
--     30 the REAL Super Admin role (is_system)
--   customers: 5 requester of 301 (assigned to 2), member of org 601, own rows in every billing table
--              (stripe_customers: one live + one test), own lifecycle event, pending internal
--              invitation addressed to its email
--              6 requester of 302 (unassigned), own billing rows
--   org 601 + organization_plans row; admin_audit_logs, email_delivery_log, email_delivery_queue,
--   individual_invitations: one fixture row each; support_response_templates: one active, one inactive
-- User triggers on the fixture tables except users are disabled inside the transaction
-- (guard_stripe_mode_is_test on keepr-test refuses the live stripe rows).

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-4170-8300-' || lpad(n::text, 12, '0'))::uuid
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
    -- a real session token carries the account email; the own-invitation branch reads it
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r,
      'email', (SELECT au.email FROM auth.users au WHERE au.id = u))::text, true);
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
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
  END;
END $b$;

CREATE FUNCTION pg_temp.js(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
BEGIN RETURN s::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(s); END $b$;

CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 600) END
$b$;

-- the 16 target tables
CREATE FUNCTION pg_temp.targets() RETURNS text[] LANGUAGE sql IMMUTABLE AS $b$
  SELECT ARRAY['account_suspensions','admin_audit_logs','admin_permissions','admin_role_permissions','admin_roles',
               'app_lifecycle_events','credit_ledger','email_delivery_log','email_delivery_queue',
               'individual_invitations','organization_plans','payment_intents','pending_internal_invitations',
               'stripe_customers','support_response_templates','transaction_unlocks']
$b$;

-- n/md5 over every policy on the 16 targets (same expression as the rollback header)
CREATE FUNCTION pg_temp.tdigest() RETURNS text LANGUAGE sql AS $b$
  SELECT count(*) || '/' || md5(string_agg(tablename || policyname || permissive || cmd || roles::text
         || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (pg_temp.targets())
$b$;

-- n/md5 over the support_sla_settings policies (section 18 of the migration)
CREATE FUNCTION pg_temp.depdigest() RETURNS text LANGUAGE sql AS $b$
  SELECT count(*) || '/' || md5(string_agg(tablename || policyname || permissive || cmd || roles::text
         || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'support_sla_settings'
$b$;

-- writes through the inline-join / is_system-join policies, each in a rolled-back subtransaction:
-- support.manage-only / support.view-only update the 2 fixture templates; fixture 24 (support.admin +
-- analytics.view + support-sla report viewer, needed to see the row) updates the SLA row; the Super
-- Admin inserts a role, updates a role and inserts a role permission (the is_system-join policies)
CREATE FUNCTION pg_temp.rb(u uuid, q text, chk text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE s text; n bigint;
BEGIN
  BEGIN
    s := pg_temp.call_as(u, q);
    IF chk IS NOT NULL THEN EXECUTE chk INTO n; s := s || ':' || n; END IF;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  RETURN s;
END $b$;
CREATE FUNCTION pg_temp.writes() RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.rb(pg_temp.fx(23), 'WITH u AS (UPDATE public.support_response_templates SET body = body WHERE name LIKE ''P4170p3%'' RETURNING 1) SELECT to_jsonb(count(*)) FROM u')
    || '|' || pg_temp.rb(pg_temp.fx(3), 'WITH u AS (UPDATE public.support_response_templates SET body = body WHERE name LIKE ''P4170p3%'' RETURNING 1) SELECT to_jsonb(count(*)) FROM u')
    || '|' || pg_temp.rb(pg_temp.fx(24), 'WITH u AS (UPDATE public.support_sla_settings SET time_zone = time_zone RETURNING 1) SELECT to_jsonb(count(*)) FROM u')
    || '|' || pg_temp.rb(pg_temp.fx(30), 'WITH i AS (INSERT INTO public.admin_roles (name, slug, description, is_system) VALUES (''P4170p3 sa-made'', ''p4170p3-sa-made'', ''fixture'', false)) SELECT to_jsonb(0)',
                         'SELECT count(*) FROM public.admin_roles WHERE slug = ''p4170p3-sa-made''')
    || '|' || pg_temp.rb(pg_temp.fx(30), format('WITH u AS (UPDATE public.admin_roles SET description = ''fixture2'' WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM u', pg_temp.fx(201)))
    || '|' || pg_temp.rb(pg_temp.fx(30), format('WITH i AS (INSERT INTO public.admin_role_permissions (role_id, permission_id) SELECT %L, ap.id FROM public.admin_permissions ap WHERE ap.key = ''plans.view'') SELECT to_jsonb(0)', pg_temp.fx(201)),
                         format('SELECT count(*) FROM public.admin_role_permissions WHERE role_id = %L', pg_temp.fx(201)))
$b$;

-- shape of every public policy (name, table, cmd, permissive), no expressions, no roles
CREATE FUNCTION pg_temp.shape() RETURNS text LANGUAGE sql AS $b$
  SELECT count(*) || '/' || md5(string_agg(tablename || policyname || permissive || cmd, ','
         ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public'
$b$;

-- roles of every public policy other than the one PR3 moves to authenticated
CREATE FUNCTION pg_temp.roles_rest() RETURNS text LANGUAGE sql AS $b$
  SELECT count(*) || '/' || md5(string_agg(tablename || policyname || roles::text, ',' ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public'
     AND NOT (tablename = 'email_delivery_log' AND policyname = 'Internal users can read logs')
$b$;

-- TRUNCATE held by anon or authenticated on any target (expected none)
CREATE FUNCTION pg_temp.trunc() RETURNS text LANGUAGE sql AS $b$
  SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), 'none') FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (pg_temp.targets())
     AND (has_table_privilege('anon', c.oid, 'TRUNCATE') OR has_table_privilege('authenticated', c.oid, 'TRUNCATE'))
$b$;

-- per-table count queries over the FIXTURE rows (admin_roles / admin_permissions / admin_role_permissions:
-- the whole table, so own-role vs every-role is visible); the caller runs them through call_as
CREATE FUNCTION pg_temp.parts() RETURNS TABLE (k text, q text) LANGUAGE sql AS $b$
  WITH a AS (SELECT 'ARRAY[' || string_agg(quote_literal(pg_temp.fx(n)), ',') || ']::uuid[]' AS f
               FROM unnest(ARRAY[1,2,3,4,5,6,12,13,14,15,16,17,18,19,20,21,22,23,30]) n)
  SELECT v.k, v.q FROM a, LATERAL (VALUES
    (1, 'account_suspensions', 'SELECT count(*) FROM public.account_suspensions WHERE user_id = ANY (' || f || ')'),
    (2, 'admin_audit_logs', 'SELECT count(*) FROM public.admin_audit_logs WHERE action = ''p4170p3_fixture'''),
    (3, 'admin_permissions', 'SELECT count(*) FROM public.admin_permissions'),
    (4, 'admin_role_permissions', 'SELECT count(*) FROM public.admin_role_permissions'),
    (5, 'admin_roles', 'SELECT count(*) FROM public.admin_roles'),
    (6, 'app_lifecycle_events', 'SELECT count(*) FROM public.app_lifecycle_events WHERE user_id = ANY (' || f || ')'),
    (7, 'credit_ledger', 'SELECT count(*) FROM public.credit_ledger WHERE user_id = ANY (' || f || ')'),
    (8, 'email_delivery_log', 'SELECT count(*) FROM public.email_delivery_log WHERE recipient_email LIKE ''p4170p3-%'''),
    (9, 'email_delivery_queue', 'SELECT count(*) FROM public.email_delivery_queue WHERE recipient_email LIKE ''p4170p3-%'''),
    (10, 'individual_invitations', 'SELECT count(*) FROM public.individual_invitations WHERE invited_email LIKE ''p4170p3-%'''),
    (11, 'organization_plans', 'SELECT count(*) FROM public.organization_plans WHERE organization_id = ' || quote_literal(pg_temp.fx(601))),
    (12, 'payment_intents', 'SELECT count(*) FROM public.payment_intents WHERE user_id = ANY (' || f || ')'),
    (13, 'pending_internal_invitations', 'SELECT count(*) FROM public.pending_internal_invitations WHERE email LIKE ''p4170p3-%'''),
    (14, 'stripe_customers', 'SELECT count(*) FROM public.stripe_customers WHERE user_id = ANY (' || f || ')'),
    (15, 'support_response_templates', 'SELECT count(*) FROM public.support_response_templates WHERE name LIKE ''P4170p3%'''),
    (16, 'transaction_unlocks', 'SELECT count(*) FROM public.transaction_unlocks WHERE user_id = ANY (' || f || ')')
  ) v(n, k, q) ORDER BY v.n
$b$;

-- whole-table count queries (Super Admin vs RLS-bypassed, and the B0 baseline)
CREATE FUNCTION pg_temp.fullparts() RETURNS TABLE (k text, q text) LANGUAGE sql AS $b$
  SELECT t, format('SELECT count(*) FROM public.%I', t) FROM unnest(pg_temp.targets()) t
$b$;

-- one vector, one call per table, so a table whose read fails shows ERR without hiding the rest
CREATE FUNCTION pg_temp.vec(u uuid, r text DEFAULT 'authenticated') RETURNS text LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(p.k, CASE WHEN x.v LIKE 'ERR%' THEN to_jsonb(x.v) ELSE x.v::jsonb END)::text
    FROM pg_temp.parts() p, LATERAL (SELECT pg_temp.call_as(u, 'SELECT to_jsonb((' || p.q || '))', r) v) x
$b$;
CREATE FUNCTION pg_temp.fullvec(u uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(p.k, CASE WHEN x.v LIKE 'ERR%' THEN to_jsonb(x.v) ELSE x.v::jsonb END)::text
    FROM pg_temp.fullparts() p, LATERAL (SELECT pg_temp.call_as(u, 'SELECT to_jsonb((' || p.q || '))') v) x
$b$;

-- the same counts read by the harness role (RLS bypassed)
CREATE FUNCTION pg_temp.allvec() RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE j jsonb := '{}'; p record; n bigint;
BEGIN
  FOR p IN SELECT * FROM pg_temp.parts() LOOP EXECUTE p.q INTO n; j := j || jsonb_build_object(p.k, n); END LOOP;
  RETURN j;
END $b$;
CREATE FUNCTION pg_temp.allfull() RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE j jsonb := '{}'; p record; n bigint;
BEGIN
  FOR p IN SELECT * FROM pg_temp.fullparts() LOOP EXECUTE p.q INTO n; j := j || jsonb_build_object(p.k, n); END LOOP;
  RETURN j;
END $b$;

-- expected vector: keys in p take their value ('all' = every fixture row); others 0
CREATE FUNCTION pg_temp.expect(p jsonb) RETURNS text LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(k, CASE WHEN p ->> k = 'all' THEN a -> k WHEN p ? k THEN p -> k ELSE '0'::jsonb END)::text
    FROM (SELECT pg_temp.allvec() a) s, jsonb_object_keys(s.a) k
$b$;

-- every target 'all'
CREATE FUNCTION pg_temp.everything() RETURNS jsonb LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(t, 'all') FROM unnest(pg_temp.targets()) t
$b$;

-- the sweep: (label, uid, role)
CREATE FUNCTION pg_temp.callers() RETURNS TABLE (lbl text, u uuid, r text) LANGUAGE sql AS $b$
  SELECT v.l, CASE WHEN v.n IS NULL THEN NULL ELSE pg_temp.fx(v.n) END, v.r FROM (VALUES
    ('u0', 1, 'authenticated'), ('support.view_assigned', 2, 'authenticated'),
    ('support.view_unassigned', 3, 'authenticated'), ('support.admin', 4, 'authenticated'),
    ('users.view', 12, 'authenticated'), ('users.edit', 13, 'authenticated'), ('billing.view', 14, 'authenticated'),
    ('audit.view', 15, 'authenticated'), ('roles.view', 16, 'authenticated'), ('roles.manage', 17, 'authenticated'),
    ('internal_users.view', 18, 'authenticated'), ('internal_users.manage', 19, 'authenticated'),
    ('analytics.view', 20, 'authenticated'), ('organizations.view', 21, 'authenticated'),
    ('plans.view', 22, 'authenticated'), ('support.manage', 23, 'authenticated'), ('u_sa', 30, 'authenticated'),
    ('u_cust', 5, 'authenticated'), ('u_cust2', 6, 'authenticated'), ('anon', NULL, 'anon')
  ) v(l, n, r)
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  ALTER TABLE public.support_tickets DISABLE TRIGGER USER;
  ALTER TABLE public.organizations DISABLE TRIGGER USER;
  ALTER TABLE public.organization_members DISABLE TRIGGER USER;
  ALTER TABLE public.organization_plans DISABLE TRIGGER USER;
  ALTER TABLE public.stripe_customers DISABLE TRIGGER USER;
  ALTER TABLE public.payment_intents DISABLE TRIGGER USER;

  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4170p3-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM unnest(ARRAY[1,2,3,4,5,6,12,13,14,15,16,17,18,19,20,21,22,23,24,30]) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4170p3-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4170p3 user ' || x
    FROM unnest(ARRAY[1,2,3,4,5,6,12,13,14,15,16,17,18,19,20,21,22,23,24,30]) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.admin_roles (id, name, slug, description, is_system)
  SELECT pg_temp.fx(v.n), 'P4170p3 ' || v.k, 'p4170p3-' || replace(v.k, '.', '-'), 'fixture', false
    FROM (VALUES (201, 'none'), (202, 'support.view'), (203, 'support.admin'), (205, 'users.view'),
                 (206, 'users.edit'), (207, 'billing.view'), (208, 'audit.view'), (209, 'roles.view'),
                 (210, 'roles.manage'), (211, 'internal_users.view'), (212, 'internal_users.manage'),
                 (213, 'analytics.view'), (214, 'organizations.view'), (215, 'plans.view'),
                 (216, 'support.manage')) v(n, k);
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(v.n), ap.id
    FROM (VALUES (202, 'support.view'), (203, 'support.admin'), (205, 'users.view'), (206, 'users.edit'),
                 (207, 'billing.view'), (208, 'audit.view'), (209, 'roles.view'), (210, 'roles.manage'),
                 (211, 'internal_users.view'), (212, 'internal_users.manage'), (213, 'analytics.view'),
                 (214, 'organizations.view'), (215, 'plans.view'), (216, 'support.manage')) v(n, k)
    JOIN public.admin_permissions ap ON ap.key = v.k;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(v.u), pg_temp.fx(v.r)
    FROM (VALUES (1, 201), (2, 202), (3, 202), (4, 203), (12, 205), (13, 206), (14, 207), (15, 208), (16, 209),
                 (17, 210), (18, 211), (19, 212), (20, 213), (21, 214), (22, 215), (23, 216)) v(u, r);
  INSERT INTO public.admin_roles (id, name, slug, description, is_system)
    VALUES (pg_temp.fx(217), 'P4170p3 sla admin', 'p4170p3-sla-admin', 'fixture', false);
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(217), ap.id FROM public.admin_permissions ap WHERE ap.key IN ('support.admin', 'analytics.view');
  INSERT INTO public.internal_roles (user_id, role_id) VALUES (pg_temp.fx(24), pg_temp.fx(217));
  INSERT INTO public.report_access (report_key, user_id, role) VALUES ('support-sla', pg_temp.fx(24), 'viewer');
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(30), ar.id FROM public.admin_roles ar WHERE ar.is_system AND ar.name = 'Super Admin';

  INSERT INTO public.support_tickets (id, subject, description, requester_id, requester_email, requester_name, assignee_id) VALUES
    (pg_temp.fx(301), 'P4170p3 ticket 301', 'fixture', pg_temp.fx(5), 'p4170p3-5@example.test', 'P4170p3 user 5', pg_temp.fx(2)),
    (pg_temp.fx(302), 'P4170p3 ticket 302', 'fixture', pg_temp.fx(6), 'p4170p3-6@example.test', 'P4170p3 user 6', NULL);

  INSERT INTO public.organizations (id, name, slug) VALUES (pg_temp.fx(601), 'P4170p3 org 601', 'p4170p3-org-601');
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by)
    VALUES (pg_temp.fx(601), pg_temp.fx(5), 'agent', 'active', 'manual');
  INSERT INTO public.organization_plans (organization_id, plan_id)
    SELECT pg_temp.fx(601), (SELECT p.id FROM public.plans p ORDER BY p.name LIMIT 1);

  INSERT INTO public.credit_ledger (user_id, entry_type, amount) VALUES
    (pg_temp.fx(5), 'purchase', 5), (pg_temp.fx(5), 'adjustment', 1), (pg_temp.fx(6), 'purchase', 3);
  INSERT INTO public.transaction_unlocks (user_id, local_transaction_id, funding_source) VALUES
    (pg_temp.fx(5), 'p4170p3-tx-5', 'grant'), (pg_temp.fx(6), 'p4170p3-tx-6', 'grant');
  INSERT INTO public.account_suspensions (user_id, event_type, reason) VALUES
    (pg_temp.fx(5), 'suspended', 'fixture'), (pg_temp.fx(6), 'suspended', 'fixture');
  INSERT INTO public.payment_intents (user_id, local_transaction_id, quoted_unit_price_cents, stripe_mode) VALUES
    (pg_temp.fx(5), 'p4170p3-tx-5', 0, 'test'), (pg_temp.fx(6), 'p4170p3-tx-6', 0, 'test');
  INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES
    (pg_temp.fx(5), 'cus_p4170p3_5_live', 'live'), (pg_temp.fx(5), 'cus_p4170p3_5_test', 'test'),
    (pg_temp.fx(6), 'cus_p4170p3_6_live', 'live');
  INSERT INTO public.app_lifecycle_events (user_id, event_type) VALUES (pg_temp.fx(5), 'reset');

  INSERT INTO public.admin_audit_logs (action, target_type, target_id) VALUES ('p4170p3_fixture', 'fixture', 'p4170p3');
  INSERT INTO public.email_delivery_log (email_type, recipient_email, status)
    VALUES ('other', 'p4170p3-5@example.test', 'sent');
  INSERT INTO public.email_delivery_queue (email_type, recipient_email, subject, html, body_text)
    VALUES ('other', 'p4170p3-5@example.test', 'fixture', '<p>fixture</p>', 'fixture');
  INSERT INTO public.individual_invitations (invited_email, invitation_token, invitation_expires_at)
    VALUES ('p4170p3-inv@example.test', 'p4170p3-token', now() + interval '1 day');
  INSERT INTO public.pending_internal_invitations (id, email, role_id, invited_by)
    VALUES (pg_temp.fx(801), 'p4170p3-5@example.test', pg_temp.fx(201), pg_temp.fx(19));
  INSERT INTO public.support_response_templates (name, body, is_active) VALUES
    ('P4170p3 active', 'fixture', true), ('P4170p3 inactive', 'fixture', false);
END $b$;

-- ===== B0 + fixtures + P0 baseline, BEFORE the migration is applied in this transaction =====
DO $p0$
BEGIN
  -- B0: whole-table counts read by the harness role BEFORE any fixture row exists
  CREATE TEMP TABLE p4170p3_b0 AS SELECT pg_temp.allfull() AS b0;
  PERFORM pg_temp.setup();
  CREATE TEMP TABLE p4170p3_p0 AS
  SELECT pg_temp.tdigest() AS tdigest, pg_temp.shape() AS shape, pg_temp.roles_rest() AS roles_rest,
         pg_temp.trunc() AS trunc, pg_temp.depdigest() AS depdigest, pg_temp.writes() AS writes, pg_temp.fullvec(pg_temp.fx(30)) AS sa_full,
         (SELECT jsonb_object_agg(c.lbl, pg_temp.js(pg_temp.vec(c.u, c.r))) FROM pg_temp.callers() c) AS m,
         pg_temp.call_as(pg_temp.fx(3), 'SELECT to_jsonb(public.support_list_all_templates())') AS settings_view_only,
         pg_temp.call_as(pg_temp.fx(2), format('SELECT to_jsonb(count(*)) FROM public.organization_members om'
           || ' JOIN public.organizations o ON o.id = om.organization_id JOIN public.organization_plans op ON op.organization_id = o.id'
           || ' JOIN public.plans p ON p.id = op.plan_id WHERE om.user_id = %L', pg_temp.fx(5))) AS embed_assigned;
END
$p0$;
