-- K5: internal staff who is also an O1 admin, signed in as authenticated, gets no exemption.
DO $$ DECLARE m text; before_o text; before_m text; BEGIN
  before_o := pg_temp.osnap(pg_temp.id('org1'));
  before_m := pg_temp.snap(pg_temp.id('m_member'));
  m := pg_temp.as_user(pg_temp.uf(), 'staff-3843@example.test',
    $q$update public.organizations set max_seats = 500 where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k25 staff+admin UPDATE organizations.max_seats refused', pg_temp.org_refused(m), m);
  m := pg_temp.as_user(pg_temp.uf(), 'staff-3843@example.test',
    $q$update public.organization_members set license_status='suspended' where id='{m_member}'$q$, true);
  PERFORM pg_temp.check('k25 staff+admin UPDATE member license_status refused', pg_temp.is42501(m), m);
  m := pg_temp.as_user(pg_temp.uf(), 'staff-3843@example.test',
    $q$insert into public.organization_members (organization_id, user_id, role, license_status) values ('{org1}', '{u_b}', 'agent', 'active')$q$, true);
  PERFORM pg_temp.check('k25 staff+admin INSERT of an active member refused', pg_temp.is42501(m), m);
  PERFORM pg_temp.check('k25 rows unchanged',
    pg_temp.osnap(pg_temp.id('org1')) = before_o AND pg_temp.snap(pg_temp.id('m_member')) = before_m
    AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = pg_temp.id('org1') AND user_id = pg_temp.ub()));
END $$;
