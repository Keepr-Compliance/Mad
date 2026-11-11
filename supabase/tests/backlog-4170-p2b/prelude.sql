-- BACKLOG-4170 PR2b harness prelude: pg_temp helpers, fixtures and the P0 matrix (read BEFORE the
-- migration is applied in this transaction). compose.py puts it after the rollback file and before
-- the migration. Venue: keepr-test ONLY (kt-sql refuses the production ref). One transaction ending
-- in RAISE, so nothing persists. Every call also runs in its own subtransaction that is rolled back
-- (call_as), so a write by one caller is never seen by the next and every reply is deterministic.
--
-- Fixtures (invented; ids fx(n) = 00000000-0000-4170-8000-<n>, emails p4170p2b-<n>@example.test):
--   roles (synthetic, one key each; 101 holds none)
--     101 none  102 support.view  103 support.manage  104 support.admin  105 users.view (decoy)
--     106 support.view + support.manage (the shape of the real support roles, which hold view,
--         respond, assign and manage together)
--   users 1..5 hold roles 101..105 (user n holds role 100+n); 6 = the real Super Admin role;
--         7 = customer (no internal role); 8 = a second customer (no internal role, never a caller);
--         9 = role 106
--   tickets (k = 1..4; ticket fx(900+k))
--     901 T_cust        requester_id 7, requester_email user 7
--     902 T_cust_email  requester_id NULL, requester_email user 7 (reached by email only), resolved
--     903 T_u0          requester_id 1 (the zero-key internal user), resolved
--     904 T_other       requester_id 8
--   each ticket: reply fx(910+k), internal_note fx(920+k) (body holds the token p4170p2bnote),
--   attachments fx(930+k) (no message), fx(940+k) (on the internal_note), fx(950+k) (on the reply),
--   one event fx(960+k). Every ticket subject holds the token p4170p2bsubj.
--   callers also: u_nullsub (role authenticated, no sub claim) and anon (no user, role anon)
--   twins (P0 only): u0, u_other, u_support.view, u_support.manage, u_support.admin with their
--   internal_roles row deleted inside the
--   call's rolled-back subtransaction = the same user id on the requester path of the production body.
-- No reply carries a real row: every list case is filtered to fixture tokens or fixture emails.

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
  SELECT ('00000000-0000-4170-8000-' || lpad(n::text, 12, '0'))::uuid
$b$;

