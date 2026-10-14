-- BACKLOG-3946 fixtures, on top of 3917 + 3938 fixtures.
CREATE OR REPLACE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['org1','org2','org_p','org_p2','plan','u_s','u_a','u_g','u_gs','u_ts','u_ta','u_p','u_ps',
                      'm_s','m_a','m_g','m_gs','m_ts','m_ta','m_p','m_ps','m_s2','m_gs2','scl','scl_item','sub','sub_p','tpl_org','tpl_own_p','tpl_own_s',
                      'idp','tok','log','att','msg','new_sub',
                      'u_i','arole','tk','bl','bl2','lnk','u_g2','m_g2',
                      'u_sa','srole','u_x','pinv','lnk2']) $f$;
-- u_sa: internal staff holding a system (super admin) role and no permissions.
INSERT INTO auth.users (id, email, aud, role) VALUES (pg_temp.id('u_sa'), 'u_sa-3917@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES (pg_temp.id('u_sa'), 'u_sa-3917@example.test', 'google', 'oauth-3946-u_sa');
INSERT INTO public.admin_roles (id, name, slug, is_system) VALUES (pg_temp.id('srole'), 'System 3946', 'system-3946', true);
INSERT INTO public.internal_roles (user_id, role_id) VALUES (pg_temp.id('u_sa'), pg_temp.id('srole'));
-- u_x: a signed-in user with no role anywhere (target for internal_roles inserts).
INSERT INTO auth.users (id, email, aud, role) VALUES (pg_temp.id('u_x'), 'u_x-3917@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES (pg_temp.id('u_x'), 'u_x-3917@example.test', 'google', 'oauth-3946-u_x');
-- arole (u_i) holds plans.view, users.view, probe3946.perm.
INSERT INTO public.admin_permissions (key, label, category)
  SELECT k, k, 'probe' FROM unnest(ARRAY['plans.view','users.view','probe3946.perm']) k
   WHERE NOT EXISTS (SELECT 1 FROM public.admin_permissions ap WHERE ap.key = k);
INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.id('arole'), ap.id FROM public.admin_permissions ap WHERE ap.key IN ('plans.view','users.view','probe3946.perm');

-- Visibility fingerprint: row count (or error) per actor per table, through PostgREST-equivalent roles.
CREATE TEMP TABLE t3946_vis (phase text, actor text, tbl text, msg text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.vis_capture(p_phase text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE t text; a text; m text; BEGIN
  FOREACH t IN ARRAY ARRAY['admin_audit_logs','admin_permissions','admin_role_permissions','admin_roles','analytics_events',
    'audit_logs','credit_ledger','devices','impersonation_sessions','individual_invitations','licenses','organization_members',
    'organization_plans','organizations','payment_intents','pending_internal_invitations','stripe_customers','transaction_unlocks',
    'user_preferences','users','internal_roles','account_suspensions','email_delivery_queue','checklist_templates','checklist_template_items',
    'support_ticket_backlog_links'] LOOP
    FOREACH a IN ARRAY ARRAY['anon','u_g','u_a','u_i','u_sa'] LOOP
      IF a = 'anon' THEN m := pg_temp.as_role('anon', NULL, 'select (select count(*) from public.' || t || ')');
      ELSE m := pg_temp.as_user(a, 'select (select count(*) from public.' || t || ')'); END IF;
      INSERT INTO t3946_vis VALUES (p_phase, a, t, m);
    END LOOP;
  END LOOP;
END $f$;
