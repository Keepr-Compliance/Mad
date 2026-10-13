-- harness: rollback
-- harness: pre-apply: INSERT INTO public.checklist_seed_templates (seed_key, name, sort_order, items) VALUES ('fixture_3858', 'Fixture 3858', 1, '[{"title":"one"},{"title":"two","is_required":true}]'::jsonb);
-- harness: pre-rollback: ALTER TABLE public.checklist_template_items DISABLE TRIGGER checklist_template_items_updated_at;
-- harness: pre-rollback: UPDATE public.checklist_template_items SET title = 'edited by a user', updated_at = created_at + interval '1 hour' WHERE template_id = (SELECT id FROM public.checklist_templates WHERE organization_id = pg_temp.porg('c_ind1') LIMIT 1) AND sort_order = 10;
-- k4e: a seeded template whose item was edited after seeding (one transaction cannot
-- advance now(), so the updated_at trigger is disabled and updated_at set later) blocks the rollback.
SELECT pg_temp.check('k4e the run seeded items for c_ind1',
  jsonb_array_length(pg_temp.snapshot('after1')->'checklist_template_items') > jsonb_array_length(pg_temp.snapshot('pre')->'checklist_template_items'));
SELECT pg_temp.check('k4e the edit applied',
  EXISTS (SELECT 1 FROM public.checklist_template_items i JOIN public.checklist_templates t ON t.id = i.template_id
           WHERE t.organization_id = pg_temp.porg('c_ind1') AND i.title = 'edited by a user' AND i.updated_at > i.created_at));
SELECT pg_temp.check('k4e rollback refused', pg_temp.step_ok('rollback') = false
  AND pg_temp.step_err('rollback') LIKE '%checklist item changed or added after seeding%', pg_temp.step_err('rollback'));
SELECT pg_temp.check('k4e nothing deleted', pg_temp.porg('c_ind1') IS NOT NULL
  AND jsonb_array_length(pg_temp.state()->'backfill') = 4);
