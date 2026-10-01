-- e01: an agent reads and writes their own private template (unarchived
-- template P, plan R1), and still reads the brokerage's templates.
SELECT set_config('t3618.p', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'A1 private')::text, true) IS NOT NULL;
SELECT set_config('t3618.arch', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'A1 to archive')::text, true) IS NOT NULL;
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('e01a agent SELECT own', format('SELECT 1 FROM public.checklist_templates WHERE id = %L', current_setting('t3618.p')), 'rows:1');
SELECT pg_temp.expect('e01b agent SELECT own items', format('SELECT 1 FROM public.checklist_template_items WHERE template_id = %L', current_setting('t3618.p')), 'rows:1');
SELECT pg_temp.expect('e01c agent INSERT private owner=self', format('INSERT INTO public.checklist_templates (organization_id, owner_user_id, name) VALUES (%L, %L, %L)', pg_temp.id('o_t1'), pg_temp.id('u_t1_agent'), 'e01c'), 'rows:1');
SELECT pg_temp.expect('e01d agent UPDATE own name', format('UPDATE public.checklist_templates SET name = %L WHERE id = %L', 'e01d', current_setting('t3618.p')), 'rows:1');
SELECT pg_temp.expect('e01e agent INSERT item into own', format('INSERT INTO public.checklist_template_items (template_id, title) VALUES (%L, %L)', current_setting('t3618.p'), 'e01e'), 'rows:1');
SELECT pg_temp.expect('e01f agent UPDATE own item', format('UPDATE public.checklist_template_items SET title = %L WHERE template_id = %L AND title = %L', 'e01f', current_setting('t3618.p'), 'e01e'), 'rows:1');
SELECT pg_temp.expect('e01g agent DELETE own item', format('DELETE FROM public.checklist_template_items WHERE template_id = %L AND title = %L', current_setting('t3618.p'), 'e01f'), 'rows:1');
SELECT pg_temp.expect('e01h agent sets own include_in_submission false', format('UPDATE public.checklist_templates SET include_in_submission = false WHERE id = %L', current_setting('t3618.p')), 'rows:1');
SELECT pg_temp.expect('e01i agent archives a second own template', format('UPDATE public.checklist_templates SET archived_at = now() WHERE id = %L', current_setting('t3618.arch')), 'rows:1');
SELECT pg_temp.expect('e01j agent restores it', format('UPDATE public.checklist_templates SET archived_at = NULL WHERE id = %L', current_setting('t3618.arch')), 'rows:1');
SELECT pg_temp.expect('e01k agent still SELECTs the brokerage templates', format('SELECT 1 FROM public.checklist_templates WHERE organization_id = %L AND owner_user_id IS NULL', pg_temp.id('o_t1')), '~^rows:[1-9]');
SELECT pg_temp.expect('e01l can_create_own true for an entitled agent', format('SELECT 1 WHERE public.can_create_own_checklist_templates(%L)', pg_temp.id('o_t1')), 'rows:1');
SELECT pg_temp.act_owner();
SELECT pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = current_setting('t3618.p')::uuid) = 'e01d', 'e01m rename landed');
SELECT pg_temp.check((SELECT NOT include_in_submission FROM public.checklist_templates WHERE id = current_setting('t3618.p')::uuid), 'e01n include flag landed');
SELECT pg_temp.check((SELECT owner_user_id FROM public.checklist_templates WHERE name = 'e01c') = pg_temp.id('u_t1_agent'), 'e01o direct insert owned by agent');
