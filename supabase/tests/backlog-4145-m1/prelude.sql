-- BACKLOG-4145 M1 harness prelude: pg_temp helpers + fixtures. Composed in front of controls.sql by
-- compose.py. Venue: keepr-test ONLY (kt-sql refuses the production ref). The whole call is one
-- transaction that ends in RAISE, so nothing persists.
--
-- Fixtures (invented; ids from fx(n) = 00000000-0000-4145-8000-<n>, emails p4145-<n>@example.test):
--   users  1 support.admin only (role 101)        2 support.view only (role 102)
--          3 support.view only (role 102)        4 internal, analytics.view only (role 103)
--          5 requester, ticket 301               6 requester, ticket 302
--          7 account whose email is the requester_email on ticket 303
--          8 requester_id on ticket 303          9 requester, ticket 304
--         10 pm.view only (role 104)            11 account, no internal role
--         12 users.view only (role 105)
--   tickets 301 requester 5, assignee 2         302 requester 6, unassigned
--           303 requester_id 8, requester_email of user 7, assignee 2
--           304 requester 9, assignee 4 (internal user without support.view)
--           305 requester_id NULL, requester_email of user 6, assignee 2
--   backlog items 401 (links to 301 and 302), 402 (no links)
--   devices: one each for users 5, 6, 7, 9, 11
-- User triggers on support_tickets and pm_backlog_items are disabled inside the transaction.

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-4145-8000-' || lpad(n::text, 12, '0'))::uuid
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

CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 260) END
$b$;

-- the caller's support_my_requester_ids() as a sorted jsonb array (or the ERR text)
CREATE FUNCTION pg_temp.ids_of(u uuid, r text DEFAULT 'authenticated') RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.call_as(u, 'SELECT coalesce(jsonb_agg(x ORDER BY x), ''[]''::jsonb) FROM public.support_my_requester_ids() x', r)
$b$;

-- a sorted jsonb array of fixture ids
CREATE FUNCTION pg_temp.ids(VARIADIC ns int[]) RETURNS text LANGUAGE sql AS $b$
  SELECT coalesce((SELECT jsonb_agg(pg_temp.fx(n) ORDER BY pg_temp.fx(n)) FROM unnest(ns) n), '[]'::jsonb)::text
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  ALTER TABLE public.support_tickets DISABLE TRIGGER USER;
  ALTER TABLE public.pm_backlog_items DISABLE TRIGGER USER;

  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4145-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 12) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4145-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4145 user ' || x
    FROM generate_series(1, 12) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.admin_roles (id, name, slug, description, is_system) VALUES
    (pg_temp.fx(101), 'P4145 Support Admin', 'p4145-support-admin', 'fixture', false),
    (pg_temp.fx(102), 'P4145 Support View', 'p4145-support-view', 'fixture', false),
    (pg_temp.fx(103), 'P4145 Analytics', 'p4145-analytics', 'fixture', false),
    (pg_temp.fx(104), 'P4145 PM', 'p4145-pm', 'fixture', false),
    (pg_temp.fx(105), 'P4145 Users View', 'p4145-users-view', 'fixture', false);
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(v.n), ap.id
    FROM (VALUES (101, 'support.admin'), (102, 'support.view'), (103, 'analytics.view'),
                 (104, 'pm.view'), (105, 'users.view')) AS v(n, k)
    JOIN public.admin_permissions ap ON ap.key = v.k;
  INSERT INTO public.internal_roles (user_id, role_id) VALUES
    (pg_temp.fx(1), pg_temp.fx(101)), (pg_temp.fx(2), pg_temp.fx(102)), (pg_temp.fx(3), pg_temp.fx(102)),
    (pg_temp.fx(4), pg_temp.fx(103)), (pg_temp.fx(10), pg_temp.fx(104)), (pg_temp.fx(12), pg_temp.fx(105));

  INSERT INTO public.support_tickets (id, subject, description, requester_id, requester_email, requester_name, assignee_id) VALUES
    (pg_temp.fx(301), 'P4145 ticket 301', 'fixture', pg_temp.fx(5), 'p4145-5@example.test', 'P4145 user 5', pg_temp.fx(2)),
    (pg_temp.fx(302), 'P4145 ticket 302', 'fixture', pg_temp.fx(6), 'p4145-6@example.test', 'P4145 user 6', NULL),
    (pg_temp.fx(303), 'P4145 ticket 303', 'fixture', pg_temp.fx(8), 'p4145-7@example.test', 'P4145 user 7', pg_temp.fx(2)),
    (pg_temp.fx(304), 'P4145 ticket 304', 'fixture', pg_temp.fx(9), 'p4145-9@example.test', 'P4145 user 9', pg_temp.fx(4)),
    (pg_temp.fx(305), 'P4145 ticket 305', 'fixture', NULL, 'p4145-6@example.test', 'P4145 user 6', pg_temp.fx(2));

  INSERT INTO public.pm_backlog_items (id, title) VALUES
    (pg_temp.fx(401), 'P4145 fixture item 401'), (pg_temp.fx(402), 'P4145 fixture item 402');
  INSERT INTO public.support_ticket_backlog_links (id, ticket_id, backlog_item_id, link_type) VALUES
    (pg_temp.fx(501), pg_temp.fx(301), pg_temp.fx(401), 'related'),
    (pg_temp.fx(502), pg_temp.fx(302), pg_temp.fx(401), 'fix');

  INSERT INTO public.devices (user_id, device_id)
  SELECT pg_temp.fx(x), 'p4145-dev-' || x FROM unnest(ARRAY[5, 6, 7, 9, 11]) x;
END $b$;
