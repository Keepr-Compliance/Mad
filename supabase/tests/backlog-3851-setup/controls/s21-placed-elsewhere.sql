-- S21: an active agent of o_org who also holds an admin invite to x_org (no tenant):
-- the target is o_org; the x_org invite stays pending and x_org stays unbound.
SELECT pg_temp.mk_invite('i_s21', 'x_org', 'u_oag-3917@example.test', 'admin');
SELECT pg_temp.mk_azure3851('u_oag', 't_s21');
CREATE TEMP TABLE r_s21 AS SELECT pg_temp.prov('u_oag', 't_s21') AS r;
SELECT pg_temp.check('S21 outcome success, organization o_org, role agent',
  pg_temp.outcome(r) = 'success' AND (r->>'organization_id')::uuid = pg_temp.id('o_org') AND r->>'role' = 'agent', r::text) FROM r_s21;
SELECT pg_temp.check('S21 x_org invite still pending', pg_temp.row_state('i_s21') = '<null>|pending|false|invite', pg_temp.row_state('i_s21'));
SELECT pg_temp.check('S21 x_org tenant still NULL', pg_temp.org_tenant('x_org') = '<null>', pg_temp.org_tenant('x_org'));
