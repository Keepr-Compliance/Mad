-- BACKLOG-3096 / CONTROL 6
-- Org with ONE CLAIMED member (an agent) and NO admin -> the next caller joins
-- as the default role, NOT as admin.
--
-- This is the case the rejected reading gets wrong. Under "admin iff the org
-- has no admin yet", an org whose only admin was demoted or departed hands
-- administration to whoever opens /setup next -- an escalation path created by
-- ordinary staff turnover. Such an org exists in production today. The repair
-- for a headless org is the admin portal, not the next person through the door.
--
-- This control also exercises the COALESCE fallback: default_member_role is
-- left NULL on purpose, so 'agent' can only come from
-- COALESCE(default_member_role, 'agent').
--
-- Reds under mutants/01-old-live-body.sql (the caller lands as 'admin').
--
-- ALL IDENTIFIERS BELOW ARE INVENTED -- see the header of control 1.
--
-- HOW TO RUN:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-6-claimed-agent-no-admin-new-caller-is-agent.sql

DO $control$
DECLARE
  k_tenant     CONSTANT TEXT := 'fixture-tenant-3096-c6';
  k_slug       CONSTANT TEXT := 'fixture-org-3096-c6';
  k_name       CONSTANT TEXT := 'Fixture Org 3096 C6';
  k_org_id     CONSTANT UUID := '00000000-0000-4000-8000-00003096c6f0'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_agent      CONSTANT UUID := '00000000-0000-4000-8000-000000309661'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_newcomer   CONSTANT UUID := '00000000-0000-4000-8000-000000309662'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  v_result     JSONB;
  v_role_new   TEXT;
  v_role_agent TEXT;
BEGIN
  ---------------------------------------------------------------------------
  -- Fixture teardown-first (re-runnable)
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE id = k_org_id OR microsoft_tenant_id = k_tenant;
  DELETE FROM public.users WHERE id IN (k_agent, k_newcomer);
  DELETE FROM auth.users WHERE id IN (k_agent, k_newcomer);

  ---------------------------------------------------------------------------
  -- Fixture: a headless org -- one claimed agent, nobody with admin.
  -- default_member_role NULL exercises the COALESCE fallback.
  ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data) VALUES
    (k_agent, 'c6-agent@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c6-agent'),
     jsonb_build_object('provider', 'azure')),
    (k_newcomer, 'c6-newcomer@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c6-new'),
     jsonb_build_object('provider', 'azure'));

  INSERT INTO organizations (id, name, slug, microsoft_tenant_id, plan, max_seats, default_member_role)
  VALUES (k_org_id, k_name, k_slug, k_tenant, 'trial', 10, NULL);

  INSERT INTO organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by)
  VALUES (k_org_id, k_agent, 'agent', NOW() - INTERVAL '10 days', 'active', 'jit');

  ASSERT NOT EXISTS (
           SELECT 1 FROM organization_members
           WHERE organization_id = k_org_id AND role = 'admin'
         ),
         'CONTROL 6: fixture is wrong -- the org must start with NO admin';
  ASSERT (SELECT default_member_role FROM organizations WHERE id = k_org_id) IS NULL,
         'CONTROL 6: fixture is wrong -- default_member_role must be NULL to exercise the COALESCE';

  ---------------------------------------------------------------------------
  -- Act: an employee opens /setup at an org that has lost its admin.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_newcomer::text, true);
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);
  ASSERT (v_result->>'success')::boolean,
         format('CONTROL 6: RPC did not succeed: %s', v_result);
  ASSERT (v_result->>'organization_id')::uuid = k_org_id,
         'CONTROL 6: caller was routed to a different organization';

  SELECT role INTO v_role_new   FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_newcomer;
  SELECT role INTO v_role_agent FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_agent;

  ASSERT v_role_new = 'agent',
         format('CONTROL 6: caller at a headless org got role %L, expected agent. '
                'Losing an admin must not promote the next arrival.', v_role_new);
  ASSERT v_role_agent = 'agent',
         format('CONTROL 6: the existing member now holds role %L', v_role_agent);

  ---------------------------------------------------------------------------
  -- Cleanup
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE id = k_org_id;
  DELETE FROM public.users WHERE id IN (k_agent, k_newcomer);
  DELETE FROM auth.users WHERE id IN (k_agent, k_newcomer);

  RAISE NOTICE 'CONTROL 6 PASSED: a headless org does not promote the next arrival';
END
$control$;
