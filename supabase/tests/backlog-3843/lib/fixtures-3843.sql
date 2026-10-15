-- BACKLOG-3843 fixtures. Run as postgres after the 3679 and 3538 fixtures and
-- BEFORE any migration in the run, so no guard can alter them.
INSERT INTO auth.users (id, email, aud, role) VALUES
 (pg_temp.id('u_f'), 'staff-3843@example.test',  'authenticated', 'authenticated'),
 (pg_temp.id('u_g'), 'paused-3843@example.test', 'authenticated', 'authenticated'),
 (pg_temp.id('u_h'), 'founder-3843@example.test','authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
 (pg_temp.id('u_f'), 'staff-3843@example.test',  'google', 'f3843'),
 (pg_temp.id('u_g'), 'paused-3843@example.test', 'google', 'g3843');
-- u_f: internal staff AND admin of O1 (K5).
INSERT INTO public.admin_roles (id, name, slug) VALUES (pg_temp.id('role_3843'), 'role 3843', 'role-3843');
INSERT INTO public.internal_roles (user_id, role_id) VALUES (pg_temp.id('u_f'), pg_temp.id('role_3843'));
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by) VALUES
 (pg_temp.id('m_f'), pg_temp.id('org1'), pg_temp.id('u_f'), 'admin', 'active', 'manual'),
 -- u_g: a suspended member of O1 (K6 reactivation).
 (pg_temp.id('m_g'), pg_temp.id('org1'), pg_temp.id('u_g'), 'agent', 'suspended', 'manual');
-- An organization with a Microsoft tenant and JIT on (K4 jit_join_organization).
INSERT INTO public.organizations (id, name, slug, microsoft_tenant_id, jit_provisioning_enabled)
  VALUES (pg_temp.id('org_jit'), 'Org JIT 3843', 'org-jit-3843', 'tenant-jit-3843', true);
