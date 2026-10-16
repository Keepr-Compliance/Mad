-- S20: another organization holds the caller's tenant in upper case -> tenant_in_use.
SELECT pg_temp.mk_org('org_s20h', upper(pg_temp.tid('t_s20')));
SELECT pg_temp.mk_invite('i_s20', 'x_org', 'u_x3-3917@example.test', 'admin');
SELECT pg_temp.mk_azure3851('u_x3', 't_s20');
CREATE TEMP TABLE r_s20 AS SELECT pg_temp.prov('u_x3', 't_s20') AS r;
SELECT pg_temp.check('S20 outcome tenant_in_use', pg_temp.outcome(r) = 'tenant_in_use', r::text) FROM r_s20;
SELECT pg_temp.check('S20 one organization holds the tenant (case-insensitive)', pg_temp.orgs_for('t_s20') = 1, pg_temp.orgs_for('t_s20')::text);
SELECT pg_temp.check('S20 invite still pending', pg_temp.row_state('i_s20') = '<null>|pending|false|invite', pg_temp.row_state('i_s20'));
