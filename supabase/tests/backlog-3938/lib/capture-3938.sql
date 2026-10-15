-- Rollback scenarios: record the post-fix fingerprint of both halves before a rollback runs.
SELECT set_config('t3938.fn_fixed', (SELECT string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || '/' || p.proacl::text, ';' ORDER BY 1)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('get_user_org_ids','is_org_admin','broker_get_org_features')), true) IS NULL;
SELECT set_config('t3938.links_fixed', (SELECT string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || md5(coalesce(qual,'') || '|' || coalesce(with_check,'')), ';' ORDER BY 1)
  FROM pg_policies WHERE tablename = 'support_ticket_backlog_links'), true) IS NULL;
