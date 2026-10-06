-- A user whose email does not match: cannot see or change the invite.
DO $$ DECLARE m text; before text; BEGIN
  before := pg_temp.snap(pg_temp.id('inv_a'));
  m := pg_temp.as_user(pg_temp.ub(), 'other-3679@example.test',
    $q$select (select count(*) from public.organization_members where id='{inv_a}')$q$);
  PERFORM pg_temp.check('k05 other user cannot see the invite', m = 'OK 0', m);
  m := pg_temp.as_user(pg_temp.ub(), 'other-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), license_status='active', joined_at=now(), invitation_token=null where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k05 other user cannot accept it', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.ub(), 'other-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), role='admin'$q$);
  PERFORM pg_temp.check('k05 other user no-WHERE update touches nothing', pg_temp.refused(m), m);
  -- JWT email claim spoof is not possible client-side, but a matching email with a
  -- different sub still cannot link a third user
  m := pg_temp.as_user(pg_temp.ub(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id='{u_a}' where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k05 claims email but links a different user id', pg_temp.refused(m), m);
  m := pg_temp.as_role('anon', NULL, NULL,
    $q$update public.organization_members set user_id=null, role='admin'$q$);
  PERFORM pg_temp.check('k05 anon touches nothing', pg_temp.refused(m), m);
  PERFORM pg_temp.check('k05 invite row unchanged', pg_temp.snap(pg_temp.id('inv_a')) = before);
END $$;
