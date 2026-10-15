-- c02 the seat limit holds for every role and writer; releasing frees a seat at once;
-- pending->active is seat-neutral; license_assigned_at follows 'active'.
SELECT pg_temp.set_status('f_un', 'unassigned');
SELECT pg_temp.check('c02 fixture f_org starts full', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);

-- authenticated client invite (inviteUser.ts shape): the guard's early count refuses first.
SELECT pg_temp.check('c02 client admin invite into a full org refused (guard 42501)',
  pg_temp.as_user('u_fad', pg_temp.client_invite_sql('u_fad', 'f_org', 'c02-a-3851@example.test')) LIKE 'ERR 42501 Organization has reached maximum seats%',
  pg_temp.as_user('u_fad', pg_temp.client_invite_sql('u_fad', 'f_org', 'c02-a-3851@example.test')));
-- service_role invite INSERT (no guard for non-client roles): the trigger refuses.
SELECT pg_temp.check('c02 service_role invite into a full org refused (P0001 seat_limit_reached)',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_expires_at, provisioned_by) values (%L, %L, %L, %L, now() + interval ''7 days'', %L)',
    pg_temp.id('f_org'), 'c02-b-3851@example.test', 'agent', 'pending', 'invite')) = 'ERR P0001 seat_limit_reached', NULL);
-- postgres / definer-owner write: no current_user exemption.
SELECT pg_temp.check('c02 postgres UPDATE suspended->active in a full org refused',
  pg_temp.as_pg(format('update public.organization_members set license_status = %L where id = %L', 'active', pg_temp.id('f_sus'))) = 'ERR P0001 seat_limit_reached',
  pg_temp.as_pg(format('update public.organization_members set license_status = %L where id = %L', 'active', pg_temp.id('f_sus'))));
SELECT pg_temp.check('c02 admin_invite_user (definer) into a full org -> seat_limit_reached',
  pg_temp.as_user('u_st', format('select public.admin_invite_user(%L::uuid, %L, %L, %L::uuid) ->> ''error''', pg_temp.id('f_org'), 'c02-c-3851@example.test', 'agent', pg_temp.id('u_st'))) = 'OK seat_limit_reached',
  pg_temp.as_user('u_st', format('select public.admin_invite_user(%L::uuid, %L, %L, %L::uuid) ->> ''error''', pg_temp.id('f_org'), 'c02-c-3851@example.test', 'agent', pg_temp.id('u_st'))));

-- Releasing frees a seat at once; the freed seat can be assigned.
SELECT pg_temp.check('c02 unassign the broker', (pg_temp.sml_keep('u_fad', 'f_br', 'unassign') ->> 'success') = 'true', NULL);
SELECT pg_temp.check('c02 unassign cleared license_assigned_at',
  (SELECT license_assigned_at IS NULL FROM public.organization_members WHERE id = pg_temp.id('f_br')), NULL);
SELECT pg_temp.check('c02 seats 3 after unassign', pg_temp.seats('f_org') = 3, pg_temp.seats('f_org')::text);
SELECT pg_temp.check('c02 assign the unassigned member into the freed seat',
  (pg_temp.sml_keep('u_fad', 'f_un', 'assign') ->> 'success') = 'true', pg_temp.status('f_un'));
SELECT pg_temp.check('c02 assign set license_assigned_at',
  (SELECT license_assigned_at IS NOT NULL FROM public.organization_members WHERE id = pg_temp.id('f_un')), NULL);
SELECT pg_temp.check('c02 seats 4 after assign', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);

-- active -> active keeps the timestamp; a direct write cannot forge it.
CREATE TEMP TABLE t02_ts ON COMMIT DROP AS SELECT license_assigned_at AS ts FROM public.organization_members WHERE id = pg_temp.id('f_un');
UPDATE public.organization_members SET license_status = 'active', license_assigned_at = '2000-01-01' WHERE id = pg_temp.id('f_un');
SELECT pg_temp.check('c02 active->active keeps license_assigned_at (not forgeable)',
  (SELECT m.license_assigned_at = t.ts FROM public.organization_members m, t02_ts t WHERE m.id = pg_temp.id('f_un')), NULL);
-- a client INSERT cannot set it either.
CREATE TEMP TABLE t02_forge ON COMMIT DROP AS SELECT pg_temp.keep('authenticated', 'u_oad',
  replace(replace(pg_temp.client_invite_sql('u_oad', 'o_org', 'c02-d-3851@example.test'),
    'invited_at, provisioned_by)', 'invited_at, provisioned_by, license_assigned_at)'), '''invite'')', '''invite'', ''2000-01-01'')')) AS r;
SELECT pg_temp.check('c02 client invite carrying a forged license_assigned_at is accepted', (SELECT r FROM t02_forge) = 'OK rows=1', (SELECT r FROM t02_forge));
SELECT pg_temp.check('c02 ... and stored without it',
  (SELECT license_assigned_at IS NULL FROM public.organization_members WHERE invited_email = 'c02-d-3851@example.test'), NULL);
SELECT pg_temp.check('c02 pending rows carry no license_assigned_at',
  NOT EXISTS (SELECT 1 FROM public.organization_members WHERE license_status <> 'active' AND license_assigned_at IS NOT NULL), NULL);

-- pending -> active (claim) is seat-neutral in a full org and stamps license_assigned_at.
SELECT pg_temp.check('c02 claim_pending_invite in a full org succeeds',
  pg_temp.keep('authenticated', 'u_fil', 'select public.claim_pending_invite() ->> ''success''') = 'OK true',
  pg_temp.keep('authenticated', 'u_fil', 'select public.claim_pending_invite()::text'));
SELECT pg_temp.check('c02 claimed row active with license_assigned_at',
  (SELECT license_status = 'active' AND license_assigned_at IS NOT NULL FROM public.organization_members WHERE id = pg_temp.id('f_il')), pg_temp.status('f_il'));
SELECT pg_temp.check('c02 seats still 4 after the claim', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);

-- Personal organizations have no limit (pp_org: max 1, already 1 member).
SELECT pg_temp.check('c02 personal org: second active member not refused',
  pg_temp.as_pg(format('insert into public.organization_members (organization_id, user_id, role, license_status) values (%L, %L, %L, %L)',
    pg_temp.id('pp_org'), pg_temp.id('u_x3'), 'agent', 'active')) = 'OK rows=1', NULL);
-- max_seats NULL or <= 0: no limit.
UPDATE public.organizations SET max_seats = 0 WHERE id = pg_temp.id('f_org');
SELECT pg_temp.check('c02 max_seats 0 = no limit',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_expires_at, provisioned_by) values (%L, %L, %L, %L, now() + interval ''7 days'', %L)',
    pg_temp.id('f_org'), 'c02-e-3851@example.test', 'agent', 'pending', 'invite')) = 'OK rows=1', NULL);
UPDATE public.organizations SET max_seats = NULL WHERE id = pg_temp.id('f_org');
SELECT pg_temp.check('c02 max_seats NULL = no limit',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_expires_at, provisioned_by) values (%L, %L, %L, %L, now() + interval ''7 days'', %L)',
    pg_temp.id('f_org'), 'c02-f-3851@example.test', 'agent', 'pending', 'invite')) = 'OK rows=1', NULL);
