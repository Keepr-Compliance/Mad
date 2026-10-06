-- broker-portal admin actions, exact column sets, as an O1 admin (authenticated).
DO $$ DECLARE m text; BEGIN
  -- updateUserRole.ts
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='broker', updated_at=now() where id='{m_member}'$q$);
  PERFORM pg_temp.check('k02 admin Edit role', m = 'OK rows=1', m);
  -- bulkUpdateRole.ts (with RETURNING id, like .select('id'))
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='broker', updated_at=now() where organization_id='{org1}' and id in ('{m_member}') and user_id <> '{u_c}' returning id$q$);
  PERFORM pg_temp.check('k02 admin Bulk role', m = 'OK rows=1', m);
  -- deactivateUser.ts
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set license_status='suspended', updated_at=now() where id='{m_member}'$q$);
  PERFORM pg_temp.check('k02 admin Deactivate', m = 'OK rows=1', m);
  -- resendInvite.ts (pending row)
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set invitation_token='tok-new', invitation_expires_at=now()+interval '7 days' where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k02 admin Resend invite', m = 'OK rows=1', m);
  -- an admin of O2 still cannot edit an O1 member
  m := pg_temp.as_user(pg_temp.ud(), 'admin2-3679@example.test',
    $q$update public.organization_members set role='admin' where id='{m_member}'$q$);
  PERFORM pg_temp.check('k02 admin of another org refused', pg_temp.refused(m), m);
END $$;
