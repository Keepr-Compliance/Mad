-- BACKLOG-3513 PR-2 harness prelude: pg_temp helpers and fixtures. Composed after the migration by
-- compose.py. Venue: keepr-test ONLY (kt-sql refuses the production ref). The whole call is one
-- transaction that ends in RAISE, so nothing persists: not the fixtures, not the migration, not the
-- billing_change_log rows the controls write. Copied from supabase/tests/backlog-3514 (call_as =
-- SET LOCAL ROLE + jwt claims).
--
-- Fixtures (invented; ids from fx(n) = 00000000-0000-3513-8200-<n>, emails p3513b-<n>@example.test,
-- display names 'P3513B user <n>'):
--   orgs  101 O1 Enterprise      102 O2 Enterprise      103 O3 Enterprise, org_deals status 'canceled'
--         105 T  Team (broker_reports off)             106 O4 Enterprise, broker_portal_access override off
--   users  1 B1 broker O1   2 B2 broker O1   3 A1 admin O1   4 I1 it_admin O1
--          5 G1 agent O1    6 G2 agent O1    7 G3 agent O1   8 G4 agent O1 SUSPENDED
--         10 broker O2     11 B3 broker O3  12 agent O3     13 broker T   14 no membership
--         15 broker O4     16 internal staff (Super Admin), no membership
--   submissions O1 (status, submitter, parent):
--         301 submitted G1 | 302 approved G1 <- 303 resubmitted G1 | 304 under_review G1 <- 305 uploading G1
--         306 needs_changes G2 | 307 rejected G2 <- 308 submitted B1 (cross-submitter child)
--         309 submitted B2 <- 310 resubmitted B1 (cross-submitter child) | 311 under_review B1
--         312 approved A1 | 313 submitted G3 | 314 uploading G1 | 315 resubmitted G2
--   submissions O3: 320 submitted B3 | 321 submitted agent12 | 322 approved agent12;  O4: 330 submitted broker15
--   definitions (owner; row_scope; general access; grants):
--         401 X1  O1 G1 all   restricted   G2 viewer, B1 viewer
--         402 X2  O1 B1 own   restricted   B2 viewer, A1 editor, G2 editor
--         403 X3  O3 B3 all   restricted
--         404 X4  O1 B1 all   restricted   A1 editor, B2 viewer                 (transfer)
--         405 X5  O1 B1 all   restricted   A1 editor, G2 editor, I1 viewer, B2 viewer   (share + audit)
--         406 X6  O1 B1 all   restricted   role agent viewer, role broker editor, role admin viewer
--         407 X7  O1 B1 all   organization B2 editor
--         408 X8  O1 G1 (active)                                              (take-over refused)
--         409 X9  O1 user 8 (suspended)                                       (take-over)
--         410 X10 O1 owner NULL                                               (take-over)
--         411 X11 O1 B1 + saved views 'd-<411>' (B1, B2) and 'pipeline' (B1)  (delete)
--         412 X12 O1 B1, no grants                                            ('admins' target)
--         413 X13 T  user 13                                                  (feature off)
--         414 X14 O1 B1, A1 editor                                            (update / stale)
--         415 X15 O1 user 8 (suspended)                                       (take-over by a broker)
--         416 X16 T  owner NULL                                               (take-over, feature off)

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-3513-8200-' || lpad(n::text, 12, '0'))::uuid
$b$;
CREATE FUNCTION pg_temp.nx(u uuid) RETURNS int LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE WHEN u::text LIKE '00000000-0000-3513-8200-%' THEN right(u::text, 12)::int END
$b$;

CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $b$;

-- run one statement returning jsonb as user fx(u) under role r; the reply as text, or 'ERR <sqlstate> <message>'
CREATE FUNCTION pg_temp.call_as(u int, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
DECLARE j jsonb;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.fx(u), 'role', r)::text, true);
    PERFORM set_config('request.jwt.claim.sub', pg_temp.fx(u)::text, true);
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
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 300) END
$b$;

