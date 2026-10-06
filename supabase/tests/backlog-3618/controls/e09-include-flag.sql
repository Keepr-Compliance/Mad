-- e09: include_in_submission. Only a template with an owner can be false
-- (CHECK), only its owner can change it.
SELECT set_config('t3618.p', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'A1 private')::text, true) IS NOT NULL;
SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('e09a broker excludes a brokerage template', format('UPDATE public.checklist_templates SET include_in_submission = false WHERE id = %L', pg_temp.id('tpl_t1_a')), 'CHK');
SELECT pg_temp.expect('e09b broker inserts an excluded brokerage template', format('INSERT INTO public.checklist_templates (organization_id, name, include_in_submission) VALUES (%L, %L, false)', pg_temp.id('o_t1'), 'e09b'), 'CHK');
SELECT pg_temp.expect('e09c broker excludes the agent template', format('UPDATE public.checklist_templates SET include_in_submission = false WHERE id = %L', current_setting('t3618.p')), 'rows:0');
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent2'));
SELECT pg_temp.expect('e09d agent2 excludes the agent template', format('UPDATE public.checklist_templates SET include_in_submission = false WHERE id = %L', current_setting('t3618.p')), 'rows:0');
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('e09e agent excludes a brokerage template', format('UPDATE public.checklist_templates SET include_in_submission = false WHERE id = %L', pg_temp.id('tpl_t1_a')), 'rows:0');
SELECT pg_temp.expect('e09f agent inserts an own excluded template', format('INSERT INTO public.checklist_templates (organization_id, owner_user_id, name, include_in_submission) VALUES (%L, %L, %L, false)', pg_temp.id('o_t1'), pg_temp.id('u_t1_agent'), 'e09f'), 'rows:1');
SELECT pg_temp.expect('e09g agent excludes own', format('UPDATE public.checklist_templates SET include_in_submission = false WHERE id = %L', current_setting('t3618.p')), 'rows:1');
SELECT pg_temp.act_owner();
SELECT pg_temp.check((SELECT include_in_submission FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_a')), 'e09h brokerage template still sent');
SELECT pg_temp.check((SELECT NOT include_in_submission FROM public.checklist_templates WHERE id = current_setting('t3618.p')::uuid), 'e09i own template excluded');
SELECT pg_temp.check((SELECT bool_and(include_in_submission) FROM public.checklist_templates WHERE owner_user_id IS NULL), 'e09j every brokerage template is sent');
SELECT pg_temp.expect('e09k even the table owner cannot turn an excluded template into a brokerage one', format('UPDATE public.checklist_templates SET owner_user_id = NULL WHERE id = %L', current_setting('t3618.p')), 'CHK');
