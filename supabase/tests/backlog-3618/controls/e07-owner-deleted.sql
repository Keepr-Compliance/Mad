-- e07: deleting the owner deletes their private templates and items; no
-- brokerage-scoped copy is left (plan R7, SR C7: the row is proved present
-- first).
SELECT set_config('t3618.q', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_itadmin'), 'e07 itadmin private')::text, true) IS NOT NULL;
SELECT pg_temp.check((SELECT count(*) FROM public.checklist_templates WHERE id = current_setting('t3618.q')::uuid AND owner_user_id = pg_temp.id('u_t1_itadmin')) = 1, 'e07a private template exists before the delete');
SELECT pg_temp.check((SELECT count(*) FROM public.checklist_template_items WHERE template_id = current_setting('t3618.q')::uuid) = 1, 'e07b its item exists before the delete');
SELECT pg_temp.expect('e07c delete the owner user', format('DELETE FROM auth.users WHERE id = %L', pg_temp.id('u_t1_itadmin')), 'rows:1');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE name = 'e07 itadmin private'), 'e07d no template of that name is left');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_template_items WHERE template_id = current_setting('t3618.q')::uuid), 'e07e its items are gone');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_a')), 'e07f brokerage templates untouched');
