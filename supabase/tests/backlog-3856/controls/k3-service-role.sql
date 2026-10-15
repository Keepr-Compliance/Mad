-- k3: service_role paths (direct call, and create_trial_license which
-- delegates) also create the row 'suspended' for a suspended user.
SELECT pg_temp.check('k3 service_role direct -> suspended',
  pg_temp.as_role('service_role', NULL,
    'SELECT (public.create_active_individual_license(''{u_susp}''::uuid)).status') = 'OK suspended',
  pg_temp.lic('u_susp')::text);
SELECT pg_temp.check('k3 service_role create_trial_license -> suspended',
  pg_temp.as_role('service_role', NULL,
    'SELECT (public.create_trial_license(''{u_susp2}''::uuid)).status') = 'OK suspended',
  pg_temp.lic('u_susp2')::text);
