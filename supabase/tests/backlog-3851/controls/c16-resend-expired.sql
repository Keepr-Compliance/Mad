-- c16 Q4: an expired, unclaimed invite holds no seat. Resend (new token + expiry, as
-- resendInvite.ts writes) takes a seat again: refused in a full org; a live invite's Resend
-- is neutral.
SELECT pg_temp.check('c16 f_org full; f_ie expired holds no seat', pg_temp.seats('f_org') = 4, NULL);
SELECT pg_temp.check('c16 client admin Resend of the expired invite -> seat_limit_reached',
  pg_temp.as_user('u_fad', pg_temp.resend_sql('f_ie')) = 'ERR P0001 seat_limit_reached', pg_temp.as_user('u_fad', pg_temp.resend_sql('f_ie')));
SELECT pg_temp.check('c16 ... row unchanged (still expired)',
  (SELECT invitation_expires_at < now() AND invitation_token = 'tok-3851-f-ie' FROM public.organization_members WHERE id = pg_temp.id('f_ie')), NULL);
SELECT pg_temp.check('c16 service_role Resend of the expired invite -> seat_limit_reached',
  pg_temp.as_service(pg_temp.resend_sql('f_ie')) = 'ERR P0001 seat_limit_reached', NULL);
SELECT pg_temp.check('c16 Resend of the live invite in the same full org succeeds',
  pg_temp.as_user('u_fad', pg_temp.resend_sql('f_il')) = 'OK rows=1', pg_temp.as_user('u_fad', pg_temp.resend_sql('f_il')));
-- With a seat free, the expired invite's Resend succeeds and takes it.
SELECT pg_temp.check('c16 unassign frees a seat', (pg_temp.sml_keep('u_fad', 'f_br', 'unassign') ->> 'success') = 'true', NULL);
SELECT pg_temp.check('c16 Resend of the expired invite with a free seat succeeds',
  pg_temp.keep('authenticated', 'u_fad', pg_temp.resend_sql('f_ie')) = 'OK rows=1', NULL);
SELECT pg_temp.check('c16 ... and holds the seat', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);
