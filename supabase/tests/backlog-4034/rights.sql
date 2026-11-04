-- BACKLOG-4034 C6a: who may EXECUTE the two lookups. Expect anon, authenticated, PUBLIC false; service_role true.
SELECT f.sig, r.rolname, has_function_privilege(r.rolname, f.sig, 'EXECUTE') AS can_execute
  FROM (VALUES ('public.user_id_for_idp_object_id(text,text)'), ('public.idp_object_ids_for_users(uuid[],text)')) f(sig),
       (VALUES ('anon'), ('authenticated'), ('service_role')) r(rolname)
UNION ALL
SELECT f.sig, 'PUBLIC', EXISTS (
         SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = f.sig::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  FROM (VALUES ('public.user_id_for_idp_object_id(text,text)'), ('public.idp_object_ids_for_users(uuid[],text)')) f(sig)
 ORDER BY 1, 2;
