-- BACKLOG-4145 M2 harness prelude: pg_temp helpers, fixtures and the P0 baseline (read BEFORE M2 is
-- applied in this transaction). compose.py puts it after the rollback file and before the migration.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). One transaction ending in RAISE.
--
-- Fixtures (invented; ids fx(n) = 00000000-0000-4145-8000-<n>, emails p4145m2-<n>@example.test):
--   users  1 support.admin only (role 101)     2 support.view only (role 102), assigned 301/303/305
--          3 support.view only, nothing assigned
--          4 internal, analytics.view only (role 103) = Marketing-like; self-assigned 304; filed 306
--          5 customer, requester 301, org 601    6 customer, requester 302, org 602
--          7 account whose email is the requester_email on 303 (forged)
--          8 requester_id on 303                 9 requester 304, org 603
--         10 pm.view only (role 104)            11 customer, admin of org 601 (colleague of 5)
--         12 users.view only (105)              13 organizations.view only (106)
--         14 users.edit only (107)
--         21..28 analytics.view (role 103) + report_access viewer on one report each:
--            21 analytics 22 exports 23 iphone-sync 24 google-messages-sync 25 email-precache
--            26 submissions 27 support-sla 28 user-activity
--   orgs 601 (5 agent, 11 admin), 602 (6), 603 (9)
--   devices / audit_logs / licenses: users 5, 6, 7, 9, 11      user_preferences: 5, 6, 11
--   tickets 301 req 5 asg 2 | 302 req 6 | 303 req 8, email of 7, asg 2 | 304 req 9 asg 4
--           305 req NULL, email of 6, asg 2 | 306 req 4 (internal user's own ticket)
--   messages: reply + internal_note on 301 and on 306, reply on 305 (email-only requester 6); events, participants: one on 301 and on 306
--   attachments: on 301 and 306, one without message, one on the internal note
--   backlog item 401, link 501 (301 -> 401)
-- User triggers on the fixture tables except users are disabled inside the transaction.

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
    -- a real session token carries the account email; the requester_email branches read it
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

CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 400) END
$b$;

CREATE FUNCTION pg_temp.fxa(VARIADIC ns int[]) RETURNS text LANGUAGE sql AS $b$
  SELECT 'ARRAY[' || string_agg(quote_literal(pg_temp.fx(n)), ',') || ']::uuid[]' FROM unnest(ns) n
$b$;

-- the 13 target tables
CREATE FUNCTION pg_temp.targets() RETURNS text[] LANGUAGE sql IMMUTABLE AS $b$
  SELECT ARRAY['users','organizations','organization_members','devices','user_preferences','audit_logs',
               'licenses','support_tickets','support_ticket_messages','support_ticket_events',
               'support_ticket_participants','support_ticket_attachments','support_ticket_backlog_links']
$b$;

