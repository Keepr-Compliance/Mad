-- A caller whose azure identity is tenant t_x asks for t_b, which has an org.
SELECT pg_temp.want('c1 refused with 42501', pg_temp.provision(pg_temp.id('u_x'), pg_temp.tid('t_b')), '~^ERR 42501 tenant does not match');
SELECT pg_temp.want('c1 no membership in org_b', pg_temp.role_in(pg_temp.id('u_x'), pg_temp.tid('t_b')), '<none>');
SELECT pg_temp.want('c1 org_b still has one member',
  (SELECT count(*)::text FROM public.organization_members WHERE organization_id = pg_temp.id('org_b')), '1');
SELECT pg_temp.want('c1 no public.users row written for the caller',
  (SELECT count(*)::text FROM public.users WHERE id = pg_temp.id('u_x')), '0');
