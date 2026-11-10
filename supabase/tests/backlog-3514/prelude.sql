-- BACKLOG-3514 harness prelude: pg_temp helpers and fixtures. Composed after the migration by
-- compose.py. Venue: keepr-test ONLY (kt-sql refuses the production ref). The whole call is one
-- transaction that ends in RAISE, so nothing persists: not the fixtures, not the migration.
-- Needs 20261108140000 (3505) and 20261108190000 (3511) already applied on the venue.
--
-- Fixtures (invented; ids from fx(n) = 00000000-0000-3514-8000-<n>, emails p3514-<n>@example.test):
--   orgs  101 brokerage O1 (Enterprise)    102 brokerage O2 (Enterprise)
--         103 personal, owner user 11      105 brokerage T (Team plan: broker_reports off)
--   users  1 broker O1 active      2 broker O1 active (pin-cap user)   3 it_admin O1 active
--          4 agent  O1 active     10 broker O2 active                 11 personal owner of 103
--         14 no membership
--         15 LEFT O1 (suspended) and ACTIVE agent in O2               (C2 a)
--         16 broker O1 active AND internal staff (internal_roles)     (C1 cross-portal)
--         17 broker T active
--         18 broker ACTIVE in T (feature off) AND ACTIVE in O2        (C2 b)
--   views (broker_report_saved_views):
--         901 O1 user 1  pipeline     'broker view'
--         902 O1 user 4  pipeline     'agent view'
--         903 O1 user 15 pipeline     'leaver view'
--         904 O1 user 16 iphone-sync  'broker16 view'
--         906 T  user 18 pipeline     'team view'
--   admin view (report_saved_views): 905 user 16 iphone-sync 'admin16 view'

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-3514-8000-' || lpad(n::text, 12, '0'))::uuid
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
    RETURN coalesce(j #>> '{}', 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
  END;
END $b$;

CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 260) END
$b$;

-- statement builders for the four RPCs
CREATE FUNCTION pg_temp.q_list(o int, k text) RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT public.broker_report_list_views(%L::uuid, %L)', pg_temp.fx(o), k)
$b$;
CREATE FUNCTION pg_temp.q_save(o int, k text, nm text, pin boolean, id int,
                               met jsonb DEFAULT '{"col":"x","fn":"count"}', fil jsonb DEFAULT '{}') RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT public.broker_report_save_view(%L::uuid, %L, %L, %L::jsonb, %s, %L, %s)',
    pg_temp.fx(o), k, nm, fil, CASE WHEN met IS NULL THEN 'NULL' ELSE quote_literal(met) || '::jsonb' END, pin,
    CASE WHEN id IS NULL THEN 'NULL' ELSE quote_literal(pg_temp.fx(id)) || '::uuid' END)
$b$;
CREATE FUNCTION pg_temp.q_del(o int, id int) RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT public.broker_report_delete_view(%L::uuid, %L::uuid)', pg_temp.fx(o), pg_temp.fx(id))
$b$;
CREATE FUNCTION pg_temp.q_def(o int, k text, id int) RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT public.broker_report_set_default_view(%L::uuid, %L, %s)', pg_temp.fx(o), k,
    CASE WHEN id IS NULL THEN 'NULL' ELSE quote_literal(pg_temp.fx(id)) || '::uuid' END)
$b$;

