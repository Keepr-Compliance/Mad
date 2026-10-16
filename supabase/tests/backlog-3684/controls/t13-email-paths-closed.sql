-- T13: the email-only client paths (v1 P1-P3) are closed.
SELECT pg_temp.mk_org('o_t13', NULL, 50);
SELECT pg_temp.mk_user3851('u_t13');
SELECT pg_temp.mk_invite('i_t13', 'o_t13', 'u_t13-3917@example.test', 'agent');
-- P1: the invitee PATCHes their own invite row directly (no token).
SELECT pg_temp.check('T13 P1 direct update by the invitee touches 0 rows',
  pg_temp.keep('authenticated', 'u_t13', format('update public.organization_members set user_id = %L, license_status = ''active'' where id = %L',
    pg_temp.id('u_t13'), pg_temp.id('i_t13'))) = 'OK rows=0',
  pg_temp.keep('authenticated', 'u_t13', format('update public.organization_members set user_id = %L, license_status = ''active'' where id = %L',
    pg_temp.id('u_t13'), pg_temp.id('i_t13'))));
-- P1b: the same without a WHERE clause, so only the UPDATE policy decides (a filtered
-- update is also stopped by users_can_view_own_invite).
SELECT pg_temp.check('T13 P1b unfiltered update by the invitee touches 0 rows',
  pg_temp.keep('authenticated', 'u_t13', format('update public.organization_members set user_id = %L, license_status = ''active''',
    pg_temp.id('u_t13'))) = 'OK rows=0',
  pg_temp.keep('authenticated', 'u_t13', format('update public.organization_members set user_id = %L, license_status = ''active''',
    pg_temp.id('u_t13'))));
SELECT pg_temp.check('T13 P1 row unchanged', pg_temp.row_state('i_t13') = '<null>|pending|false|invite', pg_temp.row_state('i_t13'));
-- P2: claim_pending_invite by the invitee.
SELECT pg_temp.check('T13 P2 claim_pending_invite -> 42501',
  pg_temp.keep('authenticated', 'u_t13', 'select public.claim_pending_invite()') LIKE 'ERR 42501%', NULL);
-- P3: auth email NULL, metadata email = someone else's admin invite.
SELECT pg_temp.mk_invite('i_t13b', 'o_t13', 'victim-t13-3917@example.test', 'admin');
SELECT pg_temp.mk_auth_only('u_t13n', NULL, jsonb_build_object('email', 'victim-t13-3917@example.test'));
SELECT pg_temp.check('T13 P3 claim_pending_invite via metadata -> 42501',
  pg_temp.keep('authenticated', 'u_t13n', 'select public.claim_pending_invite()') LIKE 'ERR 42501%', NULL);
SELECT pg_temp.check('T13 rows unchanged',
  pg_temp.row_state('i_t13') = '<null>|pending|false|invite' AND pg_temp.row_state('i_t13b') = '<null>|pending|false|invite', NULL);
