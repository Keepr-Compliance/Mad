-- S7: invited agent, the org holds a different tenant -> success (agents are not tenant-checked).
SELECT pg_temp.mk_org('org_s7', pg_temp.tid('t_s7_org'));
SELECT pg_temp.mk_invite('i_s7', 'org_s7', 'u_x3-3917@example.test', 'agent');
SELECT pg_temp.mk_azure3851('u_x3', 't_s7');
CREATE TEMP TABLE r_s7 AS SELECT pg_temp.prov('u_x3', 't_s7') AS r;
SELECT pg_temp.check('S7 outcome success, organization org_s7', pg_temp.outcome(r) = 'success' AND (r->>'organization_id')::uuid = pg_temp.id('org_s7'), r::text) FROM r_s7;
SELECT pg_temp.check('S7 org tenant unchanged', pg_temp.org_tenant('org_s7') = pg_temp.tid('t_s7_org'), pg_temp.org_tenant('org_s7'));
SELECT pg_temp.check('S7 invite claimed', pg_temp.row_state('i_s7') = pg_temp.id('u_x3')::text || '|active|true|invite', pg_temp.row_state('i_s7'));
