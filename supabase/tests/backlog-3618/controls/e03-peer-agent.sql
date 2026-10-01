-- e03: another agent of the same organization neither sees nor writes A1's
-- private template (plan R3).
SELECT set_config('t3618.p', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'A1 private')::text, true) IS NOT NULL;
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent2'));
SELECT pg_temp.expect('e03a agent2 SELECT A1 template', format('SELECT 1 FROM public.checklist_templates WHERE id = %L', current_setting('t3618.p')), 'rows:0');
SELECT pg_temp.expect('e03b agent2 SELECT A1 items', format('SELECT 1 FROM public.checklist_template_items WHERE template_id = %L', current_setting('t3618.p')), 'rows:0');
SELECT pg_temp.expect('e03c agent2 UPDATE A1 template', format('UPDATE public.checklist_templates SET name = %L WHERE id = %L', 'e03c', current_setting('t3618.p')), 'rows:0');
SELECT pg_temp.expect('e03d agent2 INSERT item into A1 template', format('INSERT INTO public.checklist_template_items (template_id, title) VALUES (%L, %L)', current_setting('t3618.p'), 'e03d'), 'RLS');
SELECT pg_temp.expect('e03e agent2 UPDATE A1 items', format('UPDATE public.checklist_template_items SET title = %L WHERE template_id = %L', 'e03e', current_setting('t3618.p')), 'rows:0');
SELECT pg_temp.expect('e03f agent2 DELETE A1 items', format('DELETE FROM public.checklist_template_items WHERE template_id = %L', current_setting('t3618.p')), 'rows:0');
SELECT pg_temp.act_as(pg_temp.id('u_e_agent'));
SELECT pg_temp.expect('e03g other-org agent SELECT A1 template', format('SELECT 1 FROM public.checklist_templates WHERE id = %L', current_setting('t3618.p')), 'rows:0');
SELECT pg_temp.act_owner();
SELECT pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = current_setting('t3618.p')::uuid) = 'A1 private', 'e03h A1 template unchanged');
SELECT pg_temp.check((SELECT count(*) FROM public.checklist_template_items WHERE template_id = current_setting('t3618.p')::uuid AND title = 'A1 private item') = 1, 'e03i A1 item unchanged');
