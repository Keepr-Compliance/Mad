-- BACKLOG-3364 control fixtures.
--
-- Loaded by run.sh at the start of EVERY control, inside the control's own
-- transaction, which run.sh always ends with ROLLBACK. Nothing here survives a
-- control run.
--
-- ALL IDENTIFIERS ARE INVENTED. UUIDs sit in the 00000000-0000-4000-8000-00003364xxxx
-- block, emails under the reserved .example.test domain, slugs and license keys
-- carry a fixture-3364 prefix. Each id is published to the controls as a
-- transaction-local setting (t3364.<name>), so no control repeats a literal and
-- psql variables are never needed inside dollar-quoted blocks.
--
-- Plans are transcribed from production's three `plans` rows (name, slug, tier,
-- is_default, is_active, sort_order); only their ids are invented. ON CONFLICT
-- leaves a venue's own plan rows alone, so assertions check the plan by tier and
-- is_default, never by fixture id.
--
-- Scenario owners (which control uses which user) are listed beside each id.

DO $fixtures$
DECLARE
  -- users
  u_solo          uuid := '00000000-0000-4000-8000-000033640001'; -- pii-allow-uuid: invented fixture id (S-a, S-j)
  u_broker_agent  uuid := '00000000-0000-4000-8000-000033640002'; -- pii-allow-uuid: invented fixture id (S-b, S-f, S-g)
  u_suspended     uuid := '00000000-0000-4000-8000-000033640003'; -- pii-allow-uuid: invented fixture id (S-b)
  u_invite_live   uuid := '00000000-0000-4000-8000-000033640004'; -- pii-allow-uuid: invented fixture id (S-c)
  u_invite_null   uuid := '00000000-0000-4000-8000-000033640005'; -- pii-allow-uuid: invented fixture id (S-c)
  u_invite_old    uuid := '00000000-0000-4000-8000-000033640006'; -- pii-allow-uuid: invented fixture id (S-c)
  u_nolicense     uuid := '00000000-0000-4000-8000-000033640007'; -- pii-allow-uuid: invented fixture id (S-a)
  u_joiner        uuid := '00000000-0000-4000-8000-000033640008'; -- pii-allow-uuid: invented fixture id (S-d)
  u_claimer       uuid := '00000000-0000-4000-8000-000033640009'; -- pii-allow-uuid: invented fixture id (S-d)
  u_leaver        uuid := '00000000-0000-4000-8000-00003364000a'; -- pii-allow-uuid: invented fixture id (S-e)
  u_brk_admin     uuid := '00000000-0000-4000-8000-00003364000b'; -- pii-allow-uuid: invented fixture id (S-k1)
  u_target        uuid := '00000000-0000-4000-8000-00003364000c'; -- pii-allow-uuid: invented fixture id (S-k2)
  u_other         uuid := '00000000-0000-4000-8000-00003364000d'; -- pii-allow-uuid: invented fixture id (S-k2)
  u_two_brk       uuid := '00000000-0000-4000-8000-00003364000e'; -- pii-allow-uuid: invented fixture id (S-d)
  u_personal_f    uuid := '00000000-0000-4000-8000-00003364000f'; -- pii-allow-uuid: invented fixture id (S-f, S-g, S-h)
  u_bf_plain      uuid := '00000000-0000-4000-8000-000033640010'; -- pii-allow-uuid: invented fixture id (B-a)
  u_bf_old_invite uuid := '00000000-0000-4000-8000-000033640011'; -- pii-allow-uuid: invented fixture id (B-b)
  u_bf_live_inv   uuid := '00000000-0000-4000-8000-000033640012'; -- pii-allow-uuid: invented fixture id (B-b)
  -- organizations
  o_brk_a         uuid := '00000000-0000-4000-8000-00003364a0a0'; -- pii-allow-uuid: invented fixture id
  o_brk_b         uuid := '00000000-0000-4000-8000-00003364b0b0'; -- pii-allow-uuid: invented fixture id
  -- plans
  p_individual    uuid := '00000000-0000-4000-8000-00003364f010'; -- pii-allow-uuid: invented fixture id
  p_team          uuid := '00000000-0000-4000-8000-00003364f020'; -- pii-allow-uuid: invented fixture id
  p_enterprise    uuid := '00000000-0000-4000-8000-00003364f030'; -- pii-allow-uuid: invented fixture id
  r record;