CREATE FUNCTION pg_temp.em(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT 'p4170p2b-' || n || '@example.test'
$b$;

CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $b$;

-- run one statement returning jsonb as a role, inside a subtransaction that is always rolled back;
-- the reply as text, or 'ERR <sqlstate> <message>'. pre (optional) runs first, as the harness owner;
-- post (optional, jsonb) runs after the call, as the harness owner, in the same subtransaction, and
-- reads what the call wrote; its result is appended as ' | <post>'.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated', pre text DEFAULT NULL, post text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $b$
DECLARE j jsonb; pj jsonb; d text;
BEGIN
  BEGIN
    IF pre IS NOT NULL THEN EXECUTE pre; END IF;
    PERFORM set_config('request.jwt.claims', CASE WHEN u IS NULL THEN json_build_object('role', r)::text
                                                  ELSE json_build_object('sub', u, 'role', r)::text END, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', r, true);
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE q INTO j;
    EXECUTE 'RESET ROLE';
    IF post IS NOT NULL THEN EXECUTE post INTO pj; END IF;
    RAISE EXCEPTION 'P4170_CALL_OK' USING DETAIL = coalesce(j::text, 'null') || CASE WHEN post IS NULL THEN '' ELSE ' | ' || coalesce(pj::text, 'null') END;
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

-- the 9 functions under test (key = name/nargs)
CREATE FUNCTION pg_temp.sigs() RETURNS TABLE (k text, sig text) LANGUAGE sql IMMUTABLE AS $b$
  VALUES __SIGS__
$b$;

-- md5(prosrc) / proacl / proconfig / provolatile of the 9, one jsonb
CREATE FUNCTION pg_temp.state() RETURNS jsonb LANGUAGE sql AS $b$
  SELECT jsonb_object_agg(s.k, jsonb_build_object('md5', md5(p.prosrc), 'acl', p.proacl::text,
         'config', p.proconfig::text, 'vol', p.provolatile::text))
    FROM pg_temp.sigs() s JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)
$b$;

-- what a write left behind (read as the owner, inside the call's subtransaction). No ids are printed.
CREATE FUNCTION pg_temp.after_msg(t int) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT format($f$SELECT jsonb_build_object('status', t.status, 'first_response', t.first_response_at IS NOT NULL,
      'reopened', t.reopened_count,
      'new', (SELECT jsonb_agg(jsonb_build_object('type', m.message_type, 'sender_set', m.sender_id IS NOT NULL,
                                                  'sender_email', m.sender_email, 'sender_name', m.sender_name))
                FROM public.support_ticket_messages m WHERE m.ticket_id = t.id AND m.body = 'p4170p2b new'),
      'events', (SELECT jsonb_agg(e.event_type || ':' || coalesce(e.new_value, '') ORDER BY e.event_type)
                   FROM public.support_ticket_events e WHERE e.ticket_id = t.id AND e.created_at = now()))
    FROM public.support_tickets t WHERE t.id = %L$f$, pg_temp.fx(t))
$b$;

CREATE FUNCTION pg_temp.after_att(t int) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT format($f$SELECT jsonb_build_object(
      'new', (SELECT jsonb_agg(jsonb_build_object('by_requester', a.uploaded_by IS NOT DISTINCT FROM tk.requester_id,
                                                  'expires', a.expires_at IS NOT NULL, 'msg', a.message_id IS NOT NULL))
                FROM public.support_ticket_attachments a, public.support_tickets tk
               WHERE tk.id = a.ticket_id AND a.ticket_id = %L AND a.file_name = 'p4170p2b.txt'),
      'events', (SELECT jsonb_agg(e.event_type ORDER BY e.event_type) FROM public.support_ticket_events e
                  WHERE e.ticket_id = %L AND e.created_at = now()))$f$, pg_temp.fx(t), pg_temp.fx(t))
$b$;

CREATE FUNCTION pg_temp.after_del(a int, t int) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT format($f$SELECT jsonb_build_object(
      'row_left', EXISTS (SELECT 1 FROM public.support_ticket_attachments WHERE id = %L),
      'events', (SELECT jsonb_agg(e.event_type || ':' || coalesce(e.old_value, '') ORDER BY e.event_type)
                   FROM public.support_ticket_events e WHERE e.ticket_id = %L AND e.created_at = now()))$f$,
    pg_temp.fx(a), pg_temp.fx(t))
$b$;

CREATE FUNCTION pg_temp.after_read(t int) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT format($f$SELECT (SELECT jsonb_agg(e.event_type || ':' || coalesce(e.new_value, '') || ':' || coalesce(e.metadata ->> 'reader', ''))
                     FROM public.support_ticket_events e WHERE e.ticket_id = %L AND e.created_at = now())$f$, pg_temp.fx(t))
$b$;

-- the cases: (n, case key, function key, query, post)
CREATE FUNCTION pg_temp.cases() RETURNS TABLE (n int, c text, f text, q text, post text) LANGUAGE sql AS $b$
  SELECT * FROM (VALUES
    -- support_get_ticket_detail(uuid, text)
    (1, 'd_cust', 'support_get_ticket_detail/2', format('SELECT public.support_get_ticket_detail(%L::uuid, NULL::text)', pg_temp.fx(901)), NULL::text),
    (2, 'd_cust_email', 'support_get_ticket_detail/2', format('SELECT public.support_get_ticket_detail(%L::uuid, NULL::text)', pg_temp.fx(902)), NULL),
    (3, 'd_u0', 'support_get_ticket_detail/2', format('SELECT public.support_get_ticket_detail(%L::uuid, NULL::text)', pg_temp.fx(903)), NULL),
    (4, 'd_other', 'support_get_ticket_detail/2', format('SELECT public.support_get_ticket_detail(%L::uuid, NULL::text)', pg_temp.fx(904)), NULL),
    (5, 'd_by_email', 'support_get_ticket_detail/2', format('SELECT public.support_get_ticket_detail(%L::uuid, %L)', pg_temp.fx(901), pg_temp.em(7)), NULL),
    (6, 'd_bad_email', 'support_get_ticket_detail/2', format('SELECT public.support_get_ticket_detail(%L::uuid, %L)', pg_temp.fx(901), pg_temp.em(99)), NULL),
    -- support_add_message(uuid, text, text, text, text); the reply's id is random, so it is dropped
    (7, 'm_cust_email_reply', 'support_add_message/5', format($f$SELECT public.support_add_message(%L::uuid, 'p4170p2b new', 'reply', NULL::text, NULL::text) - 'id'$f$, pg_temp.fx(902)), pg_temp.after_msg(902)),
    (8, 'm_by_email_reply', 'support_add_message/5', format($f$SELECT public.support_add_message(%L::uuid, 'p4170p2b new', 'reply', %L, NULL::text) - 'id'$f$, pg_temp.fx(902), pg_temp.em(7)), pg_temp.after_msg(902)),
    (9, 'm_u0_reply', 'support_add_message/5', format($f$SELECT public.support_add_message(%L::uuid, 'p4170p2b new', 'reply', NULL::text, NULL::text) - 'id'$f$, pg_temp.fx(903)), pg_temp.after_msg(903)),
    (10, 'm_u0_note', 'support_add_message/5', format($f$SELECT public.support_add_message(%L::uuid, 'p4170p2b new', 'internal_note', NULL::text, NULL::text) - 'id'$f$, pg_temp.fx(903)), pg_temp.after_msg(903)),
    (11, 'm_other_note', 'support_add_message/5', format($f$SELECT public.support_add_message(%L::uuid, 'p4170p2b new', 'internal_note', NULL::text, NULL::text) - 'id'$f$, pg_temp.fx(904)), pg_temp.after_msg(904)),
    -- support_list_tickets(10 args): fixture-token search, fixture-email filter
    (12, 'l_subj', 'support_list_tickets/10', $q$SELECT public.support_list_tickets(p_search => 'p4170p2bsubj', p_page_size => 50)$q$, NULL),
    (13, 'l_note', 'support_list_tickets/10', $q$SELECT public.support_list_tickets(p_search => 'p4170p2bnote', p_page_size => 50)$q$, NULL),
    (14, 'l_email', 'support_list_tickets/10', format('SELECT public.support_list_tickets(p_requester_email => %L, p_page_size => 50)', pg_temp.em(7)), NULL),
    -- support_add_attachment(uuid, uuid, text, bigint, text, text)
    (15, 'a_cust', 'support_add_attachment/6', format($f$SELECT public.support_add_attachment(%L::uuid, NULL::uuid, 'p4170p2b.txt', 1::bigint, 'text/plain', 'p4170p2b/f.txt') - 'id'$f$, pg_temp.fx(901)), pg_temp.after_att(901)),
    (16, 'a_u0', 'support_add_attachment/6', format($f$SELECT public.support_add_attachment(%L::uuid, NULL::uuid, 'p4170p2b.txt', 1::bigint, 'text/plain', 'p4170p2b/f.txt') - 'id'$f$, pg_temp.fx(903)), pg_temp.after_att(903)),
    (17, 'a_other', 'support_add_attachment/6', format($f$SELECT public.support_add_attachment(%L::uuid, NULL::uuid, 'p4170p2b.txt', 1::bigint, 'text/plain', 'p4170p2b/f.txt') - 'id'$f$, pg_temp.fx(904)), pg_temp.after_att(904)),
    -- support_add_diagnostic_attachment(uuid, text, bigint, text, text, integer)
    (18, 'g_cust', 'support_add_diagnostic_attachment/6', format($f$SELECT public.support_add_diagnostic_attachment(%L::uuid, 'p4170p2b.txt', 1::bigint, 'text/plain', 'p4170p2b/d.txt', 7) - 'id'$f$, pg_temp.fx(901)), pg_temp.after_att(901)),
    (19, 'g_u0', 'support_add_diagnostic_attachment/6', format($f$SELECT public.support_add_diagnostic_attachment(%L::uuid, 'p4170p2b.txt', 1::bigint, 'text/plain', 'p4170p2b/d.txt', 7) - 'id'$f$, pg_temp.fx(903)), pg_temp.after_att(903)),
    (20, 'g_other', 'support_add_diagnostic_attachment/6', format($f$SELECT public.support_add_diagnostic_attachment(%L::uuid, 'p4170p2b.txt', 1::bigint, 'text/plain', 'p4170p2b/d.txt', 7) - 'id'$f$, pg_temp.fx(904)), pg_temp.after_att(904)),
    -- support_delete_own_attachment(uuid)
    (21, 'x_cust', 'support_delete_own_attachment/1', format('SELECT public.support_delete_own_attachment(%L::uuid)', pg_temp.fx(931)), pg_temp.after_del(931, 901)),
    (22, 'x_u0', 'support_delete_own_attachment/1', format('SELECT public.support_delete_own_attachment(%L::uuid)', pg_temp.fx(933)), pg_temp.after_del(933, 903)),
    (23, 'x_other', 'support_delete_own_attachment/1', format('SELECT public.support_delete_own_attachment(%L::uuid)', pg_temp.fx(934)), pg_temp.after_del(934, 904)),
    (24, 'x_missing', 'support_delete_own_attachment/1', format('SELECT public.support_delete_own_attachment(%L::uuid)', pg_temp.fx(999)), NULL),
    -- support_list_attachments(uuid)
    (25, 'la_cust', 'support_list_attachments/1', format('SELECT public.support_list_attachments(%L::uuid)', pg_temp.fx(901)), NULL),
    (26, 'la_u0', 'support_list_attachments/1', format('SELECT public.support_list_attachments(%L::uuid)', pg_temp.fx(903)), NULL),
    (27, 'la_other', 'support_list_attachments/1', format('SELECT public.support_list_attachments(%L::uuid)', pg_temp.fx(904)), NULL),
    -- support_list_events(uuid)
    (28, 'le_cust', 'support_list_events/1', format('SELECT public.support_list_events(%L::uuid)', pg_temp.fx(901)), NULL),
    (29, 'le_u0', 'support_list_events/1', format('SELECT public.support_list_events(%L::uuid)', pg_temp.fx(903)), NULL),
    (30, 'le_other', 'support_list_events/1', format('SELECT public.support_list_events(%L::uuid)', pg_temp.fx(904)), NULL),
    -- support_record_attachment_access(uuid)
    (31, 'r_cust', 'support_record_attachment_access/1', format('SELECT public.support_record_attachment_access(%L::uuid)', pg_temp.fx(931)), pg_temp.after_read(901)),
    (32, 'r_u0', 'support_record_attachment_access/1', format('SELECT public.support_record_attachment_access(%L::uuid)', pg_temp.fx(933)), pg_temp.after_read(903)),
    (33, 'r_other', 'support_record_attachment_access/1', format('SELECT public.support_record_attachment_access(%L::uuid)', pg_temp.fx(934)), pg_temp.after_read(904)),
    (34, 'r_missing', 'support_record_attachment_access/1', format('SELECT public.support_record_attachment_access(%L::uuid)', pg_temp.fx(999)), NULL)
  ) v(n, c, f, q, post)
$b$;

-- the callers: (n, label, user id or NULL, db role, pre)
CREATE FUNCTION pg_temp.callers() RETURNS TABLE (n int, lbl text, u uuid, r text, pre text) LANGUAGE sql AS $b$
  SELECT * FROM (VALUES
    (1, 'anon', NULL::uuid, 'anon', NULL::text),
    (2, 'u_nullsub', NULL::uuid, 'authenticated', NULL),
    (3, 'u_cust', pg_temp.fx(7), 'authenticated', NULL),
    (4, 'u0', pg_temp.fx(1), 'authenticated', NULL),
    (5, 'u_support.view', pg_temp.fx(2), 'authenticated', NULL),
    (6, 'u_support.manage', pg_temp.fx(3), 'authenticated', NULL),
    (7, 'u_support.admin', pg_temp.fx(4), 'authenticated', NULL),
    (8, 'u_other_users.view', pg_temp.fx(5), 'authenticated', NULL),
    (9, 'u_sa', pg_temp.fx(6), 'authenticated', NULL),
    (10, 'u_view+manage', pg_temp.fx(9), 'authenticated', NULL)
  ) v(n, lbl, u, r, pre)
$b$;

-- twins: the same user with no internal role (P0 only)
CREATE FUNCTION pg_temp.twins() RETURNS TABLE (n int, lbl text, u uuid, r text, pre text) LANGUAGE sql AS $b$
  SELECT 20 + x.n, x.lbl || '_as_cust', x.u, x.r, format('DELETE FROM public.internal_roles WHERE user_id = %L', x.u)
    FROM pg_temp.callers() x WHERE x.lbl IN ('u0', 'u_support.view', 'u_support.manage', 'u_support.admin', 'u_other_users.view')
$b$;

CREATE FUNCTION pg_temp.matrix(with_twins boolean) RETURNS TABLE (lbl text, c text, f text, res text) LANGUAGE sql AS $b$
  SELECT cl.lbl, cs.c, cs.f, pg_temp.call_as(cl.u, cs.q, cl.r, cl.pre, cs.post)
    FROM (SELECT * FROM pg_temp.callers() UNION ALL SELECT * FROM pg_temp.twins() WHERE with_twins) cl
    CROSS JOIN pg_temp.cases() cs ORDER BY cl.n, cs.n
$b$;

CREATE FUNCTION pg_temp.setup() RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), pg_temp.em(x), 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 9) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), pg_temp.em(x), 'email', pg_temp.fx(x)::text, 'P4170p2b user ' || x
    FROM generate_series(1, 9) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.admin_roles (id, name, slug, description, is_system)
  SELECT pg_temp.fx(100 + x), 'P4170p2b role ' || x, 'p4170p2b-role-' || x, 'fixture', false
    FROM generate_series(1, 6) x;
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.fx(v.n), ap.id
    FROM (VALUES (102, 'support.view'), (103, 'support.manage'), (104, 'support.admin'), (105, 'users.view'),
                 (106, 'support.view'), (106, 'support.manage')) AS v(n, k)
    JOIN public.admin_permissions ap ON ap.key = v.k;
  IF (SELECT count(*) FROM public.admin_role_permissions WHERE role_id IN (SELECT pg_temp.fx(100 + x) FROM generate_series(1, 6) x)) <> 6 THEN
    RAISE EXCEPTION 'P4170 fixture: a permission key is missing from admin_permissions';
  END IF;
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(x), pg_temp.fx(100 + x) FROM generate_series(1, 5) x
  UNION ALL SELECT pg_temp.fx(9), pg_temp.fx(106);
  INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.fx(6), ar.id FROM public.admin_roles ar WHERE ar.slug = 'super-admin';
  IF NOT FOUND THEN RAISE EXCEPTION 'P4170 fixture: no super-admin role'; END IF;

  INSERT INTO public.support_tickets (id, subject, description, status, requester_id, requester_email, requester_name, created_at, updated_at)
  VALUES
    (pg_temp.fx(901), 'P4170p2b ticket 901 p4170p2bsubj', 'fixture', 'new', pg_temp.fx(7), pg_temp.em(7), 'P4170p2b user 7', now() - interval '4 hours', now() - interval '4 hours'),
    (pg_temp.fx(902), 'P4170p2b ticket 902 p4170p2bsubj', 'fixture', 'resolved', NULL, pg_temp.em(7), 'P4170p2b user 7', now() - interval '3 hours', now() - interval '3 hours'),
    (pg_temp.fx(903), 'P4170p2b ticket 903 p4170p2bsubj', 'fixture', 'resolved', pg_temp.fx(1), pg_temp.em(1), 'P4170p2b user 1', now() - interval '2 hours', now() - interval '2 hours'),
    (pg_temp.fx(904), 'P4170p2b ticket 904 p4170p2bsubj', 'fixture', 'new', pg_temp.fx(8), pg_temp.em(8), 'P4170p2b user 8', now() - interval '1 hour', now() - interval '1 hour');
  INSERT INTO public.support_ticket_messages (id, ticket_id, sender_id, sender_email, sender_name, message_type, body, created_at)
  SELECT pg_temp.fx(910 + k), pg_temp.fx(900 + k), NULL, pg_temp.em(8), 'P4170p2b sender', 'reply', 'fixture reply', now() - interval '50 minutes' + k * interval '1 minute'
    FROM generate_series(1, 4) k
  UNION ALL
  SELECT pg_temp.fx(920 + k), pg_temp.fx(900 + k), pg_temp.fx(6), pg_temp.em(6), 'P4170p2b agent', 'internal_note', 'fixture note p4170p2bnote', now() - interval '40 minutes' + k * interval '1 minute'
    FROM generate_series(1, 4) k;
  INSERT INTO public.support_ticket_attachments (id, ticket_id, message_id, file_name, file_size, file_type, storage_path, uploaded_by, created_at)
  SELECT pg_temp.fx(930 + k), pg_temp.fx(900 + k), NULL, 'p4170p2b-plain.txt', 1, 'text/plain', 'p4170p2b/plain', NULL, now() - interval '30 minutes' + k * interval '1 minute'
    FROM generate_series(1, 4) k
  UNION ALL
  SELECT pg_temp.fx(940 + k), pg_temp.fx(900 + k), pg_temp.fx(920 + k), 'p4170p2b-note.txt', 1, 'text/plain', 'p4170p2b/note', pg_temp.fx(6), now() - interval '20 minutes' + k * interval '1 minute'
    FROM generate_series(1, 4) k
  UNION ALL
  SELECT pg_temp.fx(950 + k), pg_temp.fx(900 + k), pg_temp.fx(910 + k), 'p4170p2b-reply.txt', 1, 'text/plain', 'p4170p2b/reply', NULL, now() - interval '10 minutes' + k * interval '1 minute'
    FROM generate_series(1, 4) k;
  INSERT INTO public.support_ticket_events (id, ticket_id, actor_id, event_type, new_value, metadata, created_at)
  SELECT pg_temp.fx(960 + k), pg_temp.fx(900 + k), pg_temp.fx(6), 'status_changed', 'new', '{"fixture": true}'::jsonb, now() - interval '5 minutes' + k * interval '1 minute'
    FROM generate_series(1, 4) k;
END $b$;

-- ===== fixtures + P0, BEFORE the migration is applied in this transaction =====
DO $p0$
BEGIN
  PERFORM pg_temp.setup();
  CREATE TEMP TABLE p4170p2b_p0 AS SELECT * FROM pg_temp.matrix(true);
  CREATE TEMP TABLE p4170p2b_p0_state AS SELECT pg_temp.state() AS st;
END
$p0$;
