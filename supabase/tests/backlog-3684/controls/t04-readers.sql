-- T4: an active agent of the org reads a colleague's admin-invite token and presents it.
SELECT pg_temp.mk_org('o_t4', NULL, 50);
SELECT pg_temp.mk_user3851('u_t4');
SELECT pg_temp.mk_member('mem_t4', 'o_t4', 'u_t4', 'agent', 'active');
SELECT pg_temp.mk_invite('i_t4', 'o_t4', 'victim-t4-3917@example.test', 'admin');
SELECT pg_temp.check('T4 agent can read the colleague token (select_public)',
  pg_temp.keep('authenticated', 'u_t4', format('select (select invitation_token from public.organization_members where id = %L)', pg_temp.id('i_t4'))) = 'OK ' || pg_temp.tok('i_t4'), NULL);
SELECT pg_temp.check('T4 presenting it -> already_placed', pg_temp.outcome(pg_temp.acc('u_t4', pg_temp.tok('i_t4'))) = 'already_placed', NULL);
SELECT pg_temp.check('T4 row unchanged', pg_temp.row_state('i_t4') = '<null>|pending|false|invite', pg_temp.row_state('i_t4'));
-- T4b: an internal-role user with no brokerage reads a pending token and presents it.
SELECT pg_temp.mk_user3851('u_t4b');
INSERT INTO public.internal_roles (user_id, role_id) SELECT pg_temp.id('u_t4b'), id FROM public.admin_roles LIMIT 1;
SELECT pg_temp.mk_invite('i_t4b', 'o_t4', 'victim-t4b-3917@example.test', 'admin');
SELECT pg_temp.check('T4b internal-role user can read the token',
  pg_temp.keep('authenticated', 'u_t4b', format('select (select invitation_token from public.organization_members where id = %L)', pg_temp.id('i_t4b'))) = 'OK ' || pg_temp.tok('i_t4b'), NULL);
SELECT pg_temp.check('T4b presenting it -> email_mismatch', pg_temp.outcome(pg_temp.acc('u_t4b', pg_temp.tok('i_t4b'))) = 'email_mismatch', NULL);
SELECT pg_temp.check('T4b row unchanged', pg_temp.row_state('i_t4b') = '<null>|pending|false|invite', pg_temp.row_state('i_t4b'));
