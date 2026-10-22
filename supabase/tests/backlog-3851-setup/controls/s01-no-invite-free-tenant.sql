-- S1: no invite, tenant not held by any organization -> no_invite; nothing created.
SELECT pg_temp.mk_auth_only('u_s1', 'u_s1-3917@example.test');
SELECT pg_temp.mk_azure3851('u_s1', 't_s1');
CREATE TEMP TABLE r_s1 AS SELECT pg_temp.prov('u_s1', 't_s1') AS r;
SELECT pg_temp.check('S1 outcome no_invite', pg_temp.outcome(r) = 'no_invite', r::text) FROM r_s1;
SELECT pg_temp.check('S1 no organization for the tenant', pg_temp.orgs_for('t_s1') = 0, pg_temp.orgs_for('t_s1')::text);
SELECT pg_temp.check('S1 no organization created at all', (SELECT count(*) FROM public.organizations) = (SELECT n FROM t3851s_orgs0),
  (SELECT count(*) FROM public.organizations)::text);
SELECT pg_temp.check('S1 no membership for the caller', pg_temp.member_rows('u_s1') = 0, pg_temp.member_rows('u_s1')::text);
SELECT pg_temp.check('S1 no public.users row written', NOT EXISTS (SELECT 1 FROM public.users WHERE id = pg_temp.id('u_s1')), NULL);
