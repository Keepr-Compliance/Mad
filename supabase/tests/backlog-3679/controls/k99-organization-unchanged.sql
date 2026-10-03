-- Client-role updates keep organization_id unchanged (k99: admin of the row's
-- organization; k99b: admin of the target organization only).
DO $$ DECLARE m text; before_m text; before_i text; BEGIN
  before_m := pg_temp.snap(pg_temp.id('m_member'));
  before_i := pg_temp.snap(pg_temp.id('inv_a'));
  PERFORM pg_temp.check('k99 pre: C is not admin of O2', NOT public.is_org_admin(pg_temp.uc(), pg_temp.id('org2')));
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), invited_email='admin1-3679@example.test', organization_id='{org2}', role='admin' where id='{m_member}'$q$);
  PERFORM pg_temp.check('k99 admin edit of a member row keeps its organization', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), invited_email='admin1-3679@example.test', organization_id='{org2}', role='admin' where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k99 admin edit of a pending invite keeps its organization', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set organization_id='{org2}' where id='{m_member}'$q$);
  PERFORM pg_temp.check('k99 admin edit changing only the organization', pg_temp.refused(m), m);
  PERFORM pg_temp.check('k99 rows unchanged',
    pg_temp.snap(pg_temp.id('m_member')) = before_m AND pg_temp.snap(pg_temp.id('inv_a')) = before_i);
  -- D is admin of O2 only; inv_d is an O1 invite for D's email, moved without linking.
  m := pg_temp.as_user(pg_temp.ud(), 'admin2-3679@example.test',
    $q$update public.organization_members set organization_id='{org2}', role='admin' where id='{inv_d}'$q$);
  PERFORM pg_temp.check('k99b admin of the target organization cannot pull a row in', pg_temp.refused(m), m);
END $$;
