-- BACKLOG-3473 control C21: what the three migrations create or replace, as
-- (k, v) rows. run.sh apply-prod takes it after the first apply of files
-- 1 -> 2 -> 3 (S1) and after the second (S2) and requires S1 = S2 both ways.
--
-- Covers (Addendum B R10): policies of the 7 tables; table and column grants
-- of the 7 tables and submission_attachments; md5(pg_get_functiondef) and
-- proacl of the 3 read functions and the 6 new functions; the new triggers;
-- constraints and indexes of the 7 tables; RLS flags; the
-- transaction_checklists feature row and its plan rows; row counts of the 7
-- tables; columns of submission_attachments and organizations.
--
-- plpgsql, so it can be created before the tables exist (bodies are resolved
-- at first call, which is after the first apply).

CREATE FUNCTION pg_temp.catalog_snapshot() RETURNS TABLE (k text, v text)
LANGUAGE plpgsql AS $$
DECLARE
  tbls text[] := ARRAY['public.checklist_seed_templates', 'public.checklist_templates',
                       'public.checklist_template_items', 'public.submission_checklists',
                       'public.submission_checklist_items', 'public.submission_checklist_links',
                       'public.submission_checklist_link_members'];
  fns  text[] := ARRAY['public.check_feature_access(uuid,text)', 'public.get_org_features(uuid)',
                       'public.broker_get_org_features(uuid)',
                       'public._override_above_tier(text,text,text,jsonb)',
                       'public._reject_feature_override_above_tier()',
                       'public._checklist_seed_items_valid(jsonb)',
                       'public.can_edit_checklist_templates(uuid)',
                       'public._seed_org_checklist_templates(uuid)',
                       'public._seed_checklists_on_plan_write()'];
  t    text;
  n    bigint;
BEGIN
  -- policies
  RETURN QUERY
    SELECT 'policy|' || p.tablename || '|' || p.policyname,
           p.cmd || '|' || p.roles::text || '|' || p.permissive || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')
      FROM pg_policies p
     WHERE p.schemaname || '.' || p.tablename = ANY (tbls);

  -- table and column grants
  RETURN QUERY
    SELECT 'relacl|' || c.oid::regclass::text, coalesce(c.relacl::text, 'default')
      FROM pg_class c
     WHERE c.oid IN (SELECT to_regclass(x) FROM unnest(tbls || ARRAY['public.submission_attachments']) x);
  RETURN QUERY
    SELECT 'attacl|' || a.attrelid::regclass::text || '.' || a.attname, a.attacl::text
      FROM pg_attribute a
     WHERE a.attrelid IN (SELECT to_regclass(x) FROM unnest(tbls || ARRAY['public.submission_attachments']) x)
       AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL;

  -- functions
  RETURN QUERY
    SELECT 'fn|' || f, coalesce((SELECT md5(pg_get_functiondef(to_regprocedure(f))) || ' acl=' || coalesce(pr.proacl::text, 'default')
                                   FROM pg_proc pr WHERE pr.oid = to_regprocedure(f)), 'absent')
      FROM unnest(fns) f;

  -- triggers
  RETURN QUERY
    SELECT 'trigger|' || g.tgrelid::regclass::text || '|' || g.tgname, pg_get_triggerdef(g.oid)
      FROM pg_trigger g
     WHERE NOT g.tgisinternal
       AND g.tgname IN ('reject_feature_override_above_tier', 'seed_checklists_on_plan_write',
                        'checklist_templates_updated_at', 'checklist_template_items_updated_at');

  -- constraints, indexes, RLS
  RETURN QUERY
    SELECT 'constraint|' || c.conrelid::regclass::text || '|' || c.conname, pg_get_constraintdef(c.oid)
      FROM pg_constraint c
     WHERE c.conrelid IN (SELECT to_regclass(x) FROM unnest(tbls) x);
  RETURN QUERY
    SELECT 'index|' || i.indrelid::regclass::text || '|' || i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
      FROM pg_index i
     WHERE i.indrelid IN (SELECT to_regclass(x) FROM unnest(tbls) x);
  RETURN QUERY
    SELECT 'rls|' || c.oid::regclass::text, c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
      FROM pg_class c
     WHERE c.oid IN (SELECT to_regclass(x) FROM unnest(tbls) x);

  -- the feature row and its plan rows
  RETURN QUERY
    SELECT 'feature|transaction_checklists',
           fd.name || '|' || coalesce(fd.description, '') || '|' || fd.category || '|' || fd.value_type || '|' ||
           coalesce(fd.default_value, 'NULL') || '|' || coalesce(fd.min_tier, 'NULL') || '|' ||
           coalesce(fd.sort_order::text, 'NULL') || '|' || fd.is_built::text
      FROM public.feature_definitions fd
     WHERE fd.key = 'transaction_checklists';
  RETURN QUERY
    SELECT 'plan_feature|' || p.slug, pf.enabled::text || '|' || coalesce(pf.value, 'NULL')
      FROM public.plan_features pf
      JOIN public.plans p ON p.id = pf.plan_id
      JOIN public.feature_definitions fd ON fd.id = pf.feature_id
     WHERE fd.key = 'transaction_checklists';

  -- row counts
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
    k := 'rows|' || t; v := n::text;
    RETURN NEXT;
  END LOOP;

  -- columns of the two altered tables, and the new column's comment
  RETURN QUERY
    SELECT 'column|' || a.attrelid::regclass::text || '.' || a.attname,
           format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' default=' ||
           coalesce(pg_get_expr(d.adbin, d.adrelid), 'none')
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid IN ('public.submission_attachments'::regclass, 'public.organizations'::regclass)
       AND a.attnum > 0 AND NOT a.attisdropped;
  RETURN QUERY
    SELECT 'comment|submission_attachments.local_attachment_id',
           coalesce(col_description('public.submission_attachments'::regclass,
                                    (SELECT a.attnum FROM pg_attribute a
                                      WHERE a.attrelid = 'public.submission_attachments'::regclass
                                        AND a.attname = 'local_attachment_id' AND NOT a.attisdropped)::int), 'none');
END
$$;
