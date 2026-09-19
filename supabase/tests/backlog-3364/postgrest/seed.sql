-- BACKLOG-3364 PostgREST probe fixtures. COMMITTED to the venue for the length
-- of one probe run (PostgREST reads through its own connection, so a rolled-back
-- transaction is invisible to it). postgrest/cleanup.sql removes every row.
--
-- ALL IDENTIFIERS ARE INVENTED (00000000-0000-4000-8000-00003364e0xx block,
-- .example.test emails). probe.mjs replaces them with labels before writing
-- fixture JSON.

BEGIN;

INSERT INTO public.plans (id, name, slug, tier, description, is_default, is_active, sort_order) VALUES
  ('00000000-0000-4000-8000-00003364e110', 'Individual', 'individual', 'individual', 'fixture-3364-probe', true,  true, 10), -- pii-allow-uuid: invented fixture id
  ('00000000-0000-4000-8000-00003364e120', 'Team',       'team',       'team',       'fixture-3364-probe', false, true, 20)  -- pii-allow-uuid: invented fixture id
ON CONFLICT DO NOTHING;

INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-00003364e001', 'probe-broker@fixture-3364.example.test', 'authenticated', 'authenticated', '{"provider":"email"}', '{}'), -- pii-allow-uuid: invented fixture id
  ('00000000-0000-4000-8000-00003364e002', 'probe-solo@fixture-3364.example.test',   'authenticated', 'authenticated', '{"provider":"email"}', '{}'); -- pii-allow-uuid: invented fixture id

INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
  ('00000000-0000-4000-8000-00003364e001', 'probe-broker@fixture-3364.example.test', 'email', 'fixture-3364-probe-broker'), -- pii-allow-uuid: invented fixture id
  ('00000000-0000-4000-8000-00003364e002', 'probe-solo@fixture-3364.example.test',   'email', 'fixture-3364-probe-solo');   -- pii-allow-uuid: invented fixture id

INSERT INTO public.licenses (user_id, license_key, license_type, status) VALUES
  ('00000000-0000-4000-8000-00003364e001', 'fixture-3364-probe-broker', 'team', 'active'),       -- pii-allow-uuid: invented fixture id
  ('00000000-0000-4000-8000-00003364e002', 'fixture-3364-probe-solo',   'individual', 'active'); -- pii-allow-uuid: invented fixture id

INSERT INTO public.organizations (id, name, slug, max_seats) VALUES
  ('00000000-0000-4000-8000-00003364e0a0', 'Fixture Probe Brokerage 3364', 'fixture-3364-probe-brokerage', 10); -- pii-allow-uuid: invented fixture id

INSERT INTO public.organization_plans (organization_id, plan_id)
SELECT '00000000-0000-4000-8000-00003364e0a0', id FROM public.plans WHERE slug = 'team'; -- pii-allow-uuid: invented fixture id

INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
  ('00000000-0000-4000-8000-00003364e0a0', '00000000-0000-4000-8000-00003364e001', 'agent', 'active', now()); -- pii-allow-uuid: invented fixture ids

COMMIT;
