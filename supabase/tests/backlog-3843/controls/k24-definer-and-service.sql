-- K4: service_role, postgres and SECURITY DEFINER provisioning keep working.
DO $$ DECLARE m text; r record; BEGIN
  m := pg_temp.as_role('service_role', NULL, NULL,
    $q$update public.organizations set max_seats = 77, plan = 'pro' where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k24 service_role UPDATE organizations.max_seats', m = 'OK rows=1', m);
  m := pg_temp.as_role('postgres', NULL, NULL,
    $q$update public.organizations set max_seats = 78 where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k24 postgres UPDATE organizations.max_seats', m = 'OK rows=1', m);
  PERFORM pg_temp.check('k24 max_seats stored', (SELECT max_seats FROM public.organizations WHERE id = pg_temp.id('org1')) = 78);
  -- deactivateUser.ts after this change: service client, scoped by member id + organization
  m := pg_temp.as_role('service_role', NULL, NULL,
    $q$update public.organization_members set license_status='suspended', updated_at=now() where id='{m_member}' and organization_id='{org1}'$q$, true);
  PERFORM pg_temp.check('k24 service_role deactivate (license_status=suspended)', m = 'OK rows=1', m);
  m := pg_temp.as_role('service_role', NULL, NULL,
    $q$insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by) values ('{org2}', '{u_g}', 'agent', 'active', 'scim')$q$, true);
  PERFORM pg_temp.check('k24 service_role INSERT of an active member', m = 'OK rows=1', m);
  -- auto_provision_it_admin (SECURITY DEFINER) as a signed-in user: creates org + active admin membership
  m := pg_temp.as_user(pg_temp.uh(), 'founder-3843@example.test',
    $q$select public.auto_provision_it_admin('tenant-new-3843', 'New Org 3843', 'new-org-3843')$q$, true);
  PERFORM pg_temp.check('k24 auto_provision_it_admin succeeds', m LIKE 'OK %"success": true%', m);
  SELECT m2.role, m2.license_status INTO r FROM public.organization_members m2
    JOIN public.organizations o ON o.id = m2.organization_id
   WHERE o.microsoft_tenant_id = 'tenant-new-3843' AND m2.user_id = pg_temp.uh();
  PERFORM pg_temp.check('k24 auto_provision_it_admin stored an active admin membership',
    r.role = 'admin' AND r.license_status = 'active', concat_ws(',', r.role, r.license_status));
  -- jit_join_organization (SECURITY DEFINER): active membership in a JIT org
  m := pg_temp.as_user(pg_temp.ub(), 'other-3679@example.test',
    $q$select public.jit_join_organization('tenant-jit-3843')$q$, true);
  PERFORM pg_temp.check('k24 jit_join_organization succeeds', m LIKE 'OK %"success": true%' AND m LIKE '%"already_member": false%', m);
  PERFORM pg_temp.check('k24 jit_join_organization stored an active membership',
    EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = pg_temp.id('org_jit') AND user_id = pg_temp.ub() AND license_status = 'active'));
END $$;
