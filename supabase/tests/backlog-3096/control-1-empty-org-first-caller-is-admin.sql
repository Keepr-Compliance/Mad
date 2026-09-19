-- BACKLOG-3096 / CONTROL 1
-- Empty org, first caller through /setup -> 'admin'.
--
-- This control is GREEN UNDER THE OLD BODY TOO, by design: first-user-wins
-- agrees with the old hard-coded 'admin' whenever the caller really is first.
-- It exists to prove the fix did not overshoot -- it reds under the
-- "unconditional default role" mutant (mutants/03-*.sql).
--
-- ALL IDENTIFIERS BELOW ARE INVENTED. No real organization name, email domain,
-- Microsoft tenant GUID or organization UUID appears in this file. Tenants are
-- the string 'fixture-tenant-3096-*'; emails are under the reserved
-- .example.test domain; UUIDs are in the 00000000-0000-4000-8000-0000003096xx
-- block, which no real row uses.
--
-- HOW TO RUN:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-1-empty-org-first-caller-is-admin.sql
-- Run as the database owner/superuser. Do NOT `SET ROLE authenticated`: the
-- function is SECURITY DEFINER so it runs as its owner either way, and
-- switching role would RLS-filter the asserting SELECTs and fail this test for
-- the wrong reason. The grant is asserted directly instead, below.
--
-- The whole thing is one DO block, i.e. one statement, i.e. one transaction: a
-- failing ASSERT rolls the fixtures back on its own. The leading DELETE makes
-- the file re-runnable across mutant runs.

DO $control$
DECLARE
  k_tenant   CONSTANT TEXT := 'fixture-tenant-3096-c1';
  k_slug     CONSTANT TEXT := 'fixture-org-3096-c1';
  k_name     CONSTANT TEXT := 'Fixture Org 3096 C1';
  k_user_a   CONSTANT UUID := '00000000-0000-4000-8000-000000309611'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  v_org_id   UUID;
  v_result   JSONB;
  v_role_a   TEXT;
BEGIN
  -- The RPC must still be callable by the role the portal authenticates as.
  ASSERT has_function_privilege(
           'authenticated',
           'public.auto_provision_it_admin(text,text,text)',
           'EXECUTE'
         ),
         'CONTROL 1: authenticated lost EXECUTE on auto_provision_it_admin';

  ---------------------------------------------------------------------------
  -- Fixture teardown-first (re-runnable)
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE microsoft_tenant_id = k_tenant;
  DELETE FROM public.users WHERE id = k_user_a;
  DELETE FROM auth.users WHERE id = k_user_a;

  ---------------------------------------------------------------------------
  -- Fixture: one signed-in Azure user, no organization at all for this tenant.
  -- Inserting into auth.users fires on_auth_user_created -> handle_new_user(),
  -- which creates the matching public.users row. Nothing else is created.
  ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  VALUES (
    k_user_a,
    'c1-first@fixture-3096.example.test',
    jsonb_build_object('provider_id', 'fixture-oauth-3096-c1-a'),
    jsonb_build_object('provider', 'azure')
  );

  ---------------------------------------------------------------------------
  -- Act: user A opens /setup. auth.uid() reads request.jwt.claim.sub.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_user_a::text, true);
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);

  ASSERT (v_result->>'success')::boolean,
         format('CONTROL 1: RPC did not succeed: %s', v_result);

  SELECT id INTO v_org_id FROM organizations WHERE microsoft_tenant_id = k_tenant;
  ASSERT v_org_id IS NOT NULL, 'CONTROL 1: no organization was created';

  ---------------------------------------------------------------------------
  -- Assert on the EXACT role of a NAMED user id, never on a count.
  ---------------------------------------------------------------------------
  SELECT role INTO v_role_a
  FROM organization_members
  WHERE organization_id = v_org_id AND user_id = k_user_a;

  ASSERT v_role_a = 'admin',
         format('CONTROL 1: first caller into an empty org got role %L, expected admin', v_role_a);

  ---------------------------------------------------------------------------
  -- Cleanup
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE microsoft_tenant_id = k_tenant;
  DELETE FROM public.users WHERE id = k_user_a;
  DELETE FROM auth.users WHERE id = k_user_a;

  RAISE NOTICE 'CONTROL 1 PASSED: first caller into an empty org is admin';
END
$control$;
