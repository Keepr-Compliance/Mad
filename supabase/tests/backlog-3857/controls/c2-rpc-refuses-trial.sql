-- C2: admin_update_license refuses license_type 'trial' with its own
-- SQLSTATE 22023. The CHECK alone would raise 23514, so only the specific
-- code distinguishes the guard from the constraint.
SELECT pg_temp.want('c2 {license_type: trial} -> 22023',
  pg_temp.run_as('authenticated', pg_temp.id('u_admin'),
    'SELECT public.admin_update_license(''{l_ind}'', ''{"license_type":"trial"}''::jsonb)'),
  '~^ERR 22023 license_type trial is no longer accepted$');
SELECT pg_temp.want('c2 {status, license_type: trial} -> 22023 (mixed change refused whole)',
  pg_temp.run_as('authenticated', pg_temp.id('u_admin'),
    'SELECT public.admin_update_license(''{l_team}'', ''{"status":"suspended","license_type":"trial"}''::jsonb)'),
  '~^ERR 22023 ');
-- Not independent of the code above (a raise undoes the call), kept as a read-back.
SELECT pg_temp.check('c2 rows unchanged, no audit row',
  (SELECT license_type || '/' || status FROM public.licenses WHERE id = pg_temp.id('l_ind')) = 'individual/active'
  AND (SELECT license_type || '/' || status FROM public.licenses WHERE id = pg_temp.id('l_team')) = 'team/active'
  AND NOT EXISTS (SELECT 1 FROM public.admin_audit_logs WHERE target_id IN (pg_temp.id('l_ind')::text, pg_temp.id('l_team')::text)));
