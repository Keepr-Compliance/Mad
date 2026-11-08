-- BACKLOG-3511 harness prelude: pg_temp helpers, a scratch report table with the two standard report
-- policies, and fixtures. Composed after the migration by compose.py. Venue: keepr-test ONLY (kt-sql
-- refuses the production ref). The whole call is one transaction that ends in RAISE, so nothing
-- persists: not the scratch table, not the fixtures, not the migration.
--
-- Fixtures (invented; ids from fx(n) = 00000000-0000-3511-8000-<n>, emails p3511-<n>@example.test):
--   orgs  101 brokerage O1      102 brokerage O2
--         103 personal, owner user 11      104 personal, owner user 12
--   users  1 broker   O1 active          2 admin  O1 active          3 it_admin O1 active
--          4 agent A  O1 active          5 agent B O1 active
--          6 agent    O1 pending         7 agent  O1 suspended       8 agent O1 expired
--          9 agent    O1 unassigned     13 broker O1 suspended
--         10 broker   O2 active
--         11 personal owner of 103, role admin, active   (shapes transcribed from keepr-test:
--         12 personal owner of 104, role agent, active    personal owners hold admin/active, agent/active)
--         14 account with no membership
--   scratch rows (tag = org-agent-n):
--     O1: o1-a4-1..3 (agent A), o1-a5-1..2 (agent B), o1-a6 .. o1-a9 (inactive agents),
--         o1-a13 (suspended broker), o1-none (no agent)                              = 11
--     O2: o2-a10, o2-a4 (agent A's id on another org's row)                           = 2
--     103: p103-a11-1..2      104: p104-a12-1..2                                      = 4

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-3511-8000-' || lpad(n::text, 12, '0'))::uuid
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

-- The scratch report table: the shape every broker report source carries (organization_id +
-- agent_user_id), with the two standard policies built on the helper.
CREATE TABLE public.p3511_scratch_report (
  tag text PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_user_id uuid
);
ALTER TABLE public.p3511_scratch_report ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.p3511_scratch_report FROM anon;
GRANT SELECT ON TABLE public.p3511_scratch_report TO authenticated;
CREATE POLICY p3511_report_org_wide ON public.p3511_scratch_report FOR SELECT TO authenticated
  USING (public.org_report_scope(organization_id) = 'all');
CREATE POLICY p3511_report_own_rows ON public.p3511_scratch_report FOR SELECT TO authenticated
  USING (public.org_report_scope(organization_id) = 'own' AND agent_user_id = (SELECT auth.uid()));

-- every tag the caller can read, comma-joined in order
CREATE FUNCTION pg_temp.read_q() RETURNS text LANGUAGE sql AS $b$
  SELECT 'SELECT to_jsonb(coalesce(string_agg(tag, '','' ORDER BY tag), '''')) FROM public.p3511_scratch_report'
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p3511-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 14) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p3511-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P3511 user ' || x
    FROM generate_series(1, 14) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  -- max_seats 0 = no seat limit (_enforce_member_seat_limit returns early), so the seat trigger
  -- does not refuse the fixture members.
  INSERT INTO public.organizations (id, name, slug, plan, is_test, personal_owner_user_id, max_seats) VALUES
    (pg_temp.fx(101), 'P3511 Brokerage One', 'p3511-o1', 'enterprise', true, NULL, 0),
    (pg_temp.fx(102), 'P3511 Brokerage Two', 'p3511-o2', 'enterprise', true, NULL, 0),
    (pg_temp.fx(103), 'P3511 Personal 11', 'p3511-p103', 'pro', true, pg_temp.fx(11), 0),
    (pg_temp.fx(104), 'P3511 Personal 12', 'p3511-p104', 'pro', true, pg_temp.fx(12), 0);

  INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  SELECT pg_temp.fx(o), pg_temp.fx(u), r, s FROM (VALUES
    (101, 1, 'broker', 'active'), (101, 2, 'admin', 'active'), (101, 3, 'it_admin', 'active'),
    (101, 4, 'agent', 'active'), (101, 5, 'agent', 'active'),
    (101, 6, 'agent', 'pending'), (101, 7, 'agent', 'suspended'), (101, 8, 'agent', 'expired'),
    (101, 9, 'agent', 'unassigned'), (101, 13, 'broker', 'suspended'),
    (102, 10, 'broker', 'active'),
    (103, 11, 'admin', 'active'), (104, 12, 'agent', 'active')
  ) AS v(o, u, r, s);

  INSERT INTO public.p3511_scratch_report (tag, organization_id, agent_user_id) VALUES
    ('o1-a4-1', pg_temp.fx(101), pg_temp.fx(4)), ('o1-a4-2', pg_temp.fx(101), pg_temp.fx(4)),
    ('o1-a4-3', pg_temp.fx(101), pg_temp.fx(4)),
    ('o1-a5-1', pg_temp.fx(101), pg_temp.fx(5)), ('o1-a5-2', pg_temp.fx(101), pg_temp.fx(5)),
    ('o1-a6', pg_temp.fx(101), pg_temp.fx(6)), ('o1-a7', pg_temp.fx(101), pg_temp.fx(7)),
    ('o1-a8', pg_temp.fx(101), pg_temp.fx(8)), ('o1-a9', pg_temp.fx(101), pg_temp.fx(9)),
    ('o1-a13', pg_temp.fx(101), pg_temp.fx(13)), ('o1-none', pg_temp.fx(101), NULL),
    ('o2-a10', pg_temp.fx(102), pg_temp.fx(10)), ('o2-a4', pg_temp.fx(102), pg_temp.fx(4)),
    ('p103-a11-1', pg_temp.fx(103), pg_temp.fx(11)), ('p103-a11-2', pg_temp.fx(103), pg_temp.fx(11)),
    ('p104-a12-1', pg_temp.fx(104), pg_temp.fx(12)), ('p104-a12-2', pg_temp.fx(104), pg_temp.fx(12));
END $b$;
