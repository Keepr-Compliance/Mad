-- k1: an admin-suspended user with no licence row calls the RPC for themself
-- (the desktop path: authenticated, own id) -> the new row is 'suspended'.
SELECT pg_temp.check('k1 rpc call succeeds',
  (SELECT r LIKE 'OK %' FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_susp'),
     'SELECT (public.create_active_individual_license(''{u_susp}''::uuid)).status') r) s),
  (SELECT pg_temp.lic('u_susp')::text));
SELECT pg_temp.check('k1 stored licence status = suspended', pg_temp.lic('u_susp')->>'status' = 'suspended', pg_temp.lic('u_susp')->>'status');
SELECT pg_temp.check('k1 license_type individual, max_devices 2, transaction_limit 99999',
  pg_temp.lic('u_susp')->>'license_type' = 'individual' AND (pg_temp.lic('u_susp')->>'max_devices')::int = 2
  AND (pg_temp.lic('u_susp')->>'transaction_limit')::int = 99999, pg_temp.lic('u_susp')::text);
-- j1 input: the row shape the desktop reads (printed for transcription).
SELECT pg_temp.check('k1 row (for j1)', true,
  (SELECT jsonb_build_object('status', l->>'status', 'license_type', l->>'license_type', 'trial_status', l->'trial_status',
     'trial_expires_at', l->'trial_expires_at', 'expires_at', l->'expires_at', 'max_devices', l->'max_devices',
     'transaction_limit', l->'transaction_limit', 'transaction_count', l->'transaction_count')::text
   FROM (SELECT pg_temp.lic('u_susp') l) x));
