-- BACKLOG-3096 / CONTROL 3  ***THE WHITE-GLOVE CASE***
-- Org pre-created by hand with ZERO CLAIMED members but TWO UNCLAIMED invite
-- rows (user_id IS NULL) -> the first real caller still becomes 'admin'.
--
-- This control discriminates between three readings of the rule:
--
--   "admin iff the org row was created by THIS call"  -> RED here.  The org
--       already existed, so the arriving IT admin would land as 'broker' and
--       nobody could administer a white-glove customer's organization.
--   "admin iff the org has no admin yet"              -> RED here, because one
--       of the seeded unclaimed rows is an invitation with role 'admin'. That
--       reading was rejected: an org whose last admin departed would hand
--       admin to whoever walked in next.
--   "admin iff the org has zero CLAIMED members"      -> GREEN. The shipped rule.
--
-- It also reds mutants/02-no-claimed-filter.sql, which drops the
-- user_id IS NOT NULL predicate: without it the two invite rows read as
-- members and the IT admin is demoted to 'broker' on arrival.
--
-- FIXTURE PROVENANCE: the unclaimed row shape is transcribed from its real
-- producer -- the org invite path in
-- supabase/migrations/20260412_fix_cross_table_duplicate_invite_check.sql,
-- which inserts (organization_id, invited_email, role, license_status,
-- invitation_token, invitation_expires_at, invited_by, invited_at,
-- provisioned_by, provisioning_metadata) with license_status 'pending',
-- provisioned_by 'invite' and joined_at left NULL. Cross-checked against
-- production by column-presence aggregate only -- no values were read out.
-- The role='admin' invitation is a shape the producer can emit (it takes a
-- p_role argument and the CHECK constraint permits 'admin'); every unclaimed
-- row in production today happens to be 'agent'.
--
-- ALL IDENTIFIERS BELOW ARE INVENTED -- see the header of control 1.
--
-- HOW TO RUN:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-3-precreated-org-unclaimed-invites-first-caller-is-admin.sql

DO $control$
DECLARE
  k_tenant    CONSTANT TEXT := 'fixture-tenant-3096-c3';
  k_slug      CONSTANT TEXT := 'fixture-org-3096-c3';
  k_name      CONSTANT TEXT := 'Fixture Org 3096 C3';
  k_org_id    CONSTANT UUID := '00000000-0000-4000-8000-00003096c3f0'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_inviter   CONSTANT UUID := '00000000-0000-4000-8000-000000309630'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_user_a    CONSTANT UUID := '00000000-0000-4000-8000-000000309631'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  v_result    JSONB;
  v_role_a    TEXT;
  v_unclaimed INT;
BEGIN
  ---------------------------------------------------------------------------
  -- Fixture teardown-first (re-runnable)
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE id = k_org_id OR microsoft_tenant_id = k_tenant;
  DELETE FROM public.users WHERE id IN (k_inviter, k_user_a);
  DELETE FROM auth.users WHERE id IN (k_inviter, k_user_a);

  ---------------------------------------------------------------------------
  -- Fixture: the org exists before its IT admin ever signs in. Its
  -- default_member_role is deliberately 'broker', NOT the column default, so
  -- that a wrong answer is unambiguous: 'broker' means "fell through to the
  -- default role", which is exactly the bug this control hunts.
  ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data) VALUES
    (k_inviter, 'c3-inviter@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c3-inviter'),
     jsonb_build_object('provider', 'email')),
    (k_user_a, 'c3-itadmin@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c3-a'),
     jsonb_build_object('provider', 'azure'));

  INSERT INTO organizations (id, name, slug, microsoft_tenant_id, plan, max_seats, default_member_role)
  VALUES (k_org_id, k_name, k_slug, k_tenant, 'trial', 10, 'broker');

  -- Two UNCLAIMED invitations. user_id IS NULL on both; UNIQUE
  -- (organization_id, user_id) permits this because SQL NULLs are distinct.
  INSERT INTO organization_members (
    organization_id, user_id, invited_email, role, license_status,
    invitation_token, invitation_expires_at, invited_by, invited_at,
    provisioned_by, provisioning_metadata
  ) VALUES
    (k_org_id, NULL, 'c3-invitee-agent@fixture-3096.example.test', 'agent', 'pending',
     'fixture-token-3096-c3-agent', NOW() + INTERVAL '7 days', k_inviter, NOW(),
     'invite', jsonb_build_object('intended_license_status', 'active')),
    (k_org_id, NULL, 'c3-invitee-admin@fixture-3096.example.test', 'admin', 'pending',
     'fixture-token-3096-c3-admin', NOW() + INTERVAL '7 days', k_inviter, NOW(),
     'invite', jsonb_build_object('intended_license_status', 'active'));

  -- Pre-register what the fixture contains, so a silently-empty fixture cannot
  -- pass this control by accident.
  SELECT count(*) INTO v_unclaimed
  FROM organization_members
  WHERE organization_id = k_org_id AND user_id IS NULL;
  ASSERT v_unclaimed = 2,
         format('CONTROL 3: fixture is wrong -- expected 2 unclaimed invite rows, seeded %s', v_unclaimed);

  ASSERT NOT EXISTS (
           SELECT 1 FROM organization_members
           WHERE organization_id = k_org_id AND user_id IS NOT NULL
         ),
         'CONTROL 3: fixture is wrong -- the org must start with zero CLAIMED members';

  ---------------------------------------------------------------------------
  -- Act: the customer's IT admin opens /setup for the first time.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_user_a::text, true);
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);
  ASSERT (v_result->>'success')::boolean,
         format('CONTROL 3: RPC did not succeed: %s', v_result);
  ASSERT (v_result->>'organization_id')::uuid = k_org_id,
         'CONTROL 3: caller was routed to a different organization, not the pre-created one';

  SELECT role INTO v_role_a FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_user_a;

  ASSERT v_role_a = 'admin',
         format('CONTROL 3: the IT admin of a pre-created org got role %L, expected admin. '
                'Unclaimed invitations are being counted as members.', v_role_a);

  -- The invitations must be untouched: still unclaimed, still their own roles.
  ASSERT (SELECT count(*) FROM organization_members
           WHERE organization_id = k_org_id AND user_id IS NULL) = 2,
         'CONTROL 3: the unclaimed invitation rows were modified';

  ---------------------------------------------------------------------------
  -- Cleanup
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE id = k_org_id;
  DELETE FROM public.users WHERE id IN (k_inviter, k_user_a);
  DELETE FROM auth.users WHERE id IN (k_inviter, k_user_a);

  RAISE NOTICE 'CONTROL 3 PASSED: pre-created org with unclaimed invites still yields admin';
END
$control$;
