-- K6: an O1 admin can no longer change licence status or other member columns.
DO $$ DECLARE m text; before_m text; before_g text; v_used int; t record; BEGIN
  before_m := pg_temp.snap(pg_temp.id('m_member'));
  before_g := pg_temp.snap(pg_temp.id('m_g'));
  -- deactivateUser.ts's old direct write
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set license_status='suspended', updated_at=now() where id='{m_member}'$q$, true);
  PERFORM pg_temp.check('k26 admin UPDATE license_status active->suspended refused (42501)', pg_temp.is42501(m), m);
  -- reactivating a suspended member while O1 is at its seat limit
  SELECT count(*) INTO v_used FROM public.organization_members
   WHERE organization_id = pg_temp.id('org1') AND license_status IN ('active','pending');
  UPDATE public.organizations SET max_seats = v_used WHERE id = pg_temp.id('org1');
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set license_status='active' where id='{m_g}'$q$, true);
  PERFORM pg_temp.check('k26 admin reactivation over the seat limit refused (42501)', pg_temp.is42501(m), m);
  FOR t IN SELECT * FROM (VALUES
      ('joined_at',            $q$update public.organization_members set joined_at='2020-01-01' where id='{m_member}'$q$),
      ('provisioned_by',       $q$update public.organization_members set provisioned_by='scim' where id='{m_member}'$q$),
      ('invited_email',        $q$update public.organization_members set invited_email='x-3843@example.test' where id='{m_member}'$q$),
      ('invited_by',           $q$update public.organization_members set invited_by='{u_c}' where id='{m_member}'$q$),
      ('idp_groups',           $q$update public.organization_members set idp_groups=array['g'] where id='{m_member}'$q$),
      ('scim_synced_at',       $q$update public.organization_members set scim_synced_at=now() where id='{m_member}'$q$),
      ('provisioning_metadata',$q$update public.organization_members set provisioning_metadata='{"k":1}' where id='{m_member}'$q$),
      ('license_status on a pending invite', $q$update public.organization_members set license_status='active' where id='{inv_a}'$q$),
      ('role + license_status', $q$update public.organization_members set role='broker', license_status='expired' where id='{m_member}'$q$)
    ) v(col, stmt) LOOP
    m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test', t.stmt, true);
    PERFORM pg_temp.check('k26 admin UPDATE ' || t.col || ' refused (42501)', pg_temp.is42501(m), m);
  END LOOP;
  PERFORM pg_temp.check('k26 member rows unchanged',
    pg_temp.snap(pg_temp.id('m_member')) = before_m AND pg_temp.snap(pg_temp.id('m_g')) = before_g);
END $$;