-- n/md5 over every policy on the 13 targets (same expression as the rollback header)
CREATE FUNCTION pg_temp.tdigest() RETURNS text LANGUAGE sql AS $b$
  SELECT count(*) || '/' || md5(string_agg(tablename || policyname || permissive || cmd || roles::text
         || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (pg_temp.targets())
$b$;

-- shape of every public policy (name, table, cmd, permissive), no expressions, no roles
CREATE FUNCTION pg_temp.shape() RETURNS text LANGUAGE sql AS $b$
  SELECT count(*) || '/' || md5(string_agg(tablename || policyname || permissive || cmd, ','
         ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public'
$b$;

-- roles of every public policy other than the five support policies M2 moves to authenticated
CREATE FUNCTION pg_temp.roles_rest() RETURNS text LANGUAGE sql AS $b$
  SELECT count(*) || '/' || md5(string_agg(tablename || policyname || roles::text, ',' ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public'
     AND policyname NOT IN ('support_tickets_select_public', 'support_ticket_messages_select_public',
       'support_ticket_events_select_public', 'support_ticket_participants_select_public',
       'support_ticket_attachments_select_public')
$b$;

-- per-table count queries of fixture rows NOT owned by u (k, q); run as the caller via call_as
CREATE FUNCTION pg_temp.vparts(u uuid) RETURNS TABLE (k text, q text) LANGUAGE sql AS $b$
  WITH a AS (SELECT pg_temp.fxa(1,2,3,4,5,6,7,8,9,10,11,12,13,14,21,22,23,24,25,26,27,28) f, quote_literal(u) uu,
                    pg_temp.fxa(601,602,603) o, pg_temp.fxa(301,302,303,304,305,306) tk,
                    (SELECT 'ARRAY[' || coalesce(string_agg(quote_literal(t.id), ','), '') || ']::uuid[]' FROM public.support_tickets t
                      WHERE t.id IN (pg_temp.fx(301), pg_temp.fx(302), pg_temp.fx(303), pg_temp.fx(304), pg_temp.fx(305), pg_temp.fx(306))
                        AND t.requester_id IS DISTINCT FROM u) tn,
                    quote_literal(pg_temp.fx(501)) l)
  SELECT v.k, v.q FROM a, LATERAL (VALUES
    (1, 'users', 'SELECT count(*) FROM public.users WHERE id = ANY (' || f || ') AND id <> ' || uu),
    (2, 'organizations', 'SELECT count(*) FROM public.organizations WHERE id = ANY (' || o || ')'),
    (3, 'organization_members', 'SELECT count(*) FROM public.organization_members WHERE organization_id = ANY (' || o || ') AND user_id <> ' || uu),
    (4, 'devices', 'SELECT count(*) FROM public.devices WHERE user_id = ANY (' || f || ') AND user_id <> ' || uu),
    (5, 'user_preferences', 'SELECT count(*) FROM public.user_preferences WHERE user_id = ANY (' || f || ') AND user_id <> ' || uu),
    (6, 'audit_logs', 'SELECT count(*) FROM public.audit_logs WHERE user_id = ANY (' || f || ') AND user_id <> ' || uu),
    (7, 'licenses', 'SELECT count(*) FROM public.licenses WHERE user_id = ANY (' || f || ') AND user_id <> ' || uu),
    (8, 'support_tickets', 'SELECT count(*) FROM public.support_tickets WHERE id = ANY (' || tk || ') AND requester_id IS DISTINCT FROM ' || uu),
    (9, 'support_ticket_messages', 'SELECT count(*) FROM public.support_ticket_messages WHERE ticket_id = ANY (' || tn || ')'),
    (10, 'support_ticket_events', 'SELECT count(*) FROM public.support_ticket_events WHERE ticket_id = ANY (' || tn || ')'),
    (11, 'support_ticket_participants', 'SELECT count(*) FROM public.support_ticket_participants WHERE ticket_id = ANY (' || tn || ')'),
    (12, 'support_ticket_attachments', 'SELECT count(*) FROM public.support_ticket_attachments WHERE ticket_id = ANY (' || tn || ')'),
    (13, 'support_ticket_backlog_links', 'SELECT count(*) FROM public.support_ticket_backlog_links WHERE id = ' || l)
  ) v(n, k, q) ORDER BY v.n
$b$;

-- per-table count queries of rows u owns
CREATE FUNCTION pg_temp.oparts(u uuid) RETURNS TABLE (k text, q text) LANGUAGE sql AS $b$
  SELECT v.k, replace(v.q, '$U', quote_literal(u)) FROM (VALUES
    (1, 'users', 'SELECT count(*) FROM public.users WHERE id = $U'),
    (2, 'organization_members', 'SELECT count(*) FROM public.organization_members WHERE user_id = $U'),
    (3, 'devices', 'SELECT count(*) FROM public.devices WHERE user_id = $U'),
    (4, 'user_preferences', 'SELECT count(*) FROM public.user_preferences WHERE user_id = $U'),
    (5, 'audit_logs', 'SELECT count(*) FROM public.audit_logs WHERE user_id = $U'),
    (6, 'licenses', 'SELECT count(*) FROM public.licenses WHERE user_id = $U'),
    (7, 'support_tickets', 'SELECT count(*) FROM public.support_tickets WHERE requester_id = $U'),
    (8, 'support_ticket_messages', 'SELECT count(*) FROM public.support_ticket_messages m JOIN public.support_tickets t ON t.id = m.ticket_id WHERE t.requester_id = $U'),
    (9, 'support_ticket_events', 'SELECT count(*) FROM public.support_ticket_events e JOIN public.support_tickets t ON t.id = e.ticket_id WHERE t.requester_id = $U'),
    (10, 'support_ticket_participants', 'SELECT count(*) FROM public.support_ticket_participants p JOIN public.support_tickets t ON t.id = p.ticket_id WHERE t.requester_id = $U'),
    (11, 'support_ticket_attachments', 'SELECT count(*) FROM public.support_ticket_attachments a JOIN public.support_tickets t ON t.id = a.ticket_id WHERE t.requester_id = $U')
  ) v(n, k, q) ORDER BY v.n
$b$;

-- one query building the whole vector
CREATE FUNCTION pg_temp.vecq(u uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT 'SELECT jsonb_build_object(' || string_agg(quote_literal(k) || ', (' || q || ')', ', ') || ')' FROM pg_temp.vparts(u)
$b$;
CREATE FUNCTION pg_temp.ownq(u uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT 'SELECT jsonb_build_object(' || string_agg(quote_literal(k) || ', (' || q || ')', ', ') || ')' FROM pg_temp.oparts(u)
$b$;

-- the same vector, one call per table, so a table whose read fails shows ERR without hiding the rest
CREATE FUNCTION pg_temp.each(u uuid, own boolean) RETURNS text LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(p.k, CASE WHEN r LIKE 'ERR%' THEN to_jsonb(r) ELSE r::jsonb END)::text
    FROM (SELECT * FROM pg_temp.vparts(u) WHERE NOT own UNION ALL SELECT * FROM pg_temp.oparts(u) WHERE own) p,
         LATERAL (SELECT pg_temp.call_as(u, 'SELECT to_jsonb((' || p.q || '))') r) x
$b$;

CREATE FUNCTION pg_temp.vec(u uuid) RETURNS text LANGUAGE sql AS $b$ SELECT pg_temp.call_as(u, pg_temp.vecq(u)) $b$;
CREATE FUNCTION pg_temp.own(u uuid) RETURNS text LANGUAGE sql AS $b$ SELECT pg_temp.call_as(u, pg_temp.ownq(u)) $b$;

-- the same counts read by the harness role (RLS bypassed): what "all" means for caller u
CREATE FUNCTION pg_temp.allvec(u uuid) RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE j jsonb;
BEGIN EXECUTE pg_temp.vecq(u) INTO j; RETURN j; END $b$;

-- expected vector: keys in p take their value ('all' = every non-own fixture row); others 0
CREATE FUNCTION pg_temp.expect(u uuid, p jsonb) RETURNS text LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(k, CASE WHEN p ->> k = 'all' THEN a -> k WHEN p ? k THEN p -> k ELSE '0'::jsonb END)::text
    FROM (SELECT pg_temp.allvec(u) a) s, jsonb_object_keys(s.a) k
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  ALTER TABLE public.support_tickets DISABLE TRIGGER USER;
  ALTER TABLE public.support_ticket_messages DISABLE TRIGGER USER;
  ALTER TABLE public.pm_backlog_items DISABLE TRIGGER USER;
  ALTER TABLE public.organization_members DISABLE TRIGGER USER;
  ALTER TABLE public.organizations DISABLE TRIGGER USER;
  ALTER TABLE public.devices DISABLE TRIGGER USER;
  ALTER TABLE public.licenses DISABLE TRIGGER USER;
  ALTER TABLE public.user_preferences DISABLE TRIGGER USER;

  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4145m2-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM unnest(ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,21,22,23,24,25,26,27,28]) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4145m2-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4145m2 user ' || x
    FROM unnest(ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,21,22,23,24,25,26,27,28]) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.admin_roles (id, name, slug, description, is_system) VALUES
    (pg_temp.fx(101), 'P4145m2 Support Admin', 'p4145m2-support-admin', 'fixture', false),
    (pg_temp.fx(102), 'P4145m2 Support View', 'p4145m2-support-view', 'fixture', false),
    (pg_temp.fx(103), 'P4145m2 Analytics', 'p4145m2-analytics', 'fixture', false),
    (pg_temp.fx(104), 'P4145m2 PM', 'p4145m2-pm', 'fixture', false),
    (pg_temp.fx(105), 'P4145m2 Users View', 'p4145m2-users-view', 'fixture', false),
    (pg_temp.fx(106), 'P4145m2 Orgs View', 'p4145m2-orgs-view', 'fixture', false),
    (pg_temp.fx(107), 'P4145m2 Users Edit', 'p4145m2-users-edit', 'fixture', false);
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(v.n), ap.id
    FROM (VALUES (101, 'support.admin'), (102, 'support.view'), (103, 'analytics.view'), (104, 'pm.view'),
                 (105, 'users.view'), (106, 'organizations.view'), (107, 'users.edit')) AS v(n, k)
    JOIN public.admin_permissions ap ON ap.key = v.k;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(v.u), pg_temp.fx(v.r)
    FROM (VALUES (1, 101), (2, 102), (3, 102), (4, 103), (10, 104), (12, 105), (13, 106), (14, 107),
                 (21, 103), (22, 103), (23, 103), (24, 103), (25, 103), (26, 103), (27, 103), (28, 103)) AS v(u, r);
  INSERT INTO public.report_access (report_key, user_id, role)
  SELECT v.k, pg_temp.fx(v.u), 'viewer'
    FROM (VALUES (21, 'analytics'), (22, 'exports'), (23, 'iphone-sync'), (24, 'google-messages-sync'),
                 (25, 'email-precache'), (26, 'submissions'), (27, 'support-sla'), (28, 'user-activity')) AS v(u, k);

  INSERT INTO public.organizations (id, name, slug) VALUES
    (pg_temp.fx(601), 'P4145m2 org 601', 'p4145m2-org-601'),
    (pg_temp.fx(602), 'P4145m2 org 602', 'p4145m2-org-602'),
    (pg_temp.fx(603), 'P4145m2 org 603', 'p4145m2-org-603');
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by) VALUES
    (pg_temp.fx(601), pg_temp.fx(5), 'agent', 'active', 'manual'),
    (pg_temp.fx(601), pg_temp.fx(11), 'admin', 'active', 'manual'),
    (pg_temp.fx(602), pg_temp.fx(6), 'agent', 'active', 'manual'),
    (pg_temp.fx(603), pg_temp.fx(9), 'agent', 'active', 'manual');

  INSERT INTO public.devices (user_id, device_id)
  SELECT pg_temp.fx(x), 'p4145m2-dev-' || x FROM unnest(ARRAY[5, 6, 7, 9, 11]) x;
  INSERT INTO public.audit_logs (user_id, action, resource_type)
  SELECT pg_temp.fx(x), 'p4145m2_fixture', 'fixture' FROM unnest(ARRAY[5, 6, 7, 9, 11]) x;
  INSERT INTO public.licenses (user_id, license_key)
  SELECT pg_temp.fx(x), 'p4145m2-lic-' || x FROM unnest(ARRAY[5, 6, 7, 9, 11]) x;
  INSERT INTO public.user_preferences (user_id)
  SELECT pg_temp.fx(x) FROM unnest(ARRAY[5, 6, 11]) x;

  INSERT INTO public.support_tickets (id, subject, description, requester_id, requester_email, requester_name, assignee_id) VALUES
    (pg_temp.fx(301), 'P4145m2 ticket 301', 'fixture', pg_temp.fx(5), 'p4145m2-5@example.test', 'P4145m2 user 5', pg_temp.fx(2)),
    (pg_temp.fx(302), 'P4145m2 ticket 302', 'fixture', pg_temp.fx(6), 'p4145m2-6@example.test', 'P4145m2 user 6', NULL),
    (pg_temp.fx(303), 'P4145m2 ticket 303', 'fixture', pg_temp.fx(8), 'p4145m2-7@example.test', 'P4145m2 user 7', pg_temp.fx(2)),
    (pg_temp.fx(304), 'P4145m2 ticket 304', 'fixture', pg_temp.fx(9), 'p4145m2-9@example.test', 'P4145m2 user 9', pg_temp.fx(4)),
    (pg_temp.fx(305), 'P4145m2 ticket 305', 'fixture', NULL, 'p4145m2-6@example.test', 'P4145m2 user 6', pg_temp.fx(2)),
    (pg_temp.fx(306), 'P4145m2 ticket 306', 'fixture', pg_temp.fx(4), 'p4145m2-4@example.test', 'P4145m2 user 4', NULL);
  INSERT INTO public.support_ticket_messages (id, ticket_id, body, message_type) VALUES
    (pg_temp.fx(701), pg_temp.fx(301), 'fixture reply', 'reply'),
    (pg_temp.fx(702), pg_temp.fx(301), 'fixture note', 'internal_note'),
    (pg_temp.fx(703), pg_temp.fx(306), 'fixture reply', 'reply'),
    (pg_temp.fx(704), pg_temp.fx(306), 'fixture note', 'internal_note'),
    (pg_temp.fx(705), pg_temp.fx(305), 'fixture reply', 'reply');
  INSERT INTO public.support_ticket_events (ticket_id, event_type)
  SELECT pg_temp.fx(x), 'p4145m2_fixture' FROM unnest(ARRAY[301, 306]) x;
  INSERT INTO public.support_ticket_participants (ticket_id, email)
  SELECT pg_temp.fx(x), 'p4145m2-cc-' || x || '@example.test' FROM unnest(ARRAY[301, 306]) x;
  INSERT INTO public.support_ticket_attachments (ticket_id, message_id, file_name, file_size, file_type, storage_path) VALUES
    (pg_temp.fx(301), NULL, 'a.txt', 1, 'text/plain', 'p4145m2/301/a'),
    (pg_temp.fx(301), pg_temp.fx(702), 'b.txt', 1, 'text/plain', 'p4145m2/301/b'),
    (pg_temp.fx(306), NULL, 'a.txt', 1, 'text/plain', 'p4145m2/306/a'),
    (pg_temp.fx(306), pg_temp.fx(704), 'b.txt', 1, 'text/plain', 'p4145m2/306/b');

  INSERT INTO public.pm_backlog_items (id, title) VALUES (pg_temp.fx(401), 'P4145m2 fixture item 401');
  INSERT INTO public.support_ticket_backlog_links (id, ticket_id, backlog_item_id, link_type) VALUES
    (pg_temp.fx(501), pg_temp.fx(301), pg_temp.fx(401), 'related');
END $b$;

-- ===== fixtures + P0 baseline, BEFORE the migration is applied in this transaction =====
DO $p0$
BEGIN
  PERFORM pg_temp.setup();
  -- Each P0 vector is read one table per call, so a table whose read fails before M2 shows as ERR
  -- (the four child-table policies read auth.users, which authenticated cannot read).
  CREATE TEMP TABLE p4145m2_p0 AS
  SELECT pg_temp.tdigest() AS tdigest,
         pg_temp.shape() AS shape,
         pg_temp.roles_rest() AS roles_rest,
         pg_temp.each(pg_temp.fx(4), false) AS v4,
         pg_temp.each(pg_temp.fx(5), false) AS v5, pg_temp.each(pg_temp.fx(5), true) AS o5,
         pg_temp.each(pg_temp.fx(11), false) AS v11, pg_temp.each(pg_temp.fx(11), true) AS o11,
         (SELECT jsonb_object_agg(x, pg_temp.call_as(NULL, format('SELECT to_jsonb(count(*)) FROM public.%I', x), 'anon'))::text
            FROM unnest(ARRAY['support_tickets','support_ticket_messages','support_ticket_events',
                              'support_ticket_participants','support_ticket_attachments']) x) AS anon5;
END
$p0$;
