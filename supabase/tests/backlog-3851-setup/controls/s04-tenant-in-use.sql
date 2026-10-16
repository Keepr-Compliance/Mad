-- S4: invited admin of m2_org (no tenant), caller's tenant t_f held by f_org -> tenant_in_use, nothing written.
SELECT pg_temp.mk_invite('i_s4', 'm2_org', 'u_x1-3917@example.test', 'admin');
CREATE TEMP TABLE r_s4 AS SELECT pg_temp.prov('u_x1', 't_f') AS r;
SELECT pg_temp.check('S4 outcome tenant_in_use', pg_temp.outcome(r) = 'tenant_in_use', r::text) FROM r_s4;
SELECT pg_temp.check('S4 invite still pending, unclaimed', pg_temp.row_state('i_s4') = '<null>|pending|false|invite', pg_temp.row_state('i_s4'));
SELECT pg_temp.check('S4 no membership anywhere for the caller', pg_temp.member_rows('u_x1') = 0, pg_temp.member_rows('u_x1')::text);
SELECT pg_temp.check('S4 m2_org tenant still NULL', pg_temp.org_tenant('m2_org') = '<null>', pg_temp.org_tenant('m2_org'));
SELECT pg_temp.check('S4 f_org tenant unchanged', pg_temp.org_tenant('f_org') = pg_temp.tid('t_f'), NULL);
