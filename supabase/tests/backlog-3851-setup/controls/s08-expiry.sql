-- S8: invite expiry, both sides of now() and NULL. Expired = invitation_expires_at <= now().
SELECT pg_temp.mk_azure3851('u_x3', 't_s8a');
SELECT pg_temp.mk_invite('i_s8a', 'x_org', 'u_x3-3917@example.test', 'admin', now() - interval '1 second');
CREATE TEMP TABLE r_s8a AS SELECT pg_temp.prov('u_x3', 't_s8a') AS r;
SELECT pg_temp.check('S8a expired 1s ago -> no_invite', pg_temp.outcome(r) = 'no_invite', r::text) FROM r_s8a;
SELECT pg_temp.check('S8a expired invite untouched', pg_temp.row_state('i_s8a') = '<null>|pending|false|invite', pg_temp.row_state('i_s8a'));
SELECT pg_temp.check('S8a x_org tenant still NULL', pg_temp.org_tenant('x_org') = '<null>', pg_temp.org_tenant('x_org'));

SELECT pg_temp.mk_azure3851('u_x4', 't_s8b');
SELECT pg_temp.mk_invite('i_s8b', 'm2_org', 'u_x4-3917@example.test', 'agent', now());
CREATE TEMP TABLE r_s8b AS SELECT pg_temp.prov('u_x4', 't_s8b') AS r;
SELECT pg_temp.check('S8b expires exactly now() -> no_invite', pg_temp.outcome(r) = 'no_invite', r::text) FROM r_s8b;

SELECT pg_temp.mk_auth_only('u_s8c', 'u_s8c-3917@example.test');
SELECT pg_temp.mk_azure3851('u_s8c', 't_s8c');
SELECT pg_temp.mk_invite('i_s8c', 'm2_org', 'u_s8c-3917@example.test', 'agent', now() + interval '1 second');
CREATE TEMP TABLE r_s8c AS SELECT pg_temp.prov('u_s8c', 't_s8c') AS r;
SELECT pg_temp.check('S8c expires in 1s -> success', pg_temp.outcome(r) = 'success', r::text) FROM r_s8c;
SELECT pg_temp.check('S8c first-time caller gets a public.users row', EXISTS (SELECT 1 FROM public.users WHERE id = pg_temp.id('u_s8c') AND email = 'u_s8c-3917@example.test'), NULL);

SELECT pg_temp.mk_auth_only('u_s8d', 'u_s8d-3917@example.test');
SELECT pg_temp.mk_azure3851('u_s8d', 't_s8d');
SELECT pg_temp.mk_invite('i_s8d', 'm2_org', 'u_s8d-3917@example.test', 'agent', NULL);
CREATE TEMP TABLE r_s8d AS SELECT pg_temp.prov('u_s8d', 't_s8d') AS r;
SELECT pg_temp.check('S8d no expiry -> success', pg_temp.outcome(r) = 'success', r::text) FROM r_s8d;
