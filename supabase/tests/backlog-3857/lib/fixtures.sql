-- BACKLOG-3857 fixtures. Run inside the harness transaction, as postgres,
-- BEFORE the migration. Synthetic ids and addresses only.
--   u_admin: holds an internal role (admin_update_license's caller)
--   u_ind / l_ind:   an 'individual' license
--   u_team / l_team: a 'team' license
--   u_new:  a user with no license (c4 inserts one with column defaults)
--   u_seed: a user with no license (harness: seed-trial gives it a 'trial' one)
--
-- License column values are transcribed from production rows (2026-10-10,
-- SELECT license_type, status, trial_status, trial_started_at IS NULL,
-- trial_expires_at IS NULL, max_devices, transaction_limit, expires_at IS NULL,
-- count(*) FROM public.licenses GROUP BY 1..8): the most common shape is
-- individual / active / trial_* NULL / max_devices 2 / transaction_limit 99999 /
-- expires_at NULL (26 rows); a team row of the same shape exists (1 row).
-- The trial_* columns are set to NULL explicitly, as create_active_individual_license
-- does, because the pre-migration defaults would otherwise fill them.
INSERT INTO auth.users (id, email, aud, role)
SELECT pg_temp.id(n), n || '-3857@example.test', 'authenticated', 'authenticated'
  FROM unnest(ARRAY['u_admin','u_ind','u_team','u_new','u_seed']) n;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
SELECT pg_temp.id(n), n || '-3857@example.test', 'google', n || '3857'
  FROM unnest(ARRAY['u_admin','u_ind','u_team','u_new','u_seed']) n;
INSERT INTO public.admin_roles (id, name, slug, description)
VALUES (pg_temp.id('r_admin'), 'fixture-3857', 'fixture-3857', 'fixture-3857');
INSERT INTO public.internal_roles (user_id, role_id) VALUES (pg_temp.id('u_admin'), pg_temp.id('r_admin'));
INSERT INTO public.licenses
  (id, user_id, license_key, license_type, status, trial_status, trial_started_at, trial_expires_at,
   max_devices, transaction_limit, expires_at) VALUES
 (pg_temp.id('l_ind'),  pg_temp.id('u_ind'),  'fixture-3857-ind',  'individual', 'active', NULL, NULL, NULL, 2, 99999, NULL),
 (pg_temp.id('l_team'), pg_temp.id('u_team'), 'fixture-3857-team', 'team',       'active', NULL, NULL, NULL, 2, 99999, NULL);

SELECT pg_temp.check('fixtures: admin holds an internal role; two licenses',
  public.has_internal_role(pg_temp.id('u_admin'))
  AND (SELECT count(*) FROM public.licenses WHERE id IN (pg_temp.id('l_ind'), pg_temp.id('l_team'))) = 2);
