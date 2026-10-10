-- C5: the guard refuses only 'trial'. Other license_type and status changes
-- still apply and are audited (effects kept via run_as_keep).
SELECT pg_temp.want('c5 l_ind -> team',
  pg_temp.run_as_keep('authenticated', pg_temp.id('u_admin'),
    'SELECT public.admin_update_license(''{l_ind}'', ''{"license_type":"team"}''::jsonb)'), 'OK rows=1');
SELECT pg_temp.want('c5 l_ind is team',
  (SELECT license_type FROM public.licenses WHERE id = pg_temp.id('l_ind')), 'team');
SELECT pg_temp.want('c5 l_ind -> individual + suspended',
  pg_temp.run_as_keep('authenticated', pg_temp.id('u_admin'),
    'SELECT public.admin_update_license(''{l_ind}'', ''{"license_type":"individual","status":"suspended"}''::jsonb)'), 'OK rows=1');
SELECT pg_temp.want('c5 l_ind is individual/suspended',
  (SELECT license_type || '/' || status FROM public.licenses WHERE id = pg_temp.id('l_ind')), 'individual/suspended');
SELECT pg_temp.want('c5 l_team status-only change',
  pg_temp.run_as_keep('authenticated', pg_temp.id('u_admin'),
    'SELECT public.admin_update_license(''{l_team}'', ''{"status":"expired"}''::jsonb)'), 'OK rows=1');
SELECT pg_temp.want('c5 l_team is team/expired',
  (SELECT license_type || '/' || status FROM public.licenses WHERE id = pg_temp.id('l_team')), 'team/expired');
SELECT pg_temp.want('c5 three license.update audit rows by the admin',
  (SELECT count(*)::text FROM public.admin_audit_logs
    WHERE action = 'license.update' AND actor_id = pg_temp.id('u_admin')
      AND target_id IN (pg_temp.id('l_ind')::text, pg_temp.id('l_team')::text)), '3');
SELECT pg_temp.want('c5 a caller without an internal role is still refused',
  pg_temp.run_as('authenticated', pg_temp.id('u_ind'),
    'SELECT public.admin_update_license(''{l_ind}'', ''{"license_type":"team"}''::jsonb)'),
  '~^ERR P0001 Unauthorized$');
