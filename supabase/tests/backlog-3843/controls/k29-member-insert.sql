-- K9: client INSERT into organization_members is limited to the invite shape
-- (inviteUser.ts), within the seat limit.
DO $$ DECLARE m text; t record; v_used int; BEGIN
  UPDATE public.organizations SET max_seats = 50 WHERE id = pg_temp.id('org1');
  FOR t IN SELECT * FROM (VALUES
      ('arbitrary user as active',
       $q$insert into public.organization_members (organization_id, user_id, role, license_status, joined_at) values ('{org1}', '{u_b}', 'agent', 'active', now())$q$),
      ('arbitrary user as pending (parked seat)',
       $q$insert into public.organization_members (organization_id, user_id, role, license_status, invited_email, invited_by, provisioned_by) values ('{org1}', '{u_b}', 'agent', 'pending', 'other-3679@example.test', '{u_c}', 'invite')$q$),
      ('unclaimed row as active',
       $q$insert into public.organization_members (organization_id, role, license_status, invited_email, invited_by, provisioned_by) values ('{org1}', 'agent', 'active', 'n1-3843@example.test', '{u_c}', 'invite')$q$),
      ('invite with joined_at',
       $q$insert into public.organization_members (organization_id, role, license_status, invited_email, invited_by, provisioned_by, joined_at) values ('{org1}', 'agent', 'pending', 'n2-3843@example.test', '{u_c}', 'invite', now())$q$),
      ('invite attributed to another inviter',
       $q$insert into public.organization_members (organization_id, role, license_status, invited_email, invited_by, provisioned_by) values ('{org1}', 'agent', 'pending', 'n3-3843@example.test', '{u_e}', 'invite')$q$),
      ('invite claiming scim provenance',
       $q$insert into public.organization_members (organization_id, role, license_status, invited_email, invited_by, provisioned_by, scim_synced_at) values ('{org1}', 'agent', 'pending', 'n4-3843@example.test', '{u_c}', 'scim', now())$q$),
      ('license_status defaulted but user set',
       $q$insert into public.organization_members (organization_id, user_id, role) values ('{org1}', '{u_b}', 'agent')$q$)
    ) v(label, stmt) LOOP
    m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test', t.stmt, true);
    PERFORM pg_temp.check('k29 admin INSERT ' || t.label || ' refused (42501)', pg_temp.is42501(m), m);
  END LOOP;
  PERFORM pg_temp.check('k29 nothing inserted for u_b or n*-3843',
    NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = pg_temp.id('org1')
                AND (user_id = pg_temp.ub() OR invited_email LIKE 'n_-3843@example.test')));
  -- the exact inviteUser.ts insert
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by) values ('{org1}', 'new-3843@example.test', 'agent', 'pending', 'tok-3843-i', now() + interval '7 days', '{u_c}', now(), 'invite')$q$, true);
  PERFORM pg_temp.check('k29 admin invite INSERT succeeds', m = 'OK rows=1', m);
  -- a non-admin member cannot invite (row-level policy, unchanged)
  m := pg_temp.as_user(pg_temp.id('u_e'), 'member-3679@example.test',
    $q$insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by) values ('{org1}', 'new2-3843@example.test', 'agent', 'pending', 'tok-3843-j', now() + interval '7 days', '{u_e}', now(), 'invite')$q$);
  PERFORM pg_temp.check('k29 non-admin invite refused', pg_temp.refused(m), m);
  m := pg_temp.as_role('anon', NULL, NULL,
    $q$insert into public.organization_members (organization_id, invited_email, role, license_status, provisioned_by) values ('{org1}', 'anon-3843@example.test', 'agent', 'pending', 'invite')$q$);
  PERFORM pg_temp.check('k29 anon insert refused', pg_temp.refused(m), m);
  -- seat limit: O1 exactly full -> the invite insert is refused
  SELECT count(*) INTO v_used FROM public.organization_members
   WHERE organization_id = pg_temp.id('org1') AND license_status IN ('active','pending');
  UPDATE public.organizations SET max_seats = v_used WHERE id = pg_temp.id('org1');
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by) values ('{org1}', 'full-3843@example.test', 'agent', 'pending', 'tok-3843-k', now() + interval '7 days', '{u_c}', now(), 'invite')$q$, true);
  PERFORM pg_temp.check('k29 invite at the seat limit refused (42501)', m LIKE 'ERR 42501 Organization has reached maximum seats%', m);
  UPDATE public.organizations SET max_seats = v_used + 1 WHERE id = pg_temp.id('org1');
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by) values ('{org1}', 'full-3843@example.test', 'agent', 'pending', 'tok-3843-k', now() + interval '7 days', '{u_c}', now(), 'invite')$q$, true);
  PERFORM pg_temp.check('k29 invite one below the seat limit succeeds', m = 'OK rows=1', m);
END $$;
