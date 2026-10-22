-- S18: a placed active admin with no email anywhere in auth.users, public.users row present -> success.
UPDATE auth.users SET email = NULL, raw_user_meta_data = '{}'::jsonb WHERE id = pg_temp.id('u_xad');
SELECT pg_temp.mk_azure3851('u_xad', 't_s18');
CREATE TEMP TABLE r_s18 AS SELECT pg_temp.prov('u_xad', 't_s18') AS r;
SELECT pg_temp.check('S18 outcome success (no 23502)', pg_temp.outcome(r) = 'success', r::text) FROM r_s18;
SELECT pg_temp.check('S18 x_org tenant bound', pg_temp.org_tenant('x_org') = pg_temp.tid('t_s18'), pg_temp.org_tenant('x_org'));
SELECT pg_temp.check('S18 public.users row unchanged', (SELECT email FROM public.users WHERE id = pg_temp.id('u_xad')) = 'u_xad-3917@example.test', NULL);
