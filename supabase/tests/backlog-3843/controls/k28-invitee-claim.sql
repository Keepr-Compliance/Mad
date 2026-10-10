-- K8: an invitee claims a pending invite (auth/callback/route.ts shape); an
-- unclaimed row that is not pending cannot be claimed.
-- An unclaimed SUSPENDED row for the invitee's email, not expired. Created here, not in the
-- shared fixtures: backlog-3679 k06's no-WHERE accept would otherwise touch it.
INSERT INTO public.organization_members
 (id, organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at, invited_by, provisioned_by) VALUES
 (pg_temp.id('inv_susp'), pg_temp.id('org_jit'), NULL, 'agent', 'suspended', 'invitee-3679@example.test', 'tok-3843-s', now() + interval '7 days', pg_temp.id('u_d'), 'invite');
DO $$ DECLARE m text; r record; before_s text; BEGIN
  before_s := pg_temp.snap(pg_temp.id('inv_susp'));
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id='{u_a}', license_status='active', joined_at='2020-01-01', invitation_token=null where id='{inv_susp}'$q$, true);
  PERFORM pg_temp.check('k28 claim of an unclaimed SUSPENDED row refused (42501)', pg_temp.is42501(m), m);
  PERFORM pg_temp.check('k28 suspended row unchanged', pg_temp.snap(pg_temp.id('inv_susp')) = before_s);
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id='{u_a}', license_status='active', joined_at='2020-01-01', invitation_token=null where id='{inv_a}'$q$, true);
  PERFORM pg_temp.check('k28 claim of a pending invite succeeds', m = 'OK rows=1', m);
  SELECT * INTO r FROM public.organization_members WHERE id = pg_temp.id('inv_a');
  PERFORM pg_temp.check('k28 claim stored: user, active, joined_at = now(), token cleared',
    r.user_id = pg_temp.ua() AND r.license_status = 'active' AND r.joined_at = now() AND r.invitation_token IS NULL,
    concat_ws(',', r.user_id, r.license_status, r.joined_at, r.invitation_token));
END $$;
