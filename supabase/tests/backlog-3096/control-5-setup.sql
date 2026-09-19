-- BACKLOG-3096 / CONTROL 5, step 1 of 4: seed the fixture (COMMITTED).
--
-- Control 5 needs TWO CONCURRENT SESSIONS, so unlike controls 1-4 it cannot be
-- one self-contained DO block: the fixture must be visible to both sessions and
-- therefore must be committed. control-5-assert.sql tears it down again.
--
-- The org is PRE-CREATED with zero claimed members on purpose. If the org did
-- not exist, the two sessions would serialize on
-- INSERT ... ON CONFLICT (microsoft_tenant_id) DO NOTHING -- Postgres blocks a
-- speculative insertion behind a conflicting in-flight one -- and the test
-- would pass with or without FOR UPDATE. A pre-created empty org is the only
-- shape in which the row lock is the SOLE serializer, so it is the only shape
-- that can prove the lock exists.
--
-- ALL IDENTIFIERS BELOW ARE INVENTED -- see the header of control 1.

\set ON_ERROR_STOP on

DELETE FROM organizations
 WHERE id = '00000000-0000-4000-8000-00003096c5f0' -- pii-allow-uuid: invented fixture id, verified absent from every live table
    OR microsoft_tenant_id = 'fixture-tenant-3096-c5';
DELETE FROM public.users WHERE id IN (
  '00000000-0000-4000-8000-000000309651', -- pii-allow-uuid: invented fixture id, verified absent from every live table
  '00000000-0000-4000-8000-000000309652'); -- pii-allow-uuid: invented fixture id, verified absent from every live table
DELETE FROM auth.users WHERE id IN (
  '00000000-0000-4000-8000-000000309651', -- pii-allow-uuid: invented fixture id, verified absent from every live table
  '00000000-0000-4000-8000-000000309652'); -- pii-allow-uuid: invented fixture id, verified absent from every live table

INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data) VALUES
  ('00000000-0000-4000-8000-000000309651', 'c5-racer-a@fixture-3096.example.test', -- pii-allow-uuid: invented fixture id, verified absent from every live table
   jsonb_build_object('provider_id', 'fixture-oauth-3096-c5-a'),
   jsonb_build_object('provider', 'azure')),
  ('00000000-0000-4000-8000-000000309652', 'c5-racer-b@fixture-3096.example.test', -- pii-allow-uuid: invented fixture id, verified absent from every live table
   jsonb_build_object('provider_id', 'fixture-oauth-3096-c5-b'),
   jsonb_build_object('provider', 'azure'));

INSERT INTO organizations (id, name, slug, microsoft_tenant_id, plan, max_seats, default_member_role)
VALUES ('00000000-0000-4000-8000-00003096c5f0', 'Fixture Org 3096 C5', -- pii-allow-uuid: invented fixture id, verified absent from every live table
        'fixture-org-3096-c5', 'fixture-tenant-3096-c5', 'trial', 10, 'agent');

SELECT 'control 5 fixture seeded: empty org, two racers' AS status;
