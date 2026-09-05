-- BACKLOG-3096 / CONTROL 2  ***THE CONTROL THAT MATTERS***
-- Same org, a second DIFFERENT caller -> NOT admin; joins as the default role.
--
-- This is the reported defect. It FAILS against the live body shipped before
-- this change (both callers land as 'admin') and must fail again the moment
-- mutants/01-old-live-body.sql is applied.
--
-- ALL IDENTIFIERS BELOW ARE INVENTED -- see the header of control 1.
--
-- HOW TO RUN:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-2-second-caller-same-org-is-not-admin.sql
-- Run as the database owner/superuser; do NOT `SET ROLE authenticated` (see control 1).

DO $control$
DECLARE
  k_tenant   CONSTANT TEXT := 'fixture-tenant-3096-c2';
  k_slug     CONSTANT TEXT := 'fixture-org-3096-c2';
  k_name     CONSTANT TEXT := 'Fixture Org 3096 C2';
  k_user_a   CONSTANT UUID := '00000000-0000-4000-8000-000000309621'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_user_b   CONSTANT UUID := '00000000-0000-4000-8000-000000309622'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  v_org_id   UUID;
  v_result   JSONB;
  v_role_a   TEXT;
  v_role_b   TEXT;
BEGIN
  ---------------------------------------------------------------------------
  -- Fixture teardown-first (re-runnable)
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE microsoft_tenant_id = k_tenant;
  DELETE FROM public.users WHERE id IN (k_user_a, k_user_b);
  DELETE FROM auth.users WHERE id IN (k_user_a, k_user_b);

  ---------------------------------------------------------------------------
  -- Fixture: two colleagues in the same Microsoft tenant. No org yet.
  ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data) VALUES
    (k_user_a, 'c2-first@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c2-a'),
     jsonb_build_object('provider', 'azure')),
    (k_user_b, 'c2-second@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c2-b'),
     jsonb_build_object('provider', 'azure'));

  ---------------------------------------------------------------------------
  -- Act 1: colleague A opens /setup first. Creates the org, becomes admin.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_user_a::text, true);
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);
  ASSERT (v_result->>'success')::boolean,
         format('CONTROL 2: RPC failed for caller A: %s', v_result);

  SELECT id INTO v_org_id FROM organizations WHERE microsoft_tenant_id = k_tenant;
  ASSERT v_org_id IS NOT NULL, 'CONTROL 2: no organization was created';

  ---------------------------------------------------------------------------
  -- Act 2: colleague B opens /setup afterwards, same tenant.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_user_b::text, true);
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);
  ASSERT (v_result->>'success')::boolean,
         format('CONTROL 2: RPC failed for caller B: %s', v_result);

  -- Both must land in the SAME org -- if B created a second org the defect is
  -- different but no less real, so check it rather than assume it.
  ASSERT (v_result->>'organization_id')::uuid = v_org_id,
         'CONTROL 2: caller B was routed to a different organization';

  ---------------------------------------------------------------------------
  -- Assert on the EXACT role of each NAMED user id.
  ---------------------------------------------------------------------------
  SELECT role INTO v_role_a FROM organization_members
   WHERE organization_id = v_org_id AND user_id = k_user_a;
  SELECT role INTO v_role_b FROM organization_members
   WHERE organization_id = v_org_id AND user_id = k_user_b;

  ASSERT v_role_a = 'admin',
         format('CONTROL 2: caller A got role %L, expected admin', v_role_a);

  -- The org was created by the RPC, so default_member_role is the column
  -- default, 'agent'.
  ASSERT v_role_b = 'agent',
         format('CONTROL 2: SECOND caller got role %L, expected agent. '
                'Anyone in the tenant can administer this org.', v_role_b);

  ---------------------------------------------------------------------------
  -- Cleanup
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE microsoft_tenant_id = k_tenant;
  DELETE FROM public.users WHERE id IN (k_user_a, k_user_b);
  DELETE FROM auth.users WHERE id IN (k_user_a, k_user_b);

  RAISE NOTICE 'CONTROL 2 PASSED: second caller into an existing org is agent, not admin';
END
$control$;
