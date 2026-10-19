-- c16b Q4 on the invite paths: x_org (max 2) holds x_ad + one EXPIRED unclaimed invite.
-- Under Q4 one seat is free, so both early counts (guard_invite_acceptance for the portal,
-- admin_invite_user for staff) must allow one invite, then refuse the next.
SELECT pg_temp.check('c16b x_org: one seat used', pg_temp.seats('x_org') = 1, pg_temp.seats('x_org')::text);
SELECT pg_temp.check('c16b portal invite (client admin) allowed',
  pg_temp.as_user('u_xad', pg_temp.client_invite_sql('u_xad', 'x_org', 'c16b-a-3851@example.test')) = 'OK rows=1',
  pg_temp.as_user('u_xad', pg_temp.client_invite_sql('u_xad', 'x_org', 'c16b-a-3851@example.test')));
SELECT pg_temp.check('c16b staff invite (admin_invite_user) allowed',
  pg_temp.as_user('u_st', format('select public.admin_invite_user(%L::uuid, %L, %L, %L::uuid) ->> ''success''', pg_temp.id('x_org'), 'c16b-b-3851@example.test', 'agent', pg_temp.id('u_st'))) = 'OK true',
  pg_temp.as_user('u_st', format('select public.admin_invite_user(%L::uuid, %L, %L, %L::uuid)::text', pg_temp.id('x_org'), 'c16b-b-3851@example.test', 'agent', pg_temp.id('u_st'))));
SELECT pg_temp.check('c16b keep one portal invite',
  pg_temp.keep('authenticated', 'u_xad', pg_temp.client_invite_sql('u_xad', 'x_org', 'c16b-c-3851@example.test')) = 'OK rows=1', NULL);
SELECT pg_temp.check('c16b next portal invite refused (now full)',
  pg_temp.as_user('u_xad', pg_temp.client_invite_sql('u_xad', 'x_org', 'c16b-d-3851@example.test')) LIKE 'ERR 42501 Organization has reached maximum seats%', NULL);
SELECT pg_temp.check('c16b next staff invite refused (now full)',
  pg_temp.as_user('u_st', format('select public.admin_invite_user(%L::uuid, %L, %L, %L::uuid) ->> ''error''', pg_temp.id('x_org'), 'c16b-e-3851@example.test', 'agent', pg_temp.id('u_st'))) = 'OK seat_limit_reached', NULL);
