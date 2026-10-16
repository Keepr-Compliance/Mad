-- S5: invited admin, the invited org holds a different tenant -> tenant_mismatch, nothing written.
SELECT pg_temp.mk_org('org_s5', pg_temp.tid('t_s5_org'));
SELECT pg_temp.mk_invite('i_s5', 'org_s5', 'u_x3-3917@example.test', 'admin');
SELECT pg_temp.mk_azure3851('u_x3', 't_s5');
CREATE TEMP TABLE r_s5 AS SELECT pg_temp.prov('u_x3', 't_s5') AS r;
SELECT pg_temp.check('S5 outcome tenant_mismatch', pg_temp.outcome(r) = 'tenant_mismatch', r::text) FROM r_s5;
SELECT pg_temp.check('S5 invite still pending, unclaimed', pg_temp.row_state('i_s5') = '<null>|pending|false|invite', pg_temp.row_state('i_s5'));
SELECT pg_temp.check('S5 org tenant unchanged', pg_temp.org_tenant('org_s5') = pg_temp.tid('t_s5_org'), pg_temp.org_tenant('org_s5'));
SELECT pg_temp.check('S5 no membership for the caller', pg_temp.member_rows('u_x3') = 0, pg_temp.member_rows('u_x3')::text);
