-- BACKLOG-3403 catalogue fingerprint. One read-only SELECT: runs unchanged on
-- production (apply-plan pre/post check) and on the venue (controls e00, e13,
-- e15). Rows: (k, v). Absent objects simply have no row.
SELECT k, v FROM (
  SELECT 'policy:' || p.schemaname || '.' || p.tablename || ':' || p.policyname AS k,
         md5(p.cmd || '|' || p.roles::text || '|' || coalesce(p.qual, '-') || '|' || coalesce(p.with_check, '-')) AS v
    FROM pg_policies p
   WHERE (p.schemaname = 'public' AND p.tablename IN ('transaction_submissions', 'submission_messages',
                                                      'submission_attachments', 'submission_checklists', 'submission_attempts'))
      OR (p.schemaname = 'storage' AND p.tablename = 'objects'
          AND (coalesce(p.qual, '') || coalesce(p.with_check, '')) LIKE '%submission-attachments%')
  UNION ALL
  SELECT 'function:' || pr.proname || '(' || pg_get_function_identity_arguments(pr.oid) || ')',
         md5(pr.prosrc || '|' || pr.prosecdef::text || '|' || coalesce(pr.proconfig::text, '-') || '|' || coalesce(pr.proacl::text, '-'))
    FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
   WHERE n.nspname = 'public'
     AND pr.proname IN ('finalize_submission', 'record_submission_attempt', 'can_review_submission',
                        'guard_status_history_append_only', 'track_submission_status_changes')
  UNION ALL
  SELECT 'index:' || i.indexname, md5(i.indexdef)
    FROM pg_indexes i
   WHERE i.schemaname = 'public' AND i.tablename IN ('submission_messages', 'submission_attachments', 'submission_attempts')
  UNION ALL
  SELECT 'table:' || c.relname, md5(c.relrowsecurity::text || '|' || coalesce(c.relacl::text, '-'))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('submission_attempts')
  UNION ALL
  SELECT 'trigger:' || t.tgname, md5(pg_get_triggerdef(t.oid))
    FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgrelid = 'public.transaction_submissions'::regclass
) f ORDER BY k
