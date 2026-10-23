-- S3: invited admin of x_org (no tenant), tenant free -> claims the invite, binds the tenant.
SELECT pg_temp.mk_azure3851('u_x3', 't_s3');
SELECT pg_temp.mk_invite('i_s3', 'x_org', 'u_x3-3917@example.test', 'admin');
CREATE TEMP TABLE r_s3 AS SELECT pg_temp.prov('u_x3', 't_s3') AS r;
SELECT pg_temp.check('S3 outcome success', pg_temp.outcome(r) = 'success', r::text) FROM r_s3;
SELECT pg_temp.check('S3 organization_id = invited org', (r->>'organization_id')::uuid = pg_temp.id('x_org'), r::text) FROM r_s3;
SELECT pg_temp.check('S3 role admin, tenant_linked true', r->>'role' = 'admin' AND (r->>'tenant_linked')::boolean, r::text) FROM r_s3;
SELECT pg_temp.check('S3 x_org tenant = caller tenant', pg_temp.org_tenant('x_org') = pg_temp.tid('t_s3'), pg_temp.org_tenant('x_org'));
SELECT pg_temp.check('S3 one organization for the tenant', pg_temp.orgs_for('t_s3') = 1, pg_temp.orgs_for('t_s3')::text);
SELECT pg_temp.check('S3 no organization created', (SELECT count(*) FROM public.organizations) = (SELECT n FROM t3851s_orgs0), NULL);
SELECT pg_temp.check('S3 invite claimed (user, active, token cleared, invite origin)',
  pg_temp.row_state('i_s3') = pg_temp.id('u_x3')::text || '|active|true|invite', pg_temp.row_state('i_s3'));
SELECT pg_temp.check('S3 joined_at set', (SELECT joined_at IS NOT NULL FROM public.organization_members WHERE id = pg_temp.id('i_s3')), NULL);
SELECT pg_temp.check('S3 the invite is the caller''s only membership', pg_temp.member_rows('u_x3') = 1, pg_temp.member_rows('u_x3')::text);
