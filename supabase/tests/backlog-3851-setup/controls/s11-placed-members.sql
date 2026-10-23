-- S11: a caller who is already a claimed, active member.
-- a: admin of m2_org (no tenant) -> binds, membership unchanged.
SELECT pg_temp.mk_azure3851('u_m1', 't_s11a');
CREATE TEMP TABLE r_s11a AS SELECT pg_temp.prov('u_m1', 't_s11a') AS r;
SELECT pg_temp.check('S11a active admin, no tenant -> success, m2_org, tenant_linked',
  pg_temp.outcome(r) = 'success' AND (r->>'organization_id')::uuid = pg_temp.id('m2_org') AND r->>'role' = 'admin' AND (r->>'tenant_linked')::boolean, r::text) FROM r_s11a;
SELECT pg_temp.check('S11a m2_org tenant bound', pg_temp.org_tenant('m2_org') = pg_temp.tid('t_s11a'), pg_temp.org_tenant('m2_org'));
SELECT pg_temp.check('S11a membership unchanged', pg_temp.member_rows('u_m1') = 1 AND pg_temp.row_state('m2_a1') = pg_temp.id('u_m1')::text || '|active|true|manual', pg_temp.row_state('m2_a1'));
-- b: active agent of a no-tenant org -> success, no bind.
SELECT pg_temp.mk_org('org_s11b', NULL);
SELECT pg_temp.mk_user3851('u_s11b');
SELECT pg_temp.mk_member('mb_s11b', 'org_s11b', 'u_s11b', 'agent', 'active');
SELECT pg_temp.mk_azure3851('u_s11b', 't_s11b');
CREATE TEMP TABLE r_s11b AS SELECT pg_temp.prov('u_s11b', 't_s11b') AS r;
SELECT pg_temp.check('S11b active agent -> success, role agent, not linked',
  pg_temp.outcome(r) = 'success' AND r->>'role' = 'agent' AND NOT (r->>'tenant_linked')::boolean, r::text) FROM r_s11b;
SELECT pg_temp.check('S11b org tenant still NULL', pg_temp.org_tenant('org_s11b') = '<null>', pg_temp.org_tenant('org_s11b'));
-- c: active admin of x_org (no tenant); caller tenant t_o held by o_org -> tenant_in_use.
SELECT pg_temp.mk_azure3851('u_xad', 't_o');
CREATE TEMP TABLE r_s11c AS SELECT pg_temp.prov('u_xad', 't_o') AS r;
SELECT pg_temp.check('S11c tenant held elsewhere -> tenant_in_use', pg_temp.outcome(r) = 'tenant_in_use', r::text) FROM r_s11c;
SELECT pg_temp.check('S11c x_org tenant still NULL', pg_temp.org_tenant('x_org') = '<null>', pg_temp.org_tenant('x_org'));
SELECT pg_temp.check('S11c membership unchanged', pg_temp.row_state('x_ad') = pg_temp.id('u_xad')::text || '|active|true|manual', pg_temp.row_state('x_ad'));
-- d: active admin of o_org, tenant passed in upper case = o_org's -> success, nothing changes.
SELECT pg_temp.mk_azure3851('u_oad', 't_o');
CREATE TEMP TABLE r_s11d AS SELECT pg_temp.prov('u_oad', NULL, upper(pg_temp.tid('t_o'))) AS r;
SELECT pg_temp.check('S11d admin of an org with the same tenant -> success, linked',
  pg_temp.outcome(r) = 'success' AND (r->>'organization_id')::uuid = pg_temp.id('o_org') AND (r->>'tenant_linked')::boolean, r::text) FROM r_s11d;
SELECT pg_temp.check('S11d o_org tenant unchanged', pg_temp.org_tenant('o_org') = pg_temp.tid('t_o'), pg_temp.org_tenant('o_org'));
-- e: active admin of f_org (tenant t_f), caller tenant different -> tenant_mismatch.
SELECT pg_temp.mk_azure3851('u_fad', 't_s11e');
CREATE TEMP TABLE r_s11e AS SELECT pg_temp.prov('u_fad', 't_s11e') AS r;
SELECT pg_temp.check('S11e admin of an org with another tenant -> tenant_mismatch', pg_temp.outcome(r) = 'tenant_mismatch', r::text) FROM r_s11e;
SELECT pg_temp.check('S11e f_org tenant unchanged', pg_temp.org_tenant('f_org') = pg_temp.tid('t_f'), pg_temp.org_tenant('f_org'));