-- F6 rows as a sorted array of fixture numbers
CREATE FUNCTION pg_temp.q_rows(o int, def int, st text DEFAULT NULL) RETURNS text LANGUAGE sql AS $b$
  SELECT format('SELECT coalesce(jsonb_agg(pg_temp.nx(r.id) ORDER BY pg_temp.nx(r.id)), ''[]'') '
                'FROM public.broker_report_submissions_rows(%L::uuid, %s, %L, NULL, NULL, NULL, ''newest'', 200, 0) r',
                pg_temp.fx(o), CASE WHEN def IS NULL THEN 'NULL' ELSE quote_literal(pg_temp.fx(def)) || '::uuid' END, st)
$b$;

-- independent oracle: the page's algorithm (selectDealHeads + headMatchesFilter) over what the caller can
-- SELECT under RLS, restricted to own rows when own; set-based, written apart from F6
CREATE FUNCTION pg_temp.q_oracle(o int, own boolean, st text) RETURNS text LANGUAGE sql AS $b$
  SELECT format($q$
    WITH vis AS (
      SELECT t.id, t.parent_submission_id AS p, t.status::text AS st
        FROM public.transaction_submissions t
       WHERE t.organization_id = %L::uuid AND t.status::text <> 'uploading'
         AND (NOT %L::boolean OR t.submitted_by = auth.uid())),
    superseded AS (SELECT DISTINCT p FROM vis WHERE p IS NOT NULL),
    heads AS (SELECT * FROM vis WHERE id NOT IN (SELECT p FROM superseded)),
    fm(f, s) AS (VALUES ('new', 'submitted'), ('submitted', 'submitted'), ('submitted', 'resubmitted'),
                        ('pending', 'submitted'), ('pending', 'resubmitted'), ('pending', 'under_review'))
    SELECT coalesce(jsonb_agg(pg_temp.nx(h.id) ORDER BY pg_temp.nx(h.id)), '[]') FROM heads h
     WHERE %L = 'all'
        OR EXISTS (SELECT 1 FROM fm WHERE fm.f = %L AND fm.s = h.st)
        OR (%L NOT IN ('new', 'submitted', 'pending') AND h.st = %L)$q$,
    pg_temp.fx(o), own, st, st, st, st)
$b$;

-- report_* activity rows, readable: {actor, action, def, name, detail (member_id -> member user number)}
CREATE FUNCTION pg_temp.ids() RETURNS uuid[] LANGUAGE sql AS $b$
  SELECT coalesce(array_agg(id), '{}') FROM public.billing_change_log WHERE source = 'report'
$b$;
CREATE FUNCTION pg_temp.added(b uuid[]) RETURNS jsonb LANGUAGE sql AS $b$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'actor', pg_temp.nx(c.actor_id), 'action', c.action,
           'def', pg_temp.nx((c.detail ->> 'definition_id')::uuid), 'name', c.detail ->> 'report_name',
           'detail', (c.detail - 'definition_id' - 'report_name' - 'member_id')
                     || CASE WHEN c.detail ? 'member_id'
                             THEN jsonb_build_object('member', (SELECT pg_temp.nx(m.user_id) FROM public.organization_members m
                                                                 WHERE m.id::text = c.detail ->> 'member_id'))
                             ELSE '{}'::jsonb END)
           ORDER BY c.action, c.detail::text), '[]'::jsonb)
    FROM public.billing_change_log c
   WHERE c.source = 'report' AND NOT (c.id = ANY (b))
$b$;
CREATE FUNCTION pg_temp.ar(actor int, act text, def int, nm text, det jsonb) RETURNS jsonb LANGUAGE sql AS $b$
  SELECT jsonb_build_object('actor', actor, 'action', act, 'def', def, 'name', nm, 'detail', det)
