-- e02: an agent cannot write brokerage templates, another user's, another
-- org's, nor change a template's owner (plan R2).
SELECT set_config('t3618.p', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'A1 private')::text, true) IS NOT NULL;
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('e02a agent INSERT brokerage template (owner null)', format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t1'), 'e02a'), 'RLS');
SELECT pg_temp.expect('e02b agent INSERT owner=other agent', format('INSERT INTO public.checklist_templates (organization_id, owner_user_id, name) VALUES (%L, %L, %L)', pg_temp.id('o_t1'), pg_temp.id('u_t1_agent2'), 'e02b'), 'RLS');
SELECT pg_temp.expect('e02c agent INSERT private into an org it is not in', format('INSERT INTO public.checklist_templates (organization_id, owner_user_id, name) VALUES (%L, %L, %L)', pg_temp.id('o_e'), pg_temp.id('u_t1_agent'), 'e02c'), 'RLS');
SELECT pg_temp.expect('e02d agent UPDATE owner_user_id', format('UPDATE public.checklist_templates SET owner_user_id = NULL WHERE id = %L', current_setting('t3618.p')), 'PRIV');
SELECT pg_temp.expect('e02e agent UPDATE brokerage template', format('UPDATE public.checklist_templates SET name = %L WHERE id = %L', 'e02e', pg_temp.id('tpl_t1_a')), 'rows:0');
SELECT pg_temp.expect('e02f agent INSERT item into brokerage template', format('INSERT INTO public.checklist_template_items (template_id, title) VALUES (%L, %L)', pg_temp.id('tpl_t1_a'), 'e02f'), 'RLS');
SELECT pg_temp.expect('e02g agent DELETE brokerage items', format('DELETE FROM public.checklist_template_items WHERE template_id = %L', pg_temp.id('tpl_t1_a')), 'rows:0');
SELECT pg_temp.expect('e02h agent DELETE own template (never deleted)', format('DELETE FROM public.checklist_templates WHERE id = %L', current_setting('t3618.p')), 'PRIV');
SELECT pg_temp.act_owner();
SELECT pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_a')) <> 'e02e', 'e02i brokerage name unchanged');
