-- k2: an active user with no licence row -> 'active' (behaviour unchanged).
SELECT pg_temp.check('k2 rpc returns active',
  pg_temp.as_role('authenticated', pg_temp.id('u_active'),
    'SELECT (public.create_active_individual_license(''{u_active}''::uuid)).status') = 'OK active',
  pg_temp.lic('u_active')::text);
SELECT pg_temp.check('k2 stored row active / individual / 2 / 99999',
  pg_temp.lic('u_active')->>'status' = 'active' AND pg_temp.lic('u_active')->>'license_type' = 'individual'
  AND (pg_temp.lic('u_active')->>'max_devices')::int = 2 AND (pg_temp.lic('u_active')->>'transaction_limit')::int = 99999,
  pg_temp.lic('u_active')::text);
