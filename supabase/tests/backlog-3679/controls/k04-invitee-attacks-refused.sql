-- (a) role, (b) organization, (c) license status, and other columns: refused for the invitee.
DO $$ DECLARE m text; before text; s text; label text; BEGIN
  before := pg_temp.snap(pg_temp.id('inv_a'));
  FOR label, s IN VALUES
    ('k04 (a) by id: user_id=self, role=admin', $q$update public.organization_members set user_id=auth.uid(), role='admin', joined_at=now() where id='{inv_a}'$q$),
    ('k04 (a) no WHERE: user_id=self, role=admin', $q$update public.organization_members set user_id=auth.uid(), role='admin'$q$),
    ('k04 (a) role only', $q$update public.organization_members set role='admin' where id='{inv_a}'$q$),
    ('k04 (b) by id: organization -> O2 + self', $q$update public.organization_members set organization_id='{org2}', user_id=auth.uid() where id='{inv_a}'$q$),
    ('k04 (b) no WHERE: organization -> O2', $q$update public.organization_members set organization_id='{org2}'$q$),
    ('k04 (c) by id: license_status=suspended', $q$update public.organization_members set license_status='suspended' where id='{inv_a}'$q$),
    ('k04 (c) link self + license_status=expired', $q$update public.organization_members set user_id=auth.uid(), license_status='expired' where id='{inv_a}'$q$),
    ('k04 (c) no WHERE: license_status=active (no link)', $q$update public.organization_members set license_status='active'$q$),
    ('k04 link self + new invitation_token', $q$update public.organization_members set user_id=auth.uid(), invitation_token='mine' where id='{inv_a}'$q$),
    ('k04 link self + extend expiry', $q$update public.organization_members set user_id=auth.uid(), invitation_expires_at=now()+interval '1 year' where id='{inv_a}'$q$),
    ('k04 link self + invited_by', $q$update public.organization_members set user_id=auth.uid(), invited_by=auth.uid() where id='{inv_a}'$q$),
    ('k04 link self + provisioning_metadata', $q$update public.organization_members set user_id=auth.uid(), provisioning_metadata='{"x":1}' where id='{inv_a}'$q$),
    ('k04 link someone else', $q$update public.organization_members set user_id='{u_b}' where id='{inv_a}'$q$),
    ('k04 change invited_email to keep access', $q$update public.organization_members set invited_email='x@example.test' where id='{inv_a}'$q$)
  LOOP
    m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test', s);
    PERFORM pg_temp.check(label, pg_temp.refused(m), m);
  END LOOP;
  PERFORM pg_temp.check('k04 invite row unchanged after all attempts', pg_temp.snap(pg_temp.id('inv_a')) = before);

  -- D is admin of O2 and holds an invite in O1: moving that invite into O2 (where
  -- the WITH CHECK of organization_members_all_public would accept the new row)
  -- or raising its role is still refused.
  m := pg_temp.as_user(pg_temp.ud(), 'admin2-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), organization_id='{org2}' where id='{inv_d}'$q$);
  PERFORM pg_temp.check('k04 cross-policy: admin of O2 moves own O1 invite into O2', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.ud(), 'admin2-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), role='admin' where id='{inv_d}'$q$);
  PERFORM pg_temp.check('k04 cross-policy: admin of O2 links own O1 invite as admin', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.ud(), 'admin2-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), license_status='active', joined_at=now(), invitation_token=null where id='{inv_d}'$q$);
  PERFORM pg_temp.check('k04 cross-policy: same user can still accept normally', m = 'OK rows=1', m);
END $$;
