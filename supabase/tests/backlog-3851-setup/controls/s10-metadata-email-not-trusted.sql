-- S10: an invite is matched on auth.users.email only, never on user metadata.
-- a: auth email NULL, metadata email = someone else's invite.
SELECT pg_temp.mk_auth_only('u_s10a', NULL, jsonb_build_object('email', 'victim-s10@example.test'));
SELECT pg_temp.mk_azure3851('u_s10a', 't_s10a');
SELECT pg_temp.mk_invite('i_s10', 'x_org', 'victim-s10@example.test', 'admin');
CREATE TEMP TABLE r_s10a AS SELECT pg_temp.prov('u_s10a', 't_s10a') AS r;
SELECT pg_temp.check('S10a NULL auth email + metadata match -> no_invite', pg_temp.outcome(r) = 'no_invite', r::text) FROM r_s10a;
SELECT pg_temp.check('S10a invite untouched', pg_temp.row_state('i_s10') = '<null>|pending|false|invite', pg_temp.row_state('i_s10'));
SELECT pg_temp.check('S10a x_org tenant still NULL', pg_temp.org_tenant('x_org') = '<null>', pg_temp.org_tenant('x_org'));
-- b: auth email different, metadata mail/preferred_username = the invite.
SELECT pg_temp.mk_auth_only('u_s10b', 'u_s10b-3917@example.test',
  jsonb_build_object('email', 'victim-s10@example.test', 'mail', 'victim-s10@example.test', 'preferred_username', 'victim-s10@example.test'));
SELECT pg_temp.mk_azure3851('u_s10b', 't_s10b');
CREATE TEMP TABLE r_s10b AS SELECT pg_temp.prov('u_s10b', 't_s10b') AS r;
SELECT pg_temp.check('S10b different auth email + metadata match -> no_invite', pg_temp.outcome(r) = 'no_invite', r::text) FROM r_s10b;
SELECT pg_temp.check('S10b invite untouched', pg_temp.row_state('i_s10') = '<null>|pending|false|invite', pg_temp.row_state('i_s10'));
