-- harness: apply-twice
-- K11a: applying the 3843 file twice raises nothing and keeps the behaviour.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('k30 one organization guard trigger',
    (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.organizations'::regclass AND tgname='guard_organization_client_update') = 1);
  PERFORM pg_temp.check('k30 one member guard trigger, BEFORE INSERT OR UPDATE',
    (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass AND tgname='guard_invite_acceptance' AND tgtype = 23) = 1);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organizations set max_seats = 500 where id='{org1}'$q$);
  PERFORM pg_temp.check('k30 max_seats still refused', pg_temp.org_refused(m), m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='broker', updated_at=now() where id='{m_member}'$q$);
  PERFORM pg_temp.check('k30 role edit still works', m = 'OK rows=1', m);
END $$;
