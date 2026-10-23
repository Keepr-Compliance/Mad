-- S15: a caller with a personal organization claims a brokerage invite: the claimed
-- row is the invite, the personal membership is retired.
SELECT pg_temp.mk_azure3851('u_pp', 't_s15');
SELECT pg_temp.mk_invite('i_s15', 'x_org', 'u_pp-3917@example.test', 'admin');
CREATE TEMP TABLE r_s15 AS SELECT pg_temp.prov('u_pp', 't_s15') AS r;
SELECT pg_temp.check('S15 outcome success, organization x_org', pg_temp.outcome(r) = 'success' AND (r->>'organization_id')::uuid = pg_temp.id('x_org'), r::text) FROM r_s15;
SELECT pg_temp.check('S15 invite claimed by the caller', pg_temp.row_state('i_s15') = pg_temp.id('u_pp')::text || '|active|true|invite', pg_temp.row_state('i_s15'));
SELECT pg_temp.check('S15 personal membership retired', NOT EXISTS (SELECT 1 FROM public.organization_members WHERE id = pg_temp.id('pp_m')), NULL);
SELECT pg_temp.check('S15 tenant bound to x_org, not the personal org',
  pg_temp.org_tenant('x_org') = pg_temp.tid('t_s15') AND pg_temp.org_tenant('pp_org') = '<null>', pg_temp.org_tenant('pp_org'));
