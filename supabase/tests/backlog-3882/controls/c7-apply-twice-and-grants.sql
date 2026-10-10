-- harness: apply-twice
-- Second apply succeeds; end state: new body, grants, unchanged definer/config.
SELECT pg_temp.want('c7 it_admin body is the migration''s', pg_temp.fn_md5(), pg_temp.new_md5());
SELECT pg_temp.want('c7 it_admin grants', pg_temp.grants('auto_provision_it_admin'),
  'public=false anon=false authenticated=true service_role=true');
SELECT pg_temp.want('c7 it_admin definer/config/return unchanged', pg_temp.fn_meta('auto_provision_it_admin'),
  'secdef=true cfg={search_path=public} ret=jsonb');
SELECT pg_temp.want('c7 anon call refused',
  pg_temp.run_as('anon', NULL, format('SELECT public.auto_provision_it_admin(%L, %L, %L)::text', pg_temp.tid('t_a'), 'x', 'x')),
  '~^ERR 42501 permission denied');
SELECT pg_temp.want('c7 authenticated matching caller still works', pg_temp.provision(pg_temp.id('u_a1'), pg_temp.tid('t_a')), '~^OK .*"success": true');
