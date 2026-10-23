-- S6: invited agent of x_org (no tenant) -> claims, never binds the tenant.
SELECT pg_temp.mk_azure3851('u_x3', 't_s6');
SELECT pg_temp.mk_invite('i_s6', 'x_org', 'u_x3-3917@example.test', 'agent');
CREATE TEMP TABLE r_s6 AS SELECT pg_temp.prov('u_x3', 't_s6') AS r;
SELECT pg_temp.check('S6 outcome success, role agent', pg_temp.outcome(r) = 'success' AND r->>'role' = 'agent', r::text) FROM r_s6;
SELECT pg_temp.check('S6 tenant_linked false', (r->>'tenant_linked')::boolean = false, r::text) FROM r_s6;
SELECT pg_temp.check('S6 x_org tenant still NULL', pg_temp.org_tenant('x_org') = '<null>', pg_temp.org_tenant('x_org'));
SELECT pg_temp.check('S6 invite claimed', pg_temp.row_state('i_s6') = pg_temp.id('u_x3')::text || '|active|true|invite', pg_temp.row_state('i_s6'));
