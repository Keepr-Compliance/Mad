-- r01: after rollback-3851-setup.sql the function is the 3882 body again.
SELECT pg_temp.check('r01 body md5 = 3882 (production before NEW)',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure) = 'a88466cc17f1f28a9824ec62c73a2589',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure));
SELECT pg_temp.check('r01 ACL, definer, search_path unchanged',
  (SELECT proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND prosecdef AND proconfig = ARRAY['search_path=public']
     FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure), NULL);
SELECT pg_temp.check('r01 fingerprint row = production pin (pins-3851.sql)',
  (SELECT v FROM pg_temp.venue3851() WHERE k = 'fn auto_provision_it_admin(text,text,text)') = '11d8619f8dc65e22f53e668e8eade957',
  (SELECT v FROM pg_temp.venue3851() WHERE k = 'fn auto_provision_it_admin(text,text,text)'));
SELECT pg_temp.mk_azure3851('u_x3', 't_r01');
SELECT pg_temp.check('r01 old behaviour back: a no-invite caller gets an organization',
  pg_temp.outcome(pg_temp.prov('u_x3', 't_r01')) = 'success' AND pg_temp.orgs_for('t_r01') = 1, NULL);