$b$;
-- run q as u; PASS when the reply matches want (exact text, or 'ERR%' prefix) and the added rows equal want_rows
CREATE FUNCTION pg_temp.ctl(u int, q text, want text, want_rows jsonb) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE b uuid[] := pg_temp.ids(); s text; got jsonb;
BEGIN
  s := pg_temp.call_as(u, q);
  got := pg_temp.added(b);
  RETURN pg_temp.pass((s = want OR (want LIKE 'ERR%' AND s LIKE want || '%')) AND got = want_rows,
                      'reply=' || s || ' rows=' || got::text);
END $b$;
CREATE FUNCTION pg_temp.lvl(u int, def int) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE s text;
BEGIN
  s := pg_temp.call_as(u, format('SELECT public.broker_report_def_get(%L::uuid)', pg_temp.fx(def)));
  RETURN CASE WHEN s LIKE 'ERR%' THEN s ELSE s::jsonb ->> 'level' END;
END $b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
DECLARE uu int[] := ARRAY[1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16];
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p3513b-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM unnest(uu) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p3513b-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P3513B user ' || x
    FROM unnest(uu) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.organizations (id, name, slug, plan, is_test, personal_owner_user_id, max_seats) VALUES
    (pg_temp.fx(101), 'P3513B One', 'p3513b-o1', 'enterprise', true, NULL, 0),
    (pg_temp.fx(102), 'P3513B Two', 'p3513b-o2', 'enterprise', true, NULL, 0),
    (pg_temp.fx(103), 'P3513B Three', 'p3513b-o3', 'enterprise', true, NULL, 0),
    (pg_temp.fx(105), 'P3513B Team', 'p3513b-t', 'enterprise', true, NULL, 0),
    (pg_temp.fx(106), 'P3513B Four', 'p3513b-o4', 'enterprise', true, NULL, 0);

  INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  SELECT pg_temp.fx(o), pg_temp.fx(u), r, s FROM (VALUES
    (101, 1, 'broker', 'active'), (101, 2, 'broker', 'active'), (101, 3, 'admin', 'active'),
    (101, 4, 'it_admin', 'active'), (101, 5, 'agent', 'active'), (101, 6, 'agent', 'active'),
    (101, 7, 'agent', 'active'), (101, 8, 'agent', 'suspended'), (102, 10, 'broker', 'active'),
    (103, 11, 'broker', 'active'), (103, 12, 'agent', 'active'), (105, 13, 'broker', 'active'),
    (106, 15, 'broker', 'active')
  ) AS v(o, u, r, s);

  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(16), (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');

  DELETE FROM public.organization_plans WHERE organization_id IN
    (pg_temp.fx(101), pg_temp.fx(102), pg_temp.fx(103), pg_temp.fx(105), pg_temp.fx(106));
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT pg_temp.fx(o), (SELECT id FROM public.plans WHERE name = p), fo::jsonb FROM (VALUES
    (101, 'Enterprise', '{}'), (102, 'Enterprise', '{}'), (103, 'Enterprise', '{}'), (105, 'Team', '{}'),
    (106, 'Enterprise', '{"broker_portal_access": {"enabled": false}}')) AS v(o, p, fo);

  INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status)
  VALUES (pg_temp.fx(103), 'test', 5, 'canceled');

  INSERT INTO public.transaction_submissions
    (id, organization_id, submitted_by, local_transaction_id, property_address, status, parent_submission_id, sale_price, created_at)
  SELECT pg_temp.fx(i), pg_temp.fx(o), pg_temp.fx(u), 'p3513b-' || i, i || ' Fixture Lane', st,
         CASE WHEN par IS NULL THEN NULL ELSE pg_temp.fx(par) END, i * 1000, now() - make_interval(hours => 400 - i)
    FROM (VALUES
      (301, 101, 5, 'submitted', NULL), (302, 101, 5, 'approved', NULL), (303, 101, 5, 'resubmitted', 302),
      (304, 101, 5, 'under_review', NULL), (305, 101, 5, 'uploading', 304), (306, 101, 6, 'needs_changes', NULL),
      (307, 101, 6, 'rejected', NULL), (308, 101, 1, 'submitted', 307), (309, 101, 2, 'submitted', NULL),
      (310, 101, 1, 'resubmitted', 309), (311, 101, 1, 'under_review', NULL), (312, 101, 3, 'approved', NULL),
      (313, 101, 7, 'submitted', NULL), (314, 101, 5, 'uploading', NULL), (315, 101, 6, 'resubmitted', NULL),
      (320, 103, 11, 'submitted', NULL), (321, 103, 12, 'submitted', NULL), (322, 103, 12, 'approved', NULL),
      (330, 106, 15, 'submitted', NULL)
    ) AS v(i, o, u, st, par)
   ORDER BY i;

  INSERT INTO public.broker_report_definitions (id, organization_id, dataset_key, name, owner_user_id, row_scope, general_access, created_by)
  SELECT pg_temp.fx(i), pg_temp.fx(o), 'submissions', nm, CASE WHEN ow IS NULL THEN NULL ELSE pg_temp.fx(ow) END, rs, ga,
         CASE WHEN ow IS NULL THEN NULL ELSE pg_temp.fx(ow) END
    FROM (VALUES
      (401, 101, 'Report one', 5, 'all', 'restricted'), (402, 101, 'Report two', 1, 'own', 'restricted'),
      (403, 103, 'Report three', 11, 'all', 'restricted'), (404, 101, 'Report four', 1, 'all', 'restricted'),
      (405, 101, 'Pipeline five', 1, 'all', 'restricted'), (406, 101, 'Report six', 1, 'all', 'restricted'),
      (407, 101, 'Report seven', 1, 'all', 'organization'), (408, 101, 'Report eight', 5, 'all', 'restricted'),
      (409, 101, 'Report nine', 8, 'all', 'restricted'), (410, 101, 'Report ten', NULL, 'all', 'restricted'),
      (411, 101, 'Report eleven', 1, 'all', 'restricted'), (412, 101, 'Report twelve', 1, 'all', 'restricted'),
      (413, 105, 'Report thirteen', 13, 'all', 'restricted'), (414, 101, 'Report fourteen', 1, 'all', 'restricted'),
      (415, 101, 'Report fifteen', 8, 'all', 'restricted'), (416, 105, 'Report sixteen', NULL, 'all', 'restricted')
    ) AS v(i, o, nm, ow, rs, ga);

  INSERT INTO public.broker_report_definition_grants (definition_id, principal_type, principal_user_id, principal_role, level)
  SELECT pg_temp.fx(d), t, CASE WHEN u IS NULL THEN NULL ELSE pg_temp.fx(u) END, r, l FROM (VALUES
    (401, 'user', 6, NULL, 'viewer'), (401, 'user', 1, NULL, 'viewer'),
    (402, 'user', 2, NULL, 'viewer'), (402, 'user', 3, NULL, 'editor'), (402, 'user', 6, NULL, 'editor'),
    (404, 'user', 3, NULL, 'editor'), (404, 'user', 2, NULL, 'viewer'),
    (405, 'user', 3, NULL, 'editor'), (405, 'user', 6, NULL, 'editor'), (405, 'user', 4, NULL, 'viewer'), (405, 'user', 2, NULL, 'viewer'),
    (406, 'role', NULL, 'agent', 'viewer'), (406, 'role', NULL, 'broker', 'editor'), (406, 'role', NULL, 'admin', 'viewer'),
    (407, 'user', 2, NULL, 'editor'),
    (414, 'user', 3, NULL, 'editor')
  ) AS v(d, t, u, r, l);

  INSERT INTO public.broker_report_saved_views (id, organization_id, user_id, report_key, name) VALUES
    (pg_temp.fx(901), pg_temp.fx(101), pg_temp.fx(1), 'd-' || pg_temp.fx(411)::text, 'b1 d-view'),
    (pg_temp.fx(902), pg_temp.fx(101), pg_temp.fx(2), 'd-' || pg_temp.fx(411)::text, 'b2 d-view'),
    (pg_temp.fx(903), pg_temp.fx(101), pg_temp.fx(1), 'pipeline', 'b1 pipeline');
END $b$;
