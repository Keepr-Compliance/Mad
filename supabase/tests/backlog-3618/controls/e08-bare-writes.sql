-- e08 (SR C5): writes with NO WHERE clause, so no SELECT policy hides a row;
-- only the write policies decide. The broker and the second agent touch
-- brokerage rows (positive control) and never another user's private rows.
SELECT set_config('t3618.p', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'A1 private')::text, true) IS NOT NULL;
SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('e08a broker bare UPDATE items', $q$UPDATE public.checklist_template_items SET title = 'e08 bare'$q$, '~^rows:[1-9]');
SELECT pg_temp.expect('e08b broker bare UPDATE templates', $q$UPDATE public.checklist_templates SET description = 'e08 bare'$q$, '~^rows:[1-9]');
SELECT pg_temp.act_owner();
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_template_items WHERE template_id = current_setting('t3618.p')::uuid AND title = 'e08 bare'), 'e08c agent private item untouched by broker bare UPDATE');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE id = current_setting('t3618.p')::uuid AND description = 'e08 bare'), 'e08d agent private template untouched by broker bare UPDATE');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_templates WHERE owner_user_id IS NULL AND description = 'e08 bare'), 'e08e positive: broker bare UPDATE reached brokerage rows');
SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('e08f broker bare DELETE items', $q$DELETE FROM public.checklist_template_items$q$, '~^rows:[1-9]');
SELECT pg_temp.act_owner();
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_template_items WHERE template_id = current_setting('t3618.p')::uuid), 'e08g agent private item survives broker bare DELETE');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_template_items i JOIN public.checklist_templates t ON t.id = i.template_id WHERE t.owner_user_id IS NULL AND t.organization_id = pg_temp.id('o_t1')), 'e08h positive: broker bare DELETE removed brokerage items');
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent2'));
SELECT pg_temp.expect('e08i agent2 bare UPDATE templates', $q$UPDATE public.checklist_templates SET description = 'e08 peer'$q$, 'rows:0');
SELECT pg_temp.expect('e08j agent2 bare DELETE items', $q$DELETE FROM public.checklist_template_items$q$, 'rows:0');
SELECT pg_temp.act_owner();
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_template_items WHERE template_id = current_setting('t3618.p')::uuid), 'e08k agent private item survives agent2 bare DELETE');
