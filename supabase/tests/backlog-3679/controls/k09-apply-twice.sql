-- harness: apply-twice
DO $$ BEGIN
  PERFORM pg_temp.check('k09 after applying twice: one guard trigger',
    (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass AND tgname='guard_invite_acceptance') = 1);
  PERFORM pg_temp.check('k09 after applying twice: 4 policies',
    (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='organization_members') = 4);
END $$;
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), role='admin' where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k09 after applying twice: (a) refused', pg_temp.refused(m), m);
END $$;