-- one row's org/key/name, for "nothing moved" checks
CREATE FUNCTION pg_temp.row_of(id int) RETURNS text LANGUAGE sql AS $b$
  SELECT coalesce((SELECT (CASE organization_id WHEN pg_temp.fx(101) THEN 'O1' WHEN pg_temp.fx(102) THEN 'O2'
                                 WHEN pg_temp.fx(105) THEN 'T' ELSE 'other' END) || '/' || report_key || '/' || name
                     FROM public.broker_report_saved_views WHERE id = pg_temp.fx($1)), 'gone')
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p3514-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM unnest(ARRAY[1, 2, 3, 4, 10, 11, 14, 15, 16, 17, 18]) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p3514-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P3514 user ' || x
    FROM unnest(ARRAY[1, 2, 3, 4, 10, 11, 14, 15, 16, 17, 18]) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  -- max_seats 0 = no seat limit, so the seat trigger does not refuse the fixture members.
  INSERT INTO public.organizations (id, name, slug, plan, is_test, personal_owner_user_id, max_seats) VALUES
    (pg_temp.fx(101), 'P3514 Brokerage One', 'p3514-o1', 'enterprise', true, NULL, 0),
    (pg_temp.fx(102), 'P3514 Brokerage Two', 'p3514-o2', 'enterprise', true, NULL, 0),
    (pg_temp.fx(103), 'P3514 Personal 11', 'p3514-p103', 'pro', true, pg_temp.fx(11), 0),
    (pg_temp.fx(105), 'P3514 Brokerage Team', 'p3514-t', 'enterprise', true, NULL, 0);

  INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  SELECT pg_temp.fx(o), pg_temp.fx(u), r, s FROM (VALUES
    (101, 1, 'broker', 'active'), (101, 2, 'broker', 'active'), (101, 3, 'it_admin', 'active'),
    (101, 4, 'agent', 'active'), (102, 10, 'broker', 'active'), (103, 11, 'admin', 'active'),
    (101, 15, 'agent', 'suspended'), (102, 15, 'agent', 'active'),
    (101, 16, 'broker', 'active'), (105, 17, 'broker', 'active'),
    (105, 18, 'broker', 'active'), (102, 18, 'broker', 'active')
  ) AS v(o, u, r, s);

  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(16), (SELECT role_id FROM public.internal_roles LIMIT 1);

  -- plans: O1/O2 Enterprise (feature on), T Team (feature off); the Team plan lives in organization_plans
  UPDATE public.organization_plans SET plan_id = (SELECT id FROM public.plans WHERE name = 'Enterprise'), feature_overrides = '{}'
   WHERE organization_id IN (pg_temp.fx(101), pg_temp.fx(102));
  INSERT INTO public.organization_plans (organization_id, plan_id)
  SELECT o, (SELECT id FROM public.plans WHERE name = 'Enterprise') FROM unnest(ARRAY[pg_temp.fx(101), pg_temp.fx(102)]) o
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_plans WHERE organization_id = o);
  UPDATE public.organization_plans SET plan_id = (SELECT id FROM public.plans WHERE name = 'Team'), feature_overrides = '{}'
   WHERE organization_id = pg_temp.fx(105);
  INSERT INTO public.organization_plans (organization_id, plan_id)
  SELECT pg_temp.fx(105), (SELECT id FROM public.plans WHERE name = 'Team')
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_plans WHERE organization_id = pg_temp.fx(105));

  INSERT INTO public.broker_report_saved_views (id, organization_id, user_id, report_key, name) VALUES
    (pg_temp.fx(901), pg_temp.fx(101), pg_temp.fx(1), 'pipeline', 'broker view'),
    (pg_temp.fx(902), pg_temp.fx(101), pg_temp.fx(4), 'pipeline', 'agent view'),
    (pg_temp.fx(903), pg_temp.fx(101), pg_temp.fx(15), 'pipeline', 'leaver view'),
    (pg_temp.fx(904), pg_temp.fx(101), pg_temp.fx(16), 'iphone-sync', 'broker16 view'),
    (pg_temp.fx(906), pg_temp.fx(105), pg_temp.fx(18), 'pipeline', 'team view');
  INSERT INTO public.report_saved_views (id, user_id, report_key, name, filters, metric, pinned)
  VALUES (pg_temp.fx(905), pg_temp.fx(16), 'iphone-sync', 'admin16 view', '{}', '{"col":"x","fn":"count"}', false);
END $b$;
