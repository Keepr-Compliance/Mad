-- k6: end-to-end: the suspended row the RPC creates is restored by
-- admin_unsuspend_user (internal-role caller).
SELECT pg_temp.check('k6 rpc creates suspended',
  pg_temp.as_role('authenticated', pg_temp.id('u_susp'),
    'SELECT (public.create_active_individual_license(''{u_susp}''::uuid)).status') = 'OK suspended');
SELECT pg_temp.check('k6 admin_unsuspend_user restores 1 licence',
  pg_temp.as_role('authenticated', pg_temp.id('u_admin'),
    'SELECT public.admin_unsuspend_user(''{u_susp}''::uuid)->>''licenses_restored''') = 'OK 1');
SELECT pg_temp.check('k6 licence now active', pg_temp.lic('u_susp')->>'status' = 'active', pg_temp.lic('u_susp')::text);
