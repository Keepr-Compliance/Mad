-- harness: rollback
-- harness: pre-apply: INSERT INTO public.checklist_seed_templates (seed_key, name, sort_order, items) VALUES ('fixture_3858', 'Fixture 3858', 1, '[{"title":"one"},{"title":"two","is_required":true}]'::jsonb);
-- k4b: rollback-3858.sql returns every table it can touch to the pre-run state:
-- the four created orgs (and their member / plan rows) gone, the desktop-made
-- personal org of d_desk and the brokerage kept, bookkeeping table dropped.
-- One fixture seed template makes the run create checklist templates and
-- items, so the cascade on those is covered too.
SELECT pg_temp.check('k4b rollback raised nothing', pg_temp.step_ok('rollback'), pg_temp.step_err('rollback'));
SELECT pg_temp.check('k4b state after rollback = pre-run state',
  pg_temp.snapshot('after_rb') = pg_temp.snapshot('pre'),
  pg_temp.diff(pg_temp.snapshot('pre'), pg_temp.snapshot('after_rb')));
SELECT pg_temp.check('k4b d_desk desktop personal org kept', pg_temp.porg('d_desk') IS NOT NULL);
SELECT pg_temp.check('k4b bookkeeping table dropped', to_regclass('public.backlog_3858_personal_org_backfill') IS NULL);
SELECT pg_temp.check('k4b the run had created orgs', pg_temp.snapshot('after1') <> pg_temp.snapshot('pre'));
SELECT pg_temp.check('k4b the run had created checklist templates',
  jsonb_array_length(pg_temp.snapshot('after1')->'checklist_templates') > jsonb_array_length(pg_temp.snapshot('pre')->'checklist_templates')
  AND jsonb_array_length(pg_temp.snapshot('after1')->'checklist_template_items') > jsonb_array_length(pg_temp.snapshot('pre')->'checklist_template_items'));
