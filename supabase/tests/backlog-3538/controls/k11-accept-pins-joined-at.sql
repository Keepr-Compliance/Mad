-- The invitee's accept stores joined_at = now() whatever the client sends
-- (the broker-portal callback sends its own clock; here an old date).
DO $$ DECLARE m text; r record; BEGIN
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id='{u_a}', license_status='active', joined_at='2020-01-01', invitation_token=null where id='{inv_a}'$q$, true);
  PERFORM pg_temp.check('k11 accept sending joined_at=2020-01-01 succeeds', m = 'OK rows=1', m);
  SELECT * INTO r FROM public.organization_members WHERE id = pg_temp.id('inv_a');
  PERFORM pg_temp.check('k11 stored joined_at = now() of the accepting transaction',
    r.user_id = pg_temp.ua() AND r.joined_at = now(), coalesce(r.joined_at::text, '<null>') || ' vs ' || now()::text);
  -- informational: the guard definition this venue holds after the 3538 file
  PERFORM pg_temp.check('k11 info: guard definition md5 after 3538', true, pg_temp.guard_md5());
END $$;
