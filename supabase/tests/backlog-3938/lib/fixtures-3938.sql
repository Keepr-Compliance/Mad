-- BACKLOG-3938/3940 fixtures, on top of the 3917 fixtures.
CREATE OR REPLACE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['org1','org2','org_p','org_p2','plan','u_s','u_a','u_g','u_gs','u_ts','u_ta','u_p','u_ps',
                      'm_s','m_a','m_g','m_gs','m_ts','m_ta','m_p','m_ps','m_s2','m_gs2','scl','scl_item','sub','sub_p','tpl_org','tpl_own_p','tpl_own_s',
                      'idp','tok','log','att','msg','new_sub',
                      'u_i','arole','tk','bl','bl2','lnk','u_g2','m_g2']) $f$;
-- u_i: internal support staff (internal_roles row) with NO organization membership.
INSERT INTO auth.users (id, email, aud, role) VALUES (pg_temp.id('u_i'), 'u_i-3917@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES (pg_temp.id('u_i'), 'u_i-3917@example.test', 'google', 'oauth-3938-u_i');
INSERT INTO public.admin_roles (id, name, slug) VALUES (pg_temp.id('arole'), 'Role 3938', 'role-3938');
INSERT INTO public.internal_roles (user_id, role_id) VALUES (pg_temp.id('u_i'), pg_temp.id('arole'));
INSERT INTO public.support_tickets (id, subject, description, requester_email, requester_name)
  VALUES (pg_temp.id('tk'), 'Ticket 3938', 'd', 'req-3938@example.test', 'Req');
INSERT INTO public.pm_backlog_items (id, title) VALUES (pg_temp.id('bl'), 'Item 3938'), (pg_temp.id('bl2'), 'Item 3938 two');
INSERT INTO public.support_ticket_backlog_links (id, ticket_id, backlog_item_id, link_type, created_by)
  VALUES (pg_temp.id('lnk'), pg_temp.id('tk'), pg_temp.id('bl'), 'fix', pg_temp.id('u_i'));
-- sub_p: a submission in org1 by u_p, who holds no org1 membership row (an agent removed
-- after submitting: removeUser deletes the row, the submission stays submitter-owned).
INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status)
  VALUES (pg_temp.id('sub_p'), pg_temp.id('org1'), pg_temp.id('u_p'), 'lt-3938', '2 Fixture St', 'submitted');
-- u_g2: an active agent of org1 who has submitted nothing (isolates the membership branch).
INSERT INTO auth.users (id, email, aud, role) VALUES (pg_temp.id('u_g2'), 'u_g2-3917@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES (pg_temp.id('u_g2'), 'u_g2-3917@example.test', 'google', 'oauth-3938-u_g2');
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by)
  VALUES (pg_temp.id('m_g2'), pg_temp.id('org1'), pg_temp.id('u_g2'), 'agent', 'active', 'manual');
