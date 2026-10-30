-- S2: no invite, tenant held by o_org -> no_invite; the caller does not join o_org.
SELECT pg_temp.mk_azure3851('u_x4', 't_o');
CREATE TEMP TABLE n_s2 AS SELECT count(*)::int AS n FROM public.organization_members WHERE organization_id = pg_temp.id('o_org');
CREATE TEMP TABLE r_s2 AS SELECT pg_temp.prov('u_x4', 't_o') AS r;
SELECT pg_temp.check('S2 outcome no_invite', pg_temp.outcome(r) = 'no_invite', r::text) FROM r_s2;
SELECT pg_temp.check('S2 caller not in o_org', NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = pg_temp.id('u_x4')),
  pg_temp.member_rows('u_x4')::text);
SELECT pg_temp.check('S2 o_org member count unchanged',
  (SELECT count(*)::int FROM public.organization_members WHERE organization_id = pg_temp.id('o_org')) = (SELECT n FROM n_s2), NULL);
