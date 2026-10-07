-- BACKLOG-3679 fixtures. Runs inside the harness transaction, as postgres.
-- Match production's table ACL (TRUNCATE was revoked from client roles there).
REVOKE TRUNCATE ON public.organization_members FROM anon, authenticated;

INSERT INTO auth.users (id, email, aud, role) VALUES
 (pg_temp.id('u_a'), 'invitee-3679@example.test', 'authenticated', 'authenticated'),
 (pg_temp.id('u_b'), 'other-3679@example.test',   'authenticated', 'authenticated'),
 (pg_temp.id('u_c'), 'admin1-3679@example.test',  'authenticated', 'authenticated'),
 (pg_temp.id('u_d'), 'admin2-3679@example.test',  'authenticated', 'authenticated'),
 (pg_temp.id('u_e'), 'member-3679@example.test',  'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
 (pg_temp.id('u_a'), 'invitee-3679@example.test', 'google', 'a3679'),
 (pg_temp.id('u_b'), 'other-3679@example.test',   'google', 'b3679'),
 (pg_temp.id('u_c'), 'admin1-3679@example.test',  'google', 'c3679'),
 (pg_temp.id('u_d'), 'admin2-3679@example.test',  'google', 'd3679'),
 (pg_temp.id('u_e'), 'member-3679@example.test',  'google', 'e3679');
INSERT INTO public.organizations (id, name, slug) VALUES
 (pg_temp.id('org1'), 'Org One 3679', 'org-one-3679'),
 (pg_temp.id('org2'), 'Org Two 3679', 'org-two-3679');
INSERT INTO public.organization_members
 (id, organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at, invited_by, provisioned_by) VALUES
 -- invitee A, pending in O1
 (pg_temp.id('inv_a'), pg_temp.id('org1'), NULL, 'agent', 'pending', 'invitee-3679@example.test', 'tok-3679-a', now() + interval '7 days', pg_temp.id('u_c'), 'invite'),
 -- admin C of O1
 (pg_temp.id('m_admin1'), pg_temp.id('org1'), pg_temp.id('u_c'), 'admin', 'active', NULL, NULL, NULL, NULL, 'manual'),
 -- active member E of O1 (target of admin edits)
 (pg_temp.id('m_member'), pg_temp.id('org1'), pg_temp.id('u_e'), 'agent', 'active', NULL, NULL, NULL, NULL, 'manual'),
 -- admin D of O2, who also holds a pending invite in O1
 (pg_temp.id('m_admin2'), pg_temp.id('org2'), pg_temp.id('u_d'), 'admin', 'active', NULL, NULL, NULL, NULL, 'manual'),
 (pg_temp.id('inv_d'), pg_temp.id('org1'), NULL, 'agent', 'pending', 'admin2-3679@example.test', 'tok-3679-d', now() + interval '7 days', pg_temp.id('u_c'), 'invite'),
 -- an expired invite for A in O2
 (pg_temp.id('inv_exp'), pg_temp.id('org2'), NULL, 'agent', 'pending', 'invitee-3679@example.test', 'tok-3679-x', now() - interval '1 day', pg_temp.id('u_d'), 'invite');
