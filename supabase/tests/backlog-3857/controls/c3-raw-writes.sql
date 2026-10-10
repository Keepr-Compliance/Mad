-- C3: writers that bypass the RPC are stopped by the CHECK (23514).
SELECT pg_temp.want('c3 service_role UPDATE license_type = trial -> 23514',
  pg_temp.run_as('service_role', NULL,
    'UPDATE public.licenses SET license_type = ''trial'' WHERE id = ''{l_ind}'''),
  '~^ERR 23514 ');
SELECT pg_temp.want('c3 service_role INSERT license_type = trial -> 23514',
  pg_temp.run_as('service_role', NULL,
    'INSERT INTO public.licenses (user_id, license_key, license_type) VALUES (''{u_new}'', ''fixture-3857-c3'', ''trial'')'),
  '~^ERR 23514 ');
SELECT pg_temp.want('c3 CHECK definition', pg_temp.type_check_def(), pg_temp.new_check_def());
SELECT pg_temp.check('c3 CHECK is validated',
  (SELECT convalidated FROM pg_constraint WHERE conrelid = 'public.licenses'::regclass AND conname = 'licenses_license_type_check'));