BEGIN
  -- Publish every id as a transaction-local setting.
  PERFORM set_config('t3364.u_solo', u_solo::text, true);
  PERFORM set_config('t3364.u_broker_agent', u_broker_agent::text, true);
  PERFORM set_config('t3364.u_suspended', u_suspended::text, true);
  PERFORM set_config('t3364.u_invite_live', u_invite_live::text, true);
  PERFORM set_config('t3364.u_invite_null', u_invite_null::text, true);
  PERFORM set_config('t3364.u_invite_old', u_invite_old::text, true);
  PERFORM set_config('t3364.u_nolicense', u_nolicense::text, true);
  PERFORM set_config('t3364.u_joiner', u_joiner::text, true);
  PERFORM set_config('t3364.u_claimer', u_claimer::text, true);
  PERFORM set_config('t3364.u_leaver', u_leaver::text, true);
  PERFORM set_config('t3364.u_brk_admin', u_brk_admin::text, true);
  PERFORM set_config('t3364.u_target', u_target::text, true);
  PERFORM set_config('t3364.u_other', u_other::text, true);
  PERFORM set_config('t3364.u_two_brk', u_two_brk::text, true);
  PERFORM set_config('t3364.u_personal_f', u_personal_f::text, true);
  PERFORM set_config('t3364.u_bf_plain', u_bf_plain::text, true);
  PERFORM set_config('t3364.u_bf_old_invite', u_bf_old_invite::text, true);
  PERFORM set_config('t3364.u_bf_live_inv', u_bf_live_inv::text, true);
  PERFORM set_config('t3364.o_brk_a', o_brk_a::text, true);
  PERFORM set_config('t3364.o_brk_b', o_brk_b::text, true);

  -- Plans (transcribed; ids invented).
  INSERT INTO public.plans (id, name, slug, tier, description, is_default, is_active, sort_order) VALUES
    (p_individual, 'Individual', 'individual', 'individual', 'fixture-3364', true,  true, 10),
    (p_team,       'Team',       'team',       'team',       'fixture-3364', false, true, 20),
    (p_enterprise, 'Enterprise', 'enterprise', 'enterprise', 'fixture-3364', false, true, 30)
  ON CONFLICT DO NOTHING;

  -- auth.users, public.users. public.users is seeded explicitly: the venue has
  -- no on_auth_user_created trigger, and a control must not lean on one.
  FOR r IN
    SELECT * FROM (VALUES
      (u_solo, 'solo'), (u_broker_agent, 'broker-agent'), (u_suspended, 'suspended'),
      (u_invite_live, 'invite-live'), (u_invite_null, 'invite-null'), (u_invite_old, 'invite-old'),
      (u_nolicense, 'nolicense'), (u_joiner, 'joiner'), (u_claimer, 'claimer'), (u_leaver, 'leaver'),
      (u_brk_admin, 'brk-admin'), (u_target, 'target'), (u_other, 'other'), (u_two_brk, 'two-brk'),
      (u_personal_f, 'personal-f'), (u_bf_plain, 'bf-plain'), (u_bf_old_invite, 'bf-old-invite'),
      (u_bf_live_inv, 'bf-live-invite')
    ) v(id, label)
  LOOP
    INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
    VALUES (r.id, r.label || '@fixture-3364.example.test', 'authenticated', 'authenticated',
            jsonb_build_object('provider', 'email'), '{}'::jsonb);
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    VALUES (r.id, r.label || '@fixture-3364.example.test', 'email', 'fixture-3364-' || r.label);
    IF r.id <> u_nolicense THEN
      INSERT INTO public.licenses (user_id, license_key, license_type, status)
      VALUES (r.id, 'fixture-3364-' || r.label, 'individual', 'active');
    END IF;
  END LOOP;

  -- Two brokerages.
  INSERT INTO public.organizations (id, name, slug, max_seats) VALUES
    (o_brk_a, 'Fixture Brokerage 3364 A', 'fixture-3364-brokerage-a', 10),
    (o_brk_b, 'Fixture Brokerage 3364 B', 'fixture-3364-brokerage-b', 10);
  INSERT INTO public.organization_plans (organization_id, plan_id) VALUES
    (o_brk_a, (SELECT id FROM public.plans WHERE slug = 'team')),
    (o_brk_b, (SELECT id FROM public.plans WHERE slug = 'team'));

  -- Standing memberships.
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
    (o_brk_a, u_broker_agent, 'agent', 'active',    now()),
    (o_brk_a, u_suspended,    'agent', 'suspended', now()),
    (o_brk_a, u_brk_admin,    'admin', 'active',    now()),
    (o_brk_a, u_two_brk,      'agent', 'active',    now());

  -- Unclaimed invites (the shape the org invite path writes: user_id NULL,
  -- license_status pending, invited_email set). Expiry varies per scenario.
  INSERT INTO public.organization_members
    (organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at) VALUES
    (o_brk_b, NULL, 'agent', 'pending', 'invite-live@fixture-3364.example.test',    'fixture-3364-token-live',    now() + interval '7 days'),
    (o_brk_b, NULL, 'agent', 'pending', 'INVITE-NULL@fixture-3364.example.test ',   'fixture-3364-token-null',    NULL),
    (o_brk_b, NULL, 'agent', 'pending', 'invite-old@fixture-3364.example.test',     'fixture-3364-token-old',     now() - interval '7 days'),
    (o_brk_b, NULL, 'agent', 'pending', 'bf-old-invite@fixture-3364.example.test',  'fixture-3364-token-bf-old',  now() - interval '30 days'),
    (o_brk_b, NULL, 'agent', 'pending', 'bf-live-invite@fixture-3364.example.test', 'fixture-3364-token-bf-live', now() + interval '30 days');
END
$fixtures$;

-- Helpers, created in the control's transaction and rolled back with it.
--
-- pg_temp.check(ok, label): raises unless ok IS TRUE, and counts. run.sh reads
-- the count after the control and refuses a GREEN with zero assertions, so a
-- control that silently matched zero rows cannot pass.
--
-- pg_temp.act_as(uid): the PostgREST request shape -- role `authenticated`,
-- auth.uid() driven by request.jwt.claim.sub. RESET ROLE returns to postgres.
-- (A temporary schema is usable by every role in its own session, so
-- `authenticated` can call these.)

CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'CONTROL FAILED: %', label;
  END IF;
  PERFORM set_config('t3364.asserts', (current_setting('t3364.asserts')::int + 1)::text, true);
END
$$;

CREATE FUNCTION pg_temp.act_as(uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  PERFORM set_config('role', 'authenticated', true);
END
$$;

SELECT set_config('t3364.asserts', '0', true) IS NOT NULL AS fixtures_loaded;
