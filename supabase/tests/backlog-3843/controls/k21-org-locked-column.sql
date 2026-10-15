-- K1: an O1 admin (authenticated) cannot change organizations.max_seats; the row is unchanged.
DO $$ DECLARE m text; before_o text; BEGIN
  before_o := pg_temp.osnap(pg_temp.id('org1'));
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organizations set max_seats = 500 where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k21 admin UPDATE organizations.max_seats refused by the guard (42501)', pg_temp.org_refused(m), m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organizations set plan = 'enterprise', max_seats = 500, retention_years = 3 where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k21 mixed statement (allowed + locked columns) refused', pg_temp.org_refused(m), m);
  PERFORM pg_temp.check('k21 organization row unchanged', pg_temp.osnap(pg_temp.id('org1')) = before_o);
END $$;
