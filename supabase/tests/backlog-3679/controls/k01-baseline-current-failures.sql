-- harness: baseline
-- Production as it is (3679 NOT applied): the broker-portal admin actions and
-- the sign-in callback's invite acceptance fail for signed-in users.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='broker', updated_at=now() where id='{m_member}'$q$);
  PERFORM pg_temp.check('k01 baseline: admin Edit role fails', m LIKE 'ERR 42501 permission denied for table users%', m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set invitation_token='tok-new', invitation_expires_at=now()+interval '7 days' where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k01 baseline: admin Resend invite fails', m LIKE 'ERR 42501 permission denied for table users%', m);
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$select (select count(*) from public.organization_members where invited_email='invitee-3679@example.test' and user_id is null)$q$);
  PERFORM pg_temp.check('k01 baseline: invitee cannot see own pending invite', m = 'OK 0', m);
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), license_status='active', joined_at=now(), invitation_token=null where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k01 baseline: invitee callback UPDATE fails', m LIKE 'ERR 42501 permission denied for table users%', m);
END $$;
