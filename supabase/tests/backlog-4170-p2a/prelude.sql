-- BACKLOG-4170 PR2a harness prelude: pg_temp helpers, fixtures and the P0 matrix (read BEFORE the
-- migration is applied in this transaction). compose.py puts it after the rollback file and before
-- the migration. Venue: keepr-test ONLY (kt-sql refuses the production ref). One transaction ending
-- in RAISE, so nothing persists. Every call also runs in its own subtransaction that is rolled back
-- (call_as), so a write by one caller is never seen by the next and every reply is deterministic.
--
-- Fixtures (invented; ids fx(n) = 00000000-0000-4170-8000-<n>, emails p4170p2a-<n>@example.test):
--   roles (synthetic, one key each; 101 holds none)
--     101 none  102 support.view  103 support.manage  104 support.admin  105 users.view (decoy)
--   users 1..5 hold roles 101..105 (user n holds role 100+n); 6 = the real Super Admin role;
--         7 = customer (no internal role)
--   callers also: u_nullsub (role authenticated, no sub claim) and anon (no user, role anon)
--   templates 991 'P4170p2a tpl active' (active) and 994 'P4170p2a tpl inactive' (inactive)
--   ticket ids 990 / 992 and participant id 993 do not exist: write cases that need a ticket reach
--   the body's own not-found branch, which only a caller past the guard can reach.
-- No reply carries a real row: list/search cases return counts of fixture rows only.

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-4170-8000-' || lpad(n::text, 12, '0'))::uuid
$b$;

CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $b$;

-- run one statement returning jsonb as a role, inside a subtransaction that is always rolled back;
-- the reply as text, or 'ERR <sqlstate> <message>'. pre (optional) runs first, as the harness owner,
-- inside the same subtransaction.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated', pre text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE j jsonb; d text;
BEGIN
  BEGIN
    IF pre IS NOT NULL THEN EXECUTE pre; END IF;
    PERFORM set_config('request.jwt.claims', CASE WHEN u IS NULL THEN json_build_object('role', r)::text
                                                  ELSE json_build_object('sub', u, 'role', r)::text END, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', r, true);
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE q INTO j;
    RAISE EXCEPTION 'P4170_CALL_OK' USING DETAIL = coalesce(j::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'P4170_CALL_OK' THEN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
    ELSE d := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100); END IF;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.clear_claims();
  RETURN d;
END $b$;

CREATE FUNCTION pg_temp.js(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
BEGIN RETURN s::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(s); END $b$;

CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 400) END
$b$;

-- the 23 functions under test (key = name/nargs)
CREATE FUNCTION pg_temp.sigs() RETURNS TABLE (k text, sig text) LANGUAGE sql IMMUTABLE AS $b$
  VALUES __SIGS__
$b$;

-- md5(prosrc) / proacl / proconfig / provolatile of the 23, one jsonb
CREATE FUNCTION pg_temp.state() RETURNS jsonb LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(s.k, jsonb_build_object('md5', md5(p.prosrc), 'acl', p.proacl::text,
         'config', p.proconfig::text, 'vol', p.provolatile::text))
    FROM pg_temp.sigs() s JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)
$b$;

