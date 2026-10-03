-- BACKLOG-3618: the catalogue fingerprint the migration changes, one row per
-- key. Plain SELECT (no temp objects) so the SAME text runs read-only on
-- production; lib/fixtures-3618.sql wraps it in pg_temp.fp3618().
SELECT k, v FROM (
  SELECT 'fn:' || p.oid::regprocedure::text AS k,
         md5(p.prosrc) || ' def=' || p.prosecdef || ' cfg=' || COALESCE(array_to_string(p.proconfig, ','), '')
           || ' acl=' || COALESCE(p.proacl::text, '') AS v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('snapshot_submission_checklists', 'add_submission_checklist_at_review', 'save_checklist_template',
                       'can_edit_checklist_templates', 'can_create_own_checklist_templates', 'can_write_checklist_template')
  UNION ALL
  SELECT 'policies', md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|'
                                    || COALESCE(qual, '') || '|' || COALESCE(with_check, ''), E'\n' ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('checklist_templates', 'checklist_template_items')
  UNION ALL
  SELECT 'column_grants', md5(COALESCE(string_agg(table_name || '|' || grantee || '|' || privilege_type || '|' || column_name, E'\n'
                                                  ORDER BY table_name, grantee, privilege_type, column_name), ''))
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name IN ('checklist_templates', 'checklist_template_items')
     AND grantee IN ('authenticated', 'anon')
  UNION ALL
  SELECT 'columns', md5(string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull, ',' ORDER BY attname))
    FROM pg_attribute WHERE attrelid = 'public.checklist_templates'::regclass AND attnum > 0 AND NOT attisdropped
  UNION ALL
  SELECT 'constraints', md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conname))
    FROM pg_constraint WHERE conrelid = 'public.checklist_templates'::regclass
  UNION ALL
  SELECT 'indexes', string_agg(indexname, ',' ORDER BY indexname)
    FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'checklist_templates'
) f
