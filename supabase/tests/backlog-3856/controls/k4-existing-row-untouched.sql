-- k4: a suspended user who already holds a licence row gets that row back
-- unchanged (the fix never rewrites existing rows).
CREATE TEMP TABLE t3856_k4 ON COMMIT DROP AS SELECT pg_temp.lic('u_susp_lic') AS before;
SELECT pg_temp.check('k4 rpc returns the existing row (status active)',
  pg_temp.as_role('authenticated', pg_temp.id('u_susp_lic'),
    'SELECT (public.create_active_individual_license(''{u_susp_lic}''::uuid)).license_key') = 'OK IND-fixture3856',
  pg_temp.lic('u_susp_lic')::text);
SELECT pg_temp.check('k4 stored row byte-identical', (SELECT before FROM t3856_k4) = pg_temp.lic('u_susp_lic'),
  pg_temp.lic('u_susp_lic')::text);
SELECT pg_temp.check('k4 one row for the user', (SELECT count(*) FROM public.licenses WHERE user_id = pg_temp.id('u_susp_lic')) = 1);
