-- auto_provision_google_it_admin: body unchanged, only service_role may call it.
SELECT pg_temp.want('c9 google body unchanged', pg_temp.fn_md5('auto_provision_google_it_admin'), pg_temp.google_md5());
SELECT pg_temp.want('c9 google grants', pg_temp.grants('auto_provision_google_it_admin'),
  'public=false anon=false authenticated=false service_role=true');
SELECT pg_temp.want('c9 authenticated call refused',
  pg_temp.run_as('authenticated', pg_temp.id('u_g'), 'SELECT public.auto_provision_google_it_admin(''fixture-3882.example.test'', ''x'', ''x'')::text'),
  '~^ERR 42501 permission denied');
