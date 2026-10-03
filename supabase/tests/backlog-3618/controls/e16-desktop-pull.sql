-- e16 (SR1): the desktop's template read (org + not archived, RLS-scoped)
-- returns the brokerage's templates and the caller's own, never a peer's.
SELECT set_config('t3618.p', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'A1 private')::text, true) IS NOT NULL;
SELECT set_config('t3618.p2', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent2'), 'A2 private')::text, true) IS NOT NULL;
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_t1') AND archived_at IS NULL AND id = current_setting('t3618.p')::uuid), 'e16a agent pull has own');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_t1') AND archived_at IS NULL AND id = pg_temp.id('tpl_t1_a')), 'e16b agent pull has brokerage');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_t1') AND archived_at IS NULL AND id = current_setting('t3618.p2')::uuid), 'e16c agent pull lacks agent2 template');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_template_items WHERE template_id = current_setting('t3618.p2')::uuid), 'e16d agent pull lacks agent2 items');
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent2'));
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_t1') AND archived_at IS NULL AND id = current_setting('t3618.p')::uuid), 'e16e agent2 pull lacks agent template');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_templates WHERE id = current_setting('t3618.p2')::uuid), 'e16f agent2 pull has own');
SELECT pg_temp.act_owner();
