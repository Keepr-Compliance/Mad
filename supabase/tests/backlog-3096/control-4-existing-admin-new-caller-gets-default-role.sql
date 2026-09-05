-- BACKLOG-3096 / CONTROL 4
-- Org with an existing CLAIMED admin -> a new caller joins as the org's
-- default_member_role, and the existing admin's row is not touched.
--
-- Reds under mutants/01-old-live-body.sql (the new caller lands as 'admin').
--
-- The org's default_member_role is deliberately 'broker', not the column
-- default 'agent': a result of 'broker' proves the value was READ FROM THE ORG
-- rather than hard-coded, which a fixture using the default cannot show.
--
-- ALL IDENTIFIERS BELOW ARE INVENTED -- see the header of control 1.
--
-- HOW TO RUN:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-4-existing-admin-new-caller-gets-default-role.sql

DO $control$
DECLARE
  k_tenant       CONSTANT TEXT := 'fixture-tenant-3096-c4';
  k_slug         CONSTANT TEXT := 'fixture-org-3096-c4';
  k_name         CONSTANT TEXT := 'Fixture Org 3096 C4';
  k_org_id       CONSTANT UUID := '00000000-0000-4000-8000-00003096c4f0'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_admin        CONSTANT UUID := '00000000-0000-4000-8000-000000309641'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_newcomer     CONSTANT UUID := '00000000-0000-4000-8000-000000309642'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  v_result       JSONB;
  v_role_admin   TEXT;
  v_role_new     TEXT;
  v_admin_row_before  organization_members%ROWTYPE;
  v_admin_row_after   organization_members%ROWTYPE;
BEGIN
  ---------------------------------------------------------------------------
  -- Fixture teardown-first (re-runnable)
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE id = k_org_id OR microsoft_tenant_id = k_tenant;
  DELETE FROM public.users WHERE id IN (k_admin, k_newcomer);
  DELETE FROM auth.users WHERE id IN (k_admin, k_newcomer);

  ---------------------------------------------------------------------------
  -- Fixture: an established org -- one claimed admin already in place.
  ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data) VALUES
    (k_admin, 'c4-admin@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c4-admin'),
     jsonb_build_object('provider', 'azure')),
    (k_newcomer, 'c4-newcomer@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c4-new'),
     jsonb_build_object('provider', 'azure'));

  INSERT INTO organizations (id, name, slug, microsoft_tenant_id, plan, max_seats, default_member_role)
  VALUES (k_org_id, k_name, k_slug, k_tenant, 'trial', 10, 'broker');

  INSERT INTO organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by)
  VALUES (k_org_id, k_admin, 'admin', NOW() - INTERVAL '30 days', 'active', 'manual');

  SELECT * INTO v_admin_row_before FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_admin;

  ---------------------------------------------------------------------------
  -- Act: a colleague from the same tenant opens /setup.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_newcomer::text, true);
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);
  ASSERT (v_result->>'success')::boolean,
         format('CONTROL 4: RPC did not succeed: %s', v_result);
  ASSERT (v_result->>'organization_id')::uuid = k_org_id,
         'CONTROL 4: caller was routed to a different organization';

  SELECT role INTO v_role_new   FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_newcomer;
  SELECT role INTO v_role_admin FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_admin;

  ASSERT v_role_new = 'broker',
         format('CONTROL 4: newcomer got role %L, expected broker (the org default_member_role)', v_role_new);
  ASSERT v_role_admin = 'admin',
         format('CONTROL 4: the existing admin now holds role %L', v_role_admin);

  -- No existing membership row may change at all -- not the role, not the id,
  -- not joined_at, not the licence, not the provisioning provenance.
  SELECT * INTO v_admin_row_after FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_admin;
  ASSERT v_admin_row_after IS NOT DISTINCT FROM v_admin_row_before,
         'CONTROL 4: the pre-existing admin membership row was modified';

  ---------------------------------------------------------------------------
  -- Cleanup
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE id = k_org_id;
  DELETE FROM public.users WHERE id IN (k_admin, k_newcomer);
  DELETE FROM auth.users WHERE id IN (k_admin, k_newcomer);

  RAISE NOTICE 'CONTROL 4 PASSED: newcomer joins an admin-held org as the default role';
END
$control$;
