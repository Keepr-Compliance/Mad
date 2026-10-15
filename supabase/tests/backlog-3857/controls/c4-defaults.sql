-- C4: an INSERT naming only user_id and license_key gets license_type
-- 'individual' and NULL trial columns. One check per column.
SELECT pg_temp.want('c4 INSERT (user_id, license_key) succeeds',
  pg_temp.run_as_keep('postgres', NULL,
    'INSERT INTO public.licenses (user_id, license_key) VALUES (''{u_new}'', ''fixture-3857-c4'')'), 'OK rows=1');
SELECT pg_temp.want('c4 license_type = individual',
  (SELECT license_type FROM public.licenses WHERE user_id = pg_temp.id('u_new')), 'individual');
SELECT pg_temp.check('c4 trial_status IS NULL',
  (SELECT trial_status IS NULL FROM public.licenses WHERE user_id = pg_temp.id('u_new')),
  (SELECT coalesce(trial_status, '<null>') FROM public.licenses WHERE user_id = pg_temp.id('u_new')));
SELECT pg_temp.check('c4 trial_started_at IS NULL',
  (SELECT trial_started_at IS NULL FROM public.licenses WHERE user_id = pg_temp.id('u_new')),
  (SELECT coalesce(trial_started_at::text, '<null>') FROM public.licenses WHERE user_id = pg_temp.id('u_new')));
SELECT pg_temp.check('c4 trial_expires_at IS NULL',
  (SELECT trial_expires_at IS NULL FROM public.licenses WHERE user_id = pg_temp.id('u_new')),
  (SELECT coalesce(trial_expires_at::text, '<null>') FROM public.licenses WHERE user_id = pg_temp.id('u_new')));
SELECT pg_temp.want('c4 catalog defaults', pg_temp.defaults(), pg_temp.new_defaults());
