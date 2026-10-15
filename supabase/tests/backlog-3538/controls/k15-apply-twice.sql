-- harness: apply-twice
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('k15 after applying twice: one guard trigger',
    (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass AND tgname='guard_invite_acceptance') = 1);
  PERFORM pg_temp.check('k15 after applying twice: anon has no EXECUTE on claim_pending_invite()',
    NOT has_function_privilege('anon', 'public.claim_pending_invite()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.claim_pending_invite()', 'EXECUTE'));
  PERFORM pg_temp.check('k15 after applying twice: link function absent',
    to_regprocedure('public.handle_new_user_invitation_link()') IS NULL);
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id='{u_a}', license_status='active', joined_at='2020-01-01', invitation_token=null where id='{inv_a}'$q$, true);
  PERFORM pg_temp.check('k15 after applying twice: accept pins joined_at',
    m = 'OK rows=1' AND (SELECT joined_at FROM public.organization_members WHERE id = pg_temp.id('inv_a')) = now(), m);
END $$;
