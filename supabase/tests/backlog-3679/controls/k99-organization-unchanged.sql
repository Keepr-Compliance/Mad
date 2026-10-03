-- Client-role updates keep organization_id unchanged (k99: admin of the row's
-- organization; k99b: admin of the target organization only; k99d: admin of
-- both). k99c: an admin's update keeps user_id unchanged.
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

-- k99c: B has a personal organization; an O1 admin points O1 rows at B.
INSERT INTO public.organizations (id, name, slug, personal_owner_user_id)
  VALUES (pg_temp.id('org_pb'), 'Personal B 3679', 'personal-b-3679', pg_temp.id('u_b'));
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status)
  VALUES (pg_temp.id('m_pb'), pg_temp.id('org_pb'), pg_temp.id('u_b'), 'admin', 'active');
DO $$ DECLARE m text; before_m text; BEGIN
  before_m := pg_temp.snap(pg_temp.id('m_member'));
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set user_id='{u_b}' where id='{m_member}'$q$, true);  -- kept if it succeeds
  PERFORM pg_temp.check('k99c admin edit of a member row keeps its user_id', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set user_id='{u_b}', license_status='active', joined_at=now(), invitation_token=null where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k99c admin edit of a pending invite keeps its user_id', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set user_id=null where id='{m_member}'$q$);
  PERFORM pg_temp.check('k99c admin edit clearing user_id', pg_temp.refused(m), m);
  PERFORM pg_temp.check('k99c rows and the other personal membership unchanged',
    pg_temp.snap(pg_temp.id('m_member')) = before_m
    AND EXISTS (SELECT 1 FROM public.organization_members WHERE id = pg_temp.id('m_pb')));
  -- the same admin edits role on that row normally (snapshot taken before any change)
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='broker', updated_at=now() where id='{m_member}'$q$);
  PERFORM pg_temp.check('k99c admin role edit still works', m = 'OK rows=1', m);
END $$;

-- k99d: C is made admin of O2 as well; moving an O1 row into O2 (where the
-- row-level policy would accept it) is still refused, user_id unchanged.
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status)
  VALUES (pg_temp.id('m_c_o2'), pg_temp.id('org2'), pg_temp.uc(), 'admin', 'active');
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set organization_id='{org2}' where id='{m_member}'$q$);
  PERFORM pg_temp.check('k99d admin of both organizations cannot move a member row', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set organization_id='{org2}' where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k99d admin of both organizations cannot move a pending invite', pg_temp.refused(m), m);
END $$;
