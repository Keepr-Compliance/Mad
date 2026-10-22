-- S1: the holder of the invited email, not a member, without the email (no token in hand).
SELECT pg_temp.mk_org('o_s1', NULL, 50);
SELECT pg_temp.mk_user3851('u_s1');
SELECT pg_temp.mk_invite('i_s1', 'o_s1', 'u_s1-3917@example.test', 'admin');
SELECT pg_temp.check('S1 detector true', pg_temp.det('u_s1') = 'true', pg_temp.det('u_s1'));
SELECT pg_temp.check('S1 cannot read the token of their own invite',
  pg_temp.keep('authenticated', 'u_s1', format('select (select invitation_token from public.organization_members where id = %L)', pg_temp.id('i_s1'))) = 'OK <null>',
  pg_temp.keep('authenticated', 'u_s1', format('select (select invitation_token from public.organization_members where id = %L)', pg_temp.id('i_s1'))));
SELECT pg_temp.check('S1 cannot see the row at all',
  pg_temp.keep('authenticated', 'u_s1', format('select (select count(*) from public.organization_members where id = %L)', pg_temp.id('i_s1'))) = 'OK 0', NULL);
CREATE TEMP TABLE r_s1 AS SELECT pg_temp.keep('authenticated', 'u_s1',
  'select public.accept_invitation((select invitation_token from public.organization_members where invited_email = ''u_s1-3917@example.test''))') AS m;
SELECT pg_temp.check('S1 accept with what they can read -> invalid_invite', m LIKE '%invalid_invite%', m) FROM r_s1;
SELECT pg_temp.check('S1 row unchanged', pg_temp.row_state('i_s1') = '<null>|pending|false|invite', pg_temp.row_state('i_s1'));
