-- U8: the trigger function is not callable by clients (catalog hygiene; a trigger function cannot be called directly).
SELECT pg_temp.check('authenticated cannot EXECUTE _billing_on_licence_unsuspend', NOT has_function_privilege('authenticated', 'public._billing_on_licence_unsuspend()', 'EXECUTE'));
SELECT pg_temp.check('anon cannot EXECUTE _billing_on_licence_unsuspend', NOT has_function_privilege('anon', 'public._billing_on_licence_unsuspend()', 'EXECUTE'));
SELECT pg_temp.check('trigger function is SECURITY DEFINER with a pinned search_path',
  (SELECT prosecdef AND proconfig::text LIKE '%search_path=public, pg_temp%' FROM pg_proc WHERE oid = 'public._billing_on_licence_unsuspend()'::regprocedure));
SELECT pg_temp.check('one trigger, AFTER UPDATE OF status, WHEN suspended -> active',
  (SELECT count(*) = 1 AND bool_and(pg_get_triggerdef(t.oid) LIKE '%AFTER UPDATE OF status ON public.licenses%'
                                   AND pg_get_triggerdef(t.oid) LIKE '%(old.status = ''suspended''::text) AND (new.status = ''active''::text)%')
     FROM pg_trigger t WHERE t.tgrelid = 'public.licenses'::regclass AND t.tgname = 'billing_regrant_on_unsuspend'));
