-- K7: the broker-portal admin member writes still work, and are stored.
DO $$ DECLARE m text; r record; BEGIN
  -- updateUserRole.ts
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='broker', updated_at=now() where id='{m_member}'$q$, true);
  PERFORM pg_temp.check('k27 admin Edit role', m = 'OK rows=1', m);
  -- bulkUpdateRole.ts
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='admin', updated_at=now() where organization_id='{org1}' and id in ('{m_member}') and user_id <> '{u_c}' returning id$q$, true);
  PERFORM pg_temp.check('k27 admin Bulk role', m = 'OK rows=1', m);
  -- resendInvite.ts
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set invitation_token='tok-3843-new', invitation_expires_at='2030-01-01T00:00:00Z' where id='{inv_a}'$q$, true);
  PERFORM pg_temp.check('k27 admin Resend invite', m = 'OK rows=1', m);
  SELECT role INTO r FROM public.organization_members WHERE id = pg_temp.id('m_member');
  PERFORM pg_temp.check('k27 role stored', r.role = 'admin', r.role);
  SELECT invitation_token, invitation_expires_at INTO r FROM public.organization_members WHERE id = pg_temp.id('inv_a');
  PERFORM pg_temp.check('k27 token + expiry stored',
    r.invitation_token = 'tok-3843-new' AND r.invitation_expires_at = '2030-01-01T00:00:00Z'::timestamptz,
    concat_ws(',', r.invitation_token, r.invitation_expires_at));
  -- removeUser.ts (DELETE; the guard is not on DELETE)
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$delete from public.organization_members where id='{m_g}'$q$);
  PERFORM pg_temp.check('k27 admin Remove user', m = 'OK rows=1', m);
END $$;