-- the cases: one call per signature (case key = function key)
-- support_bulk_update_tickets has three overloads whose trailing parameters have defaults, so a call
-- with 3 or 5 arguments is ambiguous (42725) on production too. To reach the /3 and /5 bodies, those
-- cases first rename the longer overloads (pre, inside the rolled-back subtransaction).
CREATE FUNCTION pg_temp.hide(sigs text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT string_agg(format('ALTER FUNCTION %s RENAME TO p4170p2a_hidden_%s;', s, i), ' ')
    FROM unnest(sigs) WITH ORDINALITY AS t(s, i)
$b$;

CREATE FUNCTION pg_temp.cases() RETURNS TABLE (n int, c text, q text, pre text) LANGUAGE sql AS $b$
  SELECT v.n, v.c, v.q, CASE v.c
      WHEN 'support_bulk_update_tickets/3' THEN pg_temp.hide(ARRAY['public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid)',
                                                                   'public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid,boolean)'])
      WHEN 'support_bulk_update_tickets/5' THEN pg_temp.hide(ARRAY['public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid,boolean)'])
    END
  FROM (VALUES
    (1, 'support_agent_analytics/1', $q$SELECT public.support_agent_analytics(7) -> 'period_days'$q$),
    (2, 'support_assign_ticket/2', format('SELECT public.support_assign_ticket(%L::uuid, NULL::uuid)', pg_temp.fx(990))),
    (3, 'support_bulk_update_tickets/3', $q$SELECT public.support_bulk_update_tickets(ARRAY[]::uuid[], NULL::text, NULL::uuid)$q$),
    (4, 'support_bulk_update_tickets/5', $q$SELECT public.support_bulk_update_tickets(ARRAY[]::uuid[], NULL::text, NULL::uuid, NULL::text, NULL::uuid)$q$),
    (5, 'support_bulk_update_tickets/6', $q$SELECT public.support_bulk_update_tickets(ARRAY[]::uuid[], NULL::text, NULL::uuid, NULL::text, NULL::uuid, false)$q$),
    (6, 'support_create_template/3', $q$SELECT public.support_create_template('P4170p2a tpl new', 'body', NULL::text) -> 'name'$q$),
    (7, 'support_delete_template/1', format('SELECT public.support_delete_template(%L::uuid)', pg_temp.fx(991))),
    (8, 'support_update_template/5', format($f$SELECT public.support_update_template(%L::uuid, 'P4170p2a tpl active', 'body', NULL::text, true)$f$, pg_temp.fx(991))),
    (9, 'support_list_all_templates/0', $q$SELECT to_jsonb(count(*)) FROM jsonb_array_elements(public.support_list_all_templates()) e WHERE e ->> 'name' LIKE 'P4170p2a%'$q$),
    (10, 'support_list_templates/0', $q$SELECT to_jsonb(count(*)) FROM jsonb_array_elements(public.support_list_templates()) e WHERE e ->> 'name' LIKE 'P4170p2a%'$q$),
    (11, 'support_get_related_tickets/1', format('SELECT public.support_get_related_tickets(%L::uuid)', pg_temp.fx(990))),
    (12, 'support_get_ticket_stats/0', $q$SELECT to_jsonb(jsonb_typeof(public.support_get_ticket_stats() -> 'by_status'))$q$),
    (13, 'support_link_tickets/3', format($f$SELECT public.support_link_tickets(%L::uuid, %L::uuid, 'related')$f$, pg_temp.fx(990), pg_temp.fx(992))),
    (14, 'support_unlink_tickets/2', format('SELECT public.support_unlink_tickets(%L::uuid, %L::uuid)', pg_temp.fx(990), pg_temp.fx(992))),
    (15, 'support_list_agents/0', $q$SELECT to_jsonb(count(*)) FROM jsonb_array_elements(public.support_list_agents()) e WHERE e ->> 'email' LIKE 'p4170p2a-%'$q$),
    (16, 'support_add_participant/4', format($f$SELECT public.support_add_participant(%L::uuid, 'p4170p2a-cc@example.test', NULL::text, 'cc')$f$, pg_temp.fx(990))),
    (17, 'support_remove_participant/1', format('SELECT public.support_remove_participant(%L::uuid)', pg_temp.fx(993))),
    (18, 'support_requester_recent_tickets/1', $q$SELECT to_jsonb(count(*)) FROM public.support_requester_recent_tickets('p4170p2a-none@example.test')$q$),
    (19, 'support_search_requesters/1', $q$SELECT to_jsonb(count(*)) FROM public.support_search_requesters('p4170p2a-')$q$),
    (20, 'support_search_tickets_for_link/2', $q$SELECT to_jsonb(count(*)) FROM public.support_search_tickets_for_link('P4170p2a-nomatch', NULL::uuid)$q$),
    (21, 'support_update_ticket_category/2', format('SELECT public.support_update_ticket_category(%L::uuid, NULL::uuid)', pg_temp.fx(990))),
    (22, 'support_update_ticket_priority/2', format($f$SELECT public.support_update_ticket_priority(%L::uuid, 'low')$f$, pg_temp.fx(990))),
    (23, 'support_update_ticket_status/3', format($f$SELECT public.support_update_ticket_status(%L::uuid, 'in_progress', NULL::text)$f$, pg_temp.fx(990)))
  ) v(n, c, q)
$b$;

-- the callers: (label, user id or NULL, db role)
CREATE FUNCTION pg_temp.callers() RETURNS TABLE (n int, lbl text, u uuid, r text) LANGUAGE sql AS $b$
  SELECT * FROM (VALUES
    (1, 'u0_none', pg_temp.fx(1), 'authenticated'),
    (2, 'u_support.view', pg_temp.fx(2), 'authenticated'),
    (3, 'u_support.manage', pg_temp.fx(3), 'authenticated'),
    (4, 'u_support.admin', pg_temp.fx(4), 'authenticated'),
    (5, 'u_other_users.view', pg_temp.fx(5), 'authenticated'),
    (6, 'u_sa', pg_temp.fx(6), 'authenticated'),
    (7, 'u_cust', pg_temp.fx(7), 'authenticated'),
    (8, 'u_nullsub', NULL::uuid, 'authenticated'),
    (9, 'anon', NULL::uuid, 'anon')
  ) v(n, lbl, u, r)
$b$;

-- every caller x every case
CREATE FUNCTION pg_temp.matrix() RETURNS TABLE (lbl text, c text, res text) LANGUAGE sql AS $b$
  SELECT cl.lbl, cs.c, pg_temp.call_as(cl.u, cs.q, cl.r, cs.pre)
    FROM pg_temp.callers() cl CROSS JOIN pg_temp.cases() cs ORDER BY cl.n, cs.n
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4170p2a-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 7) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4170p2a-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4170p2a user ' || x
    FROM generate_series(1, 7) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.admin_roles (id, name, slug, description, is_system)
  SELECT pg_temp.fx(100 + x), 'P4170p2a role ' || x, 'p4170p2a-role-' || x, 'fixture', false
    FROM generate_series(1, 5) x;
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(v.n), ap.id
    FROM (VALUES (102, 'support.view'), (103, 'support.manage'), (104, 'support.admin'), (105, 'users.view')) AS v(n, k)
    JOIN public.admin_permissions ap ON ap.key = v.k;
  IF (SELECT count(*) FROM public.admin_role_permissions WHERE role_id IN (SELECT pg_temp.fx(100 + x) FROM generate_series(1, 5) x)) <> 4 THEN
    RAISE EXCEPTION 'P4170 fixture: a permission key is missing from admin_permissions';
  END IF;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(x), pg_temp.fx(100 + x) FROM generate_series(1, 5) x;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(6), ar.id FROM public.admin_roles ar WHERE ar.slug = 'super-admin';
  IF NOT FOUND THEN RAISE EXCEPTION 'P4170 fixture: no super-admin role'; END IF;

  INSERT INTO public.support_response_templates (id, name, body, is_active, created_by, updated_by) VALUES
    (pg_temp.fx(991), 'P4170p2a tpl active', 'body', true, pg_temp.fx(6), pg_temp.fx(6)),
    (pg_temp.fx(994), 'P4170p2a tpl inactive', 'body', false, pg_temp.fx(6), pg_temp.fx(6));
END $b$;

-- ===== fixtures + P0, BEFORE the migration is applied in this transaction =====
DO $p0$
BEGIN
  PERFORM pg_temp.setup();
  CREATE TEMP TABLE p4170p2a_p0 AS SELECT * FROM pg_temp.matrix();
  CREATE TEMP TABLE p4170p2a_p0_state AS SELECT pg_temp.state() AS st;
END
$p0$;
