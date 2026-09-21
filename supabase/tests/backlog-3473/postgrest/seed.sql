-- BACKLOG-3473 PostgREST probe fixtures (controls C22 and the HTTP half of
-- C1-anon). COMMITTED to the venue for the length of one probe run: PostgREST
-- reads through its own connection, so a rolled-back transaction is invisible
-- to it. Needs run.sh apply (migrations 1 and 2 committed) first;
-- postgrest/cleanup.sql removes every row afterwards.
--
-- ALL IDENTIFIERS ARE INVENTED (00000000-0000-4000-8000-00003473e5xx block,
-- .example.test emails). probe.mjs replaces them with labels before writing
-- fixture JSON.
--
-- P1: team plan + transaction_checklists override ON; one active template
--     with 2 items, one ARCHIVED template with 1 item.
-- P2: enterprise plan; one template with 1 item.
-- Users: probe-p1-agent (agent in P1), probe-p2-agent (agent in P2).

BEGIN;

INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-00003473e501', 'probe-p1-agent@fixture-3473.example.test', 'authenticated', 'authenticated', '{"provider":"email"}', '{}'), -- pii-allow-uuid: invented fixture id
  ('00000000-0000-4000-8000-00003473e502', 'probe-p2-agent@fixture-3473.example.test', 'authenticated', 'authenticated', '{"provider":"email"}', '{}'); -- pii-allow-uuid: invented fixture id

INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
  ('00000000-0000-4000-8000-00003473e501', 'probe-p1-agent@fixture-3473.example.test', 'email', 'fixture-3473-probe-p1-agent'), -- pii-allow-uuid: invented fixture id
  ('00000000-0000-4000-8000-00003473e502', 'probe-p2-agent@fixture-3473.example.test', 'email', 'fixture-3473-probe-p2-agent'); -- pii-allow-uuid: invented fixture id

INSERT INTO public.organizations (id, name, slug, max_seats) VALUES
  ('00000000-0000-4000-8000-00003473e5a1', 'Fixture Probe Brokerage 3473 P1', 'fixture-3473-probe-p1', 10), -- pii-allow-uuid: invented fixture id
  ('00000000-0000-4000-8000-00003473e5a2', 'Fixture Probe Brokerage 3473 P2', 'fixture-3473-probe-p2', 10); -- pii-allow-uuid: invented fixture id

INSERT INTO public.organization_plans (organization_id, plan_id)
SELECT '00000000-0000-4000-8000-00003473e5a1', id FROM public.plans WHERE slug = 'team'; -- pii-allow-uuid: invented fixture id
INSERT INTO public.organization_plans (organization_id, plan_id)
SELECT '00000000-0000-4000-8000-00003473e5a2', id FROM public.plans WHERE slug = 'enterprise'; -- pii-allow-uuid: invented fixture id
UPDATE public.organization_plans
   SET feature_overrides = '{"transaction_checklists": {"enabled": true}}'::jsonb
 WHERE organization_id = '00000000-0000-4000-8000-00003473e5a1'; -- pii-allow-uuid: invented fixture id

INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
  ('00000000-0000-4000-8000-00003473e5a1', '00000000-0000-4000-8000-00003473e501', 'agent', 'active', now()), -- pii-allow-uuid: invented fixture ids
  ('00000000-0000-4000-8000-00003473e5a2', '00000000-0000-4000-8000-00003473e502', 'agent', 'active', now()); -- pii-allow-uuid: invented fixture ids

INSERT INTO public.checklist_templates (id, organization_id, name, description, sort_order, archived_at) VALUES
  ('00000000-0000-4000-8000-00003473e5b1', '00000000-0000-4000-8000-00003473e5a1', 'Probe template', 'shown in the list only', 10, NULL), -- pii-allow-uuid: invented fixture ids
  ('00000000-0000-4000-8000-00003473e5b2', '00000000-0000-4000-8000-00003473e5a1', 'Probe archived', NULL, 20, now()), -- pii-allow-uuid: invented fixture ids
  ('00000000-0000-4000-8000-00003473e5b3', '00000000-0000-4000-8000-00003473e5a2', 'Probe other org', NULL, 10, NULL); -- pii-allow-uuid: invented fixture ids

INSERT INTO public.checklist_template_items (id, template_id, title, description, is_required, expected_document_type, sort_order) VALUES
  ('00000000-0000-4000-8000-00003473e5c1', '00000000-0000-4000-8000-00003473e5b1', 'Probe item 1', 'the desktop tooltip', true, 'contract', 10), -- pii-allow-uuid: invented fixture ids
  ('00000000-0000-4000-8000-00003473e5c2', '00000000-0000-4000-8000-00003473e5b1', 'Probe item 2', NULL, false, NULL, 20), -- pii-allow-uuid: invented fixture ids
  ('00000000-0000-4000-8000-00003473e5c3', '00000000-0000-4000-8000-00003473e5b2', 'Probe archived item', NULL, false, NULL, 10), -- pii-allow-uuid: invented fixture ids
  ('00000000-0000-4000-8000-00003473e5c4', '00000000-0000-4000-8000-00003473e5b3', 'Probe other item', NULL, false, NULL, 10); -- pii-allow-uuid: invented fixture ids

COMMIT;
