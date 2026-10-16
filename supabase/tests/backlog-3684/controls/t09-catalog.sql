-- T9: catalog. Who may execute the new functions; what they are.
SELECT pg_temp.check('T9 accept_invitation one overload, definer, search_path, jsonb',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'accept_invitation') = 1
  AND (SELECT prosecdef AND proconfig = ARRAY['search_path=public'] AND prorettype = 'jsonb'::regtype FROM pg_proc WHERE oid = 'public.accept_invitation(text,text)'::regprocedure), NULL);
SELECT pg_temp.check('T9 accept_invitation ACL', (SELECT proacl::text FROM pg_proc WHERE oid = 'public.accept_invitation(text,text)'::regprocedure)
  = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.accept_invitation(text,text)'::regprocedure));
SELECT pg_temp.check('T9 anon cannot execute accept_invitation', NOT has_function_privilege('anon', 'public.accept_invitation(text,text)', 'EXECUTE'), NULL);
SELECT pg_temp.check('T9 anon call of accept_invitation -> 42501',
  pg_temp.keep('anon', NULL, 'select public.accept_invitation(''x'')') LIKE 'ERR 42501%', NULL);
SELECT pg_temp.check('T9 detector one overload, definer, stable, boolean',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'caller_has_pending_invite') = 1
  AND (SELECT prosecdef AND provolatile = 's' AND prorettype = 'boolean'::regtype AND proconfig = ARRAY['search_path=public']
         FROM pg_proc WHERE oid = 'public.caller_has_pending_invite()'::regprocedure), NULL);
SELECT pg_temp.check('T9 detector ACL', (SELECT proacl::text FROM pg_proc WHERE oid = 'public.caller_has_pending_invite()'::regprocedure)
  = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.caller_has_pending_invite()'::regprocedure));
SELECT pg_temp.check('T9 anon call of the detector -> 42501',
  pg_temp.keep('anon', NULL, 'select public.caller_has_pending_invite()') LIKE 'ERR 42501%', NULL);
SELECT pg_temp.check('T9 _invite_bind_tenant: no client role may execute',
  NOT has_function_privilege('anon', 'public._invite_bind_tenant(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public._invite_bind_tenant(uuid,text)', 'EXECUTE')
  AND (SELECT proacl::text FROM pg_proc WHERE oid = 'public._invite_bind_tenant(uuid,text)'::regprocedure) = '{postgres=X/postgres,service_role=X/postgres}',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public._invite_bind_tenant(uuid,text)'::regprocedure));
SELECT pg_temp.check('T9 authenticated call of _invite_bind_tenant -> 42501',
  pg_temp.keep('authenticated', 'u_x3', format('select public._invite_bind_tenant(%L::uuid, ''x'')', pg_temp.id('x_org'))) LIKE 'ERR 42501%', NULL);
SELECT pg_temp.check('T9 claim_pending_invite: authenticated may not execute',
  NOT has_function_privilege('authenticated', 'public.claim_pending_invite()', 'EXECUTE')
  AND (SELECT proacl::text FROM pg_proc WHERE oid = 'public.claim_pending_invite()'::regprocedure) = '{postgres=X/postgres,service_role=X/postgres}',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.claim_pending_invite()'::regprocedure));
SELECT pg_temp.check('T9 claim_pending_invite body unchanged',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.claim_pending_invite()'::regprocedure) = '96ae2f67bbe19d5091466ab0f123e9b5', NULL);
SELECT pg_temp.check('T9 both invite policies are false',
  (SELECT qual = 'false' AND with_check = 'false' FROM pg_policies WHERE tablename = 'organization_members' AND policyname = 'users_can_accept_invite')
  AND (SELECT qual = 'false' AND with_check IS NULL FROM pg_policies WHERE tablename = 'organization_members' AND policyname = 'users_can_view_own_invite'),
  NULL);
SELECT pg_temp.check('T9 auto_provision_it_admin ACL unchanged',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure)
  = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', NULL);
