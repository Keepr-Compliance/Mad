-- BACKLOG-3917 fixtures (as postgres, before the 3917 file).
-- org1: brokerage. u_s suspended admin, u_a active admin (twin), u_g active agent,
-- u_gs suspended agent, u_ts suspended it_admin, u_ta active it_admin.
-- org_p: u_p's personal organization (active). org_p2: u_ps's personal organization.
-- org2: a second brokerage where u_s (admin) and u_gs (agent) each hold an ACTIVE
-- membership while suspended in org1. Producers: admin_invite_user (organization
-- path) refuses only an existing membership in the SAME organization, and
-- claim_pending_invite refuses only an existing membership in the invite's own
-- organization, then sets user_id and license_status 'active'. So one user can be
-- active in two brokerages; deactivation in org1 then leaves org1 'suspended' and
-- org2 'active'. Every org1 refusal must hold with org2 present.
-- Every linked membership written by a real writer is 'active' or set later by
-- deactivation ('suspended'); controls flip status with pg_temp.set_status.
INSERT INTO auth.users (id, email, aud, role)
SELECT pg_temp.id(n), n || '-3917@example.test', 'authenticated', 'authenticated'
  FROM unnest(ARRAY['u_s','u_a','u_g','u_gs','u_ts','u_ta','u_p','u_ps']) n;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
SELECT pg_temp.id(n), n || '-3917@example.test', 'google', 'oauth-3917-' || n
  FROM unnest(ARRAY['u_s','u_a','u_g','u_gs','u_ts','u_ta','u_p','u_ps']) n;

INSERT INTO public.organizations (id, name, slug) VALUES
  (pg_temp.id('org1'), 'Org 3917', 'org-3917'),
  (pg_temp.id('org2'), 'Org 3917 two', 'org-3917-two');
INSERT INTO public.organizations (id, name, slug, personal_owner_user_id) VALUES
  (pg_temp.id('org_p'), 'Personal 3917 p', 'personal-3917-p', pg_temp.id('u_p')),
  (pg_temp.id('org_p2'), 'Personal 3917 ps', 'personal-3917-ps', pg_temp.id('u_ps'));

INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by) VALUES
  (pg_temp.id('m_s'),  pg_temp.id('org1'),  pg_temp.id('u_s'),  'admin',    'suspended', 'manual'),
  (pg_temp.id('m_a'),  pg_temp.id('org1'),  pg_temp.id('u_a'),  'admin',    'active',    'manual'),
  (pg_temp.id('m_g'),  pg_temp.id('org1'),  pg_temp.id('u_g'),  'agent',    'active',    'manual'),
  (pg_temp.id('m_gs'), pg_temp.id('org1'),  pg_temp.id('u_gs'), 'agent',    'suspended', 'manual'),
  (pg_temp.id('m_ts'), pg_temp.id('org1'),  pg_temp.id('u_ts'), 'it_admin', 'suspended', 'manual'),
  (pg_temp.id('m_ta'), pg_temp.id('org1'),  pg_temp.id('u_ta'), 'it_admin', 'active',    'manual'),
  (pg_temp.id('m_p'),  pg_temp.id('org_p'), pg_temp.id('u_p'),  'admin',    'active',    'manual'),
  (pg_temp.id('m_ps'), pg_temp.id('org_p2'),pg_temp.id('u_ps'), 'admin',    'active',    'manual'),
  (pg_temp.id('m_s2'), pg_temp.id('org2'),  pg_temp.id('u_s'),  'admin',    'active',    'invite'),
  (pg_temp.id('m_gs2'),pg_temp.id('org2'),  pg_temp.id('u_gs'), 'agent',    'active',    'invite');

-- Transaction checklists are on for every fixture organization (plan-level feature).
INSERT INTO public.plans (id, name, slug, tier) VALUES (pg_temp.id('plan'), 'Plan 3917', 'plan-3917', 'enterprise');
INSERT INTO public.plan_features (plan_id, feature_id, enabled)
SELECT pg_temp.id('plan'), f.id, true FROM public.feature_definitions f WHERE f.key = 'transaction_checklists';
INSERT INTO public.organization_plans (organization_id, plan_id)
SELECT o, pg_temp.id('plan') FROM unnest(ARRAY[pg_temp.id('org1'), pg_temp.id('org2'), pg_temp.id('org_p'), pg_temp.id('org_p2')]) o;

INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status) VALUES
  (pg_temp.id('sub'), pg_temp.id('org1'), pg_temp.id('u_g'), 'lt-3917', '1 Fixture St', 'submitted');
INSERT INTO public.submission_comments (submission_id, user_id, content, is_internal) VALUES
  (pg_temp.id('sub'), pg_temp.id('u_g'), 'seed', false),
  (pg_temp.id('sub'), pg_temp.id('u_a'), 'seed internal', true);
INSERT INTO public.submission_attachments (id, submission_id, filename, storage_path) VALUES
  (pg_temp.id('att'), pg_temp.id('sub'), 'doc.pdf', pg_temp.id('org1')::text || '/' || pg_temp.id('sub')::text || '/doc.pdf');
INSERT INTO public.submission_messages (id, submission_id) VALUES (pg_temp.id('msg'), pg_temp.id('sub'));
INSERT INTO public.submission_checklists (id, submission_id, template_name) VALUES (pg_temp.id('scl'), pg_temp.id('sub'), 'Checklist 3917');
INSERT INTO public.submission_checklist_items (id, submission_id, submission_checklist_id, title, is_required) VALUES
  (pg_temp.id('scl_item'), pg_temp.id('sub'), pg_temp.id('scl'), 'Item 3917', true);
INSERT INTO storage.buckets (id, name) VALUES ('submission-attachments', 'submission-attachments') ON CONFLICT DO NOTHING;
-- A second bucket with no storage.objects policy of its own (c07: an upload into it is refused).
INSERT INTO storage.buckets (id, name) VALUES ('b3917-other', 'b3917-other');
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('submission-attachments', pg_temp.id('org1')::text || '/' || pg_temp.id('sub')::text || '/doc.pdf');

INSERT INTO public.checklist_templates (id, organization_id, name, owner_user_id, include_in_submission) VALUES
  (pg_temp.id('tpl_org'),   pg_temp.id('org1'),  'Org template 3917', NULL, true),
  (pg_temp.id('tpl_own_p'), pg_temp.id('org_p'), 'Own template 3917', pg_temp.id('u_p'), false);

INSERT INTO public.organization_identity_providers (id, organization_id, provider_type, display_name) VALUES
  (pg_temp.id('idp'), pg_temp.id('org1'), 'azure_ad', 'IdP 3917');
INSERT INTO public.scim_tokens (id, organization_id, token_hash) VALUES (pg_temp.id('tok'), pg_temp.id('org1'), 'hash-3917');
INSERT INTO public.scim_sync_log (id, organization_id, operation, resource_type) VALUES
  (pg_temp.id('log'), pg_temp.id('org1'), 'create', 'User');
