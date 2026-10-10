-- harness: pre-apply: INSERT INTO public.checklist_seed_templates (seed_key, name, sort_order, items) VALUES ('fixture_3858', 'Fixture 3858', 1, '[{"title":"one"},{"title":"two","is_required":true}]'::jsonb);
-- k6: side effects of the run, measured on the venue. seed_checklists_on_plan_write
-- fires for each new plan row; it copies checklist_seed_templates, which is empty
-- in production (2026-10-10: select count(*) from checklist_seed_templates -> 0).
-- The fixture adds one seed template (two items) so the trigger is seen to fire
-- for each new plan row. The bookkeeping table is closed to client roles.
SELECT pg_temp.check('k6 checklist_seed_templates rows incl. fixture (info)', true,
  (SELECT count(*)::text FROM public.checklist_seed_templates));
SELECT pg_temp.check('k6 checklist_templates created = seed count x 5 (and > 0)',
  (SELECT count(*) FROM public.checklist_seed_templates) > 0 AND
  (SELECT count(*) FROM jsonb_array_elements(pg_temp.snapshot('after1')->'checklist_templates'))
  - (SELECT count(*) FROM jsonb_array_elements(pg_temp.snapshot('pre')->'checklist_templates'))
  = 5 * (SELECT count(*) FROM public.checklist_seed_templates));
SELECT pg_temp.check('k6 bookkeeping table: RLS on, no client grants',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.backlog_3858_personal_org_backfill'::regclass)
  AND NOT has_table_privilege('anon', 'public.backlog_3858_personal_org_backfill', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.backlog_3858_personal_org_backfill', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.backlog_3858_personal_org_backfill', 'DELETE'));
SELECT pg_temp.check('k6 authenticated cannot read it',
  pg_temp.as_role('authenticated', pg_temp.id('c_ind1'), 'SELECT count(*)::text FROM public.backlog_3858_personal_org_backfill') LIKE 'ERR 42501%',
  pg_temp.as_role('authenticated', pg_temp.id('c_ind1'), 'SELECT count(*)::text FROM public.backlog_3858_personal_org_backfill'));
