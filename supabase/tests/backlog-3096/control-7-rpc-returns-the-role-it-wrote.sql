-- BACKLOG-3096 / CONTROL 7
-- The RPC must RETURN the role it wrote -- on the insert path AND on the
-- already-a-member path -- and the returned value must equal the stored row.
--
-- WHY THIS IS ITS OWN CONTROL rather than an extra assertion bolted onto
-- controls 1-6: mutant 01 (the old live body) has no 'role' key at all, so a
-- returned-role assertion inside every control would red every one of them for
-- a reason that has nothing to do with the role logic -- including controls 1
-- and 3, which are supposed to stay green under that mutant. One finding, one
-- red. This control is the one that owns the return shape.
--
-- WHY IT MATTERS BEYOND TIDINESS: broker-portal/app/auth/setup/callback/route.ts
-- now branches on this returned value to choose between the Microsoft
-- admin-consent page and /download. It deliberately does NOT re-query the
-- membership row, so that the callback and the database cannot disagree about
-- which branch was taken. That guarantee is only worth anything if the returned
-- value is in fact the value that was written.
--
-- The already-a-member path is exercised by NO other control: a caller who hits
-- /setup twice (a browser retry, a bookmarked callback) must get their real
-- role back the second time, not NULL. A NULL would make the route fail closed
-- to /download for someone who is genuinely the org's admin.
--
-- EXPECTED: reds under mutants/01-old-live-body.sql (no 'role' key -> the
-- returned value is NULL -> every ASSERT here fails). Green under mutants 02,
-- 03 and 04, none of which touches the return shape.
--
-- ALL IDENTIFIERS BELOW ARE INVENTED -- see the header of control 1.
--
-- HOW TO RUN:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-7-rpc-returns-the-role-it-wrote.sql

DO $control$
DECLARE
  k_tenant     CONSTANT TEXT := 'fixture-tenant-3096-c7';
  k_slug       CONSTANT TEXT := 'fixture-org-3096-c7';
  k_name       CONSTANT TEXT := 'Fixture Org 3096 C7';
  k_org_id     CONSTANT UUID := '00000000-0000-4000-8000-00003096c7f0'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_user_a     CONSTANT UUID := '00000000-0000-4000-8000-000000309671'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_user_b     CONSTANT UUID := '00000000-0000-4000-8000-000000309672'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  v_result     JSONB;
  v_stored     TEXT;
  v_member_id  UUID;
  v_member_id2 UUID;
BEGIN
  ---------------------------------------------------------------------------
  -- Fixture teardown-first (re-runnable)
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE id = k_org_id OR microsoft_tenant_id = k_tenant;
  DELETE FROM public.users WHERE id IN (k_user_a, k_user_b);
  DELETE FROM auth.users WHERE id IN (k_user_a, k_user_b);

  ---------------------------------------------------------------------------
  -- Fixture: pre-created org, zero claimed members, default role 'broker' so
  -- that "agent" cannot appear by accident from the column default.
  ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data) VALUES
    (k_user_a, 'c7-first@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c7-a'),
     jsonb_build_object('provider', 'azure')),
    (k_user_b, 'c7-second@fixture-3096.example.test',
     jsonb_build_object('provider_id', 'fixture-oauth-3096-c7-b'),
     jsonb_build_object('provider', 'azure'));

  INSERT INTO organizations (id, name, slug, microsoft_tenant_id, plan, max_seats, default_member_role)
  VALUES (k_org_id, k_name, k_slug, k_tenant, 'trial', 10, 'broker');

  ---------------------------------------------------------------------------
  -- Act 1: first caller. Insert path.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_user_a::text, true);
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);

  ASSERT v_result ? 'role',
         format('CONTROL 7: the RPC returned no role key at all: %s', v_result);

  SELECT role, id INTO v_stored, v_member_id
  FROM organization_members
  WHERE organization_id = k_org_id AND user_id = k_user_a;

  ASSERT v_stored = 'admin',
         format('CONTROL 7: fixture/logic drift -- first caller stored as %L', v_stored);
  ASSERT v_result->>'role' = v_stored,
         format('CONTROL 7: insert path returned role %L but the row holds %L',
                v_result->>'role', v_stored);

  ---------------------------------------------------------------------------
  -- Act 2: the SAME caller again. Already-a-member path -- a browser retry or
  -- a bookmarked callback. No other control exercises this.
  ---------------------------------------------------------------------------
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);

  ASSERT (v_result->>'success')::boolean,
         format('CONTROL 7: repeat call did not succeed: %s', v_result);
  ASSERT v_result->>'role' = 'admin',
         format('CONTROL 7: repeat caller got role %L back, expected admin. '
                'A NULL here fails a real admin closed to /download.',
                COALESCE(v_result->>'role', '<null>'));

  -- And it must not have written a second row or changed the first.
  SELECT id INTO v_member_id2 FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_user_a;
  ASSERT v_member_id2 = v_member_id,
         'CONTROL 7: the repeat call replaced the membership row';
  ASSERT (SELECT count(*) FROM organization_members
           WHERE organization_id = k_org_id AND user_id = k_user_a) = 1,
         'CONTROL 7: the repeat call created a duplicate membership row';

  ---------------------------------------------------------------------------
  -- Act 3: second, different caller. Insert path, default role this time --
  -- so the returned value is checked against something other than 'admin'.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_user_b::text, true);
  v_result := public.auto_provision_it_admin(k_tenant, k_name, k_slug);

  SELECT role INTO v_stored FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_user_b;

  ASSERT v_stored = 'broker',
         format('CONTROL 7: second caller stored as %L, expected broker', v_stored);
  ASSERT v_result->>'role' = v_stored,
         format('CONTROL 7: second caller returned role %L but the row holds %L. '
                'The callback would route them on a value the database disagrees with.',
                v_result->>'role', v_stored);

  -- The three original keys must survive: this addition is additive.
  ASSERT (v_result->>'success')::boolean
         AND (v_result->>'organization_id')::uuid = k_org_id
         AND (v_result->>'user_id')::uuid = k_user_b,
         format('CONTROL 7: an original return key was lost or changed: %s', v_result);

  ---------------------------------------------------------------------------
  -- Cleanup
  ---------------------------------------------------------------------------
  DELETE FROM organizations WHERE id = k_org_id;
  DELETE FROM public.users WHERE id IN (k_user_a, k_user_b);
  DELETE FROM auth.users WHERE id IN (k_user_a, k_user_b);

  RAISE NOTICE 'CONTROL 7 PASSED: the RPC returns the role it wrote, on both paths';
END
$control$;
