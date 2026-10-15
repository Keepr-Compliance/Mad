-- harness: rollback
-- After rollback-3538.sql the catalogue matches the fingerprint taken after the
-- 3679 file and before the 3538 file, and the 3679 behaviour is back.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('k16 catalogue fingerprint restored',
    pg_temp.fp3538() = current_setting('t3538.fp_before'), pg_temp.fp3538() || ' vs ' || current_setting('t3538.fp_before'));
  PERFORM pg_temp.check('k16 anon can execute claim_pending_invite() again',
    has_function_privilege('anon', 'public.claim_pending_invite()', 'EXECUTE'));
  PERFORM pg_temp.check('k16 link function restored (definition md5 as in production)',
    md5(pg_get_functiondef(to_regprocedure('public.handle_new_user_invitation_link()'))) = '7a729dffa5e5b01f4a680eb137d1d648');
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id='{u_a}', license_status='active', joined_at='2020-01-01', invitation_token=null where id='{inv_a}'$q$, true);
  PERFORM pg_temp.check('k16 after rollback: client joined_at kept again (3679 behaviour)',
    m = 'OK rows=1' AND (SELECT joined_at FROM public.organization_members WHERE id = pg_temp.id('inv_a')) = '2020-01-01'::timestamptz, m);
END $$;
