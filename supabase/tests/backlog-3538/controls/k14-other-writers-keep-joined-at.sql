-- Writers that are not an invitee's accept leave joined_at alone. Both rows were
-- dated 2021-05-05 by fixtures-3538.sql before any guard existed.
DO $$ DECLARE m text; BEGIN
  -- updateUserRole.ts, as the O1 admin
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='broker', updated_at=now() where id='{m_member}'$q$, true);
  PERFORM pg_temp.check('k14 admin: role edit succeeds', m = 'OK rows=1', m);
  PERFORM pg_temp.check('k14 admin: role edit keeps joined_at',
    (SELECT joined_at FROM public.organization_members WHERE id = pg_temp.id('m_member')) = '2021-05-05 00:00:00+00',
    (SELECT joined_at::text FROM public.organization_members WHERE id = pg_temp.id('m_member')));
  -- directory-sync / scim shape, as service_role, on a claimed row
  m := pg_temp.as_role('service_role', NULL, NULL,
    $q$update public.organization_members set role='broker', scim_synced_at=now() where id='{m_claimed}'$q$, true);
  PERFORM pg_temp.check('k14 service_role: update succeeds', m = 'OK rows=1', m);
  PERFORM pg_temp.check('k14 service_role: update keeps joined_at',
    (SELECT joined_at FROM public.organization_members WHERE id = pg_temp.id('m_claimed')) = '2021-05-05 00:00:00+00',
    (SELECT joined_at::text FROM public.organization_members WHERE id = pg_temp.id('m_claimed')));
END $$;
