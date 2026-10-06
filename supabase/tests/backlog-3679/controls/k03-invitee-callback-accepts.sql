-- broker-portal auth callback, exact statements, as the invitee (authenticated).
-- A personal organization for A is created first so the existing
-- retire_personal_membership trigger is exercised too.
INSERT INTO public.organizations (id, name, slug, personal_owner_user_id)
  VALUES (pg_temp.id('org_pa'), 'Personal A 3679', 'personal-a-3679', pg_temp.id('u_a'));
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status)
  VALUES (pg_temp.id('m_pa'), pg_temp.id('org_pa'), pg_temp.id('u_a'), 'admin', 'active');
DO $$ DECLARE m text; before text; r record; BEGIN
  before := pg_temp.snap(pg_temp.id('inv_a'));
  -- route.ts: select id, role, organization_id ... eq invited_email, is user_id null, limit 1
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$select (select string_agg(id::text, ',') from (select id from public.organization_members where invited_email='invitee-3679@example.test' and user_id is null limit 1) s)$q$);
  PERFORM pg_temp.check('k03 callback finds the pending invite', m = 'OK {inv_a}', m);
  -- route.ts: update user_id, license_status, joined_at, invitation_token where id
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id='{u_a}', license_status='active', joined_at=now(), invitation_token=null where id='{inv_a}'$q$, true);
  PERFORM pg_temp.check('k03 callback UPDATE links the invite', m = 'OK rows=1', m);
  SELECT * INTO r FROM public.organization_members WHERE id=pg_temp.id('inv_a');
  PERFORM pg_temp.check('k03 linked row: caller, same role/org, active, token cleared',
    r.user_id = pg_temp.ua() AND r.role = 'agent' AND r.organization_id = pg_temp.id('org1')
    AND r.license_status = 'active' AND r.invitation_token IS NULL AND r.joined_at IS NOT NULL
    AND r.invited_email = 'invitee-3679@example.test' AND r.invited_by = pg_temp.uc(), to_jsonb(r)::text);
  PERFORM pg_temp.check('k03 personal membership retired by existing trigger',
    NOT EXISTS (SELECT 1 FROM public.organization_members WHERE id=pg_temp.id('m_pa')));
  -- after linking, the invitee is a normal member: cannot edit their own row further
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set role='admin' where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k03 linked invitee cannot then change role', pg_temp.refused(m), m);
END $$;
