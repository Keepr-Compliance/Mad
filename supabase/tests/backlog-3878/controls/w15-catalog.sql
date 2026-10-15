-- W15: the trigger function is not callable by clients; DEFINER with a pinned search_path;
-- one trigger AFTER UPDATE OF status with the suspension WHEN; the 3846 trigger still present.
SELECT pg_temp.check('anon / authenticated / PUBLIC cannot EXECUTE',
  NOT has_function_privilege('anon', 'public._billing_on_licence_suspension()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public._billing_on_licence_suspension()', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'public._billing_on_licence_suspension()'::regprocedure AND a.grantee = 0));
SELECT pg_temp.check('SECURITY DEFINER, search_path pinned',
  (SELECT prosecdef AND proconfig::text LIKE '%search_path=public, pg_temp%' FROM pg_proc WHERE oid = 'public._billing_on_licence_suspension()'::regprocedure));
SELECT pg_temp.check('one trigger, AFTER UPDATE OF status, WHEN into-suspended OR suspended -> active',
  (SELECT count(*) = 1 AND bool_and(pg_get_triggerdef(t.oid) LIKE 'CREATE TRIGGER billing_pause_resume_on_licence_status AFTER UPDATE OF status ON public.licenses FOR EACH ROW WHEN%'
                                   AND pg_get_triggerdef(t.oid) LIKE '%(old.status IS DISTINCT FROM ''suspended''::text) AND (new.status = ''suspended''::text)%'
                                   AND pg_get_triggerdef(t.oid) LIKE '%(old.status = ''suspended''::text) AND (new.status = ''active''::text)%')
     FROM pg_trigger t WHERE t.tgrelid = 'public.licenses'::regclass AND t.tgname = 'billing_pause_resume_on_licence_status'),
  (SELECT string_agg(pg_get_triggerdef(t.oid), ' | ') FROM pg_trigger t WHERE t.tgname = 'billing_pause_resume_on_licence_status'));
SELECT pg_temp.check('both licence triggers present (SR R9)',
  (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.licenses'::regclass AND tgname IN ('billing_pause_resume_on_licence_status', 'billing_regrant_on_unsuspend')));
