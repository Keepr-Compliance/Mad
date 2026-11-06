-- BACKLOG-4168 harness prelude: pg_temp helpers + fixtures. Composed in front of baseline.sql or
-- controls.sql by compose.py. Venue: keepr-test ONLY (kt-sql refuses the production ref). The whole
-- call is one transaction that ends in RAISE, so nothing persists.
--
-- Fixtures (invented; ids from fx(n) = 00000000-0000-4168-8000-<n>, emails p4168-<n>@example.test):
--   users  1 A Super Admin       2 D Super Admin        3 M manager (p4168-manager)
--          4 P peer manager (p4168-manager)             5 L lower (p4168-lower)
--          6 G Support Agent (real role, no internal_users.manage)
--          7 N account, no internal role (invitee)       8 X account, no internal role (add target)
--          9 E role editor (p4168-editor: roles.manage, no internal_users.manage)
--         10 Q account, no internal role (outsider)
--   roles 101 p4168-manager  internal_users.manage/.view, roles.manage/.view, dashboard.view, support.view, users.view
--         102 p4168-lower    dashboard.view, support.view
--         103 p4168-peer     same keys as p4168-manager
--         104 p4168-side     dashboard.view, billing.view
--         105 p4168-lower2   dashboard.view
--         106 p4168-editor   roles.manage, roles.view, dashboard.view, support.view, users.view
--   invitations 201 p4168-inv1@example.test  p4168-lower  by M
--               202 p4168-inv2@example.test  Super Admin  by A

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-4168-8000-' || lpad(n::text, 12, '0'))::uuid
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
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
  END;
END $b$;

-- call_as, then (as postgres) an optional probe query returning text, then roll everything back
CREATE FUNCTION pg_temp.call_rb(u uuid, q text, probe text DEFAULT NULL, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
DECLARE s text; p text;
BEGIN
  BEGIN
    s := pg_temp.call_as(u, q, r);
    IF probe IS NOT NULL THEN
      EXECUTE probe INTO p;
      s := s || ' | ' || coalesce(p, 'null');
    END IF;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  RETURN s;
END $b$;

-- as call_rb, but first every Super Admin other than user 1 (A) is moved to p4168-lower2,
-- so A is the only Super Admin
CREATE FUNCTION pg_temp.sole_sa(q text) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE s text;
BEGIN
  BEGIN
    UPDATE public.internal_roles SET role_id = pg_temp.fx(105)
     WHERE user_id <> pg_temp.fx(1)
       AND role_id IN (SELECT id FROM public.admin_roles WHERE is_system);
    s := pg_temp.call_as(pg_temp.fx(1), q);
    s := s || ' | sa_holders=' || (SELECT count(*) FROM public.internal_roles ir JOIN public.admin_roles ar ON ar.id = ir.role_id WHERE ar.is_system);
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  RETURN s;
END $b$;

CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 260) END
$b$;

-- status of a fixture's internal role: role slug or '-'
CREATE FUNCTION pg_temp.role_of(n int) RETURNS text LANGUAGE sql AS $b$
  SELECT coalesce((SELECT ar.slug FROM public.internal_roles ir JOIN public.admin_roles ar ON ar.id = ir.role_id
                    WHERE ir.user_id = pg_temp.fx(n)), '-')
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
DECLARE
  r_sa uuid := (SELECT id FROM public.admin_roles WHERE is_system ORDER BY created_at LIMIT 1);
  r_ag uuid := (SELECT id FROM public.admin_roles WHERE slug = 'support-agent');
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4168-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 10) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4168-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4168 user ' || x
    FROM generate_series(1, 10) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.admin_roles (id, name, slug, description, is_system) VALUES
    (pg_temp.fx(101), 'P4168 Manager', 'p4168-manager', 'fixture', false),
    (pg_temp.fx(102), 'P4168 Lower', 'p4168-lower', 'fixture', false),
    (pg_temp.fx(103), 'P4168 Peer', 'p4168-peer', 'fixture', false),
    (pg_temp.fx(104), 'P4168 Side', 'p4168-side', 'fixture', false),
    (pg_temp.fx(105), 'P4168 Lower2', 'p4168-lower2', 'fixture', false),
    (pg_temp.fx(106), 'P4168 Editor', 'p4168-editor', 'fixture', false);
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT v.rid, ap.id
    FROM (VALUES
      (101, ARRAY['internal_users.manage','internal_users.view','roles.manage','roles.view','dashboard.view','support.view','users.view']),
      (102, ARRAY['dashboard.view','support.view']),
      (103, ARRAY['internal_users.manage','internal_users.view','roles.manage','roles.view','dashboard.view','support.view','users.view']),
      (104, ARRAY['dashboard.view','billing.view']),
      (105, ARRAY['dashboard.view']),
      (106, ARRAY['roles.manage','roles.view','dashboard.view','support.view','users.view'])
    ) AS v0(n, keys)
    CROSS JOIN LATERAL (SELECT pg_temp.fx(v0.n) AS rid) v
    JOIN public.admin_permissions ap ON ap.key = ANY(v0.keys);

  INSERT INTO public.internal_roles (user_id, role_id) VALUES
    (pg_temp.fx(1), r_sa), (pg_temp.fx(2), r_sa), (pg_temp.fx(3), pg_temp.fx(101)), (pg_temp.fx(4), pg_temp.fx(101)),
    (pg_temp.fx(5), pg_temp.fx(102)), (pg_temp.fx(6), r_ag), (pg_temp.fx(9), pg_temp.fx(106));

  INSERT INTO public.pending_internal_invitations (id, email, role_id, invited_by) VALUES
    (pg_temp.fx(201), 'p4168-inv1@example.test', pg_temp.fx(102), pg_temp.fx(3)),
    (pg_temp.fx(202), 'p4168-inv2@example.test', r_sa, pg_temp.fx(1));
END $b$;
