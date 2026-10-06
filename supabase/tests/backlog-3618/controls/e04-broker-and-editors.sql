-- e04: the broker, admin and IT admin neither see nor write an agent's
-- private template, and keep their brokerage rights (plan R4, SR2).
SELECT set_config('t3618.p', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'A1 private')::text, true) IS NOT NULL;
DO $e04$
DECLARE who text;
BEGIN
  FOREACH who IN ARRAY ARRAY['u_t1_broker', 'u_t1_admin', 'u_t1_itadmin'] LOOP
    PERFORM pg_temp.act_as(pg_temp.id(who));
    PERFORM pg_temp.expect('e04a ' || who || ' SELECT A1 template', format('SELECT 1 FROM public.checklist_templates WHERE id = %L', current_setting('t3618.p')), 'rows:0');
    PERFORM pg_temp.expect('e04b ' || who || ' SELECT A1 items', format('SELECT 1 FROM public.checklist_template_items WHERE template_id = %L', current_setting('t3618.p')), 'rows:0');
    PERFORM pg_temp.expect('e04c ' || who || ' rename/unarchive A1 template', format('UPDATE public.checklist_templates SET archived_at = NULL, name = %L WHERE id = %L', 'e04c', current_setting('t3618.p')), 'rows:0');
    PERFORM pg_temp.expect('e04d ' || who || ' DELETE A1 items', format('DELETE FROM public.checklist_template_items WHERE template_id = %L', current_setting('t3618.p')), 'rows:0');
    PERFORM pg_temp.expect('e04e ' || who || ' INSERT item into A1 template', format('INSERT INTO public.checklist_template_items (template_id, title) VALUES (%L, %L)', current_setting('t3618.p'), 'e04e'), 'RLS');
    PERFORM pg_temp.expect('e04f ' || who || ' SELECTs brokerage templates', format('SELECT 1 FROM public.checklist_templates WHERE id = %L', pg_temp.id('tpl_t1_a')), 'rows:1');
  END LOOP;
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_broker'));
  PERFORM pg_temp.expect('e04g broker INSERT brokerage template', format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t1'), 'e04g'), 'rows:1');
  PERFORM pg_temp.expect('e04h broker INSERT private owner=self', format('INSERT INTO public.checklist_templates (organization_id, owner_user_id, name) VALUES (%L, %L, %L)', pg_temp.id('o_t1'), pg_temp.id('u_t1_broker'), 'e04h'), 'rows:1');
  PERFORM pg_temp.expect('e04i broker INSERT private owner=agent', format('INSERT INTO public.checklist_templates (organization_id, owner_user_id, name) VALUES (%L, %L, %L)', pg_temp.id('o_t1'), pg_temp.id('u_t1_agent'), 'e04i'), 'RLS');
  PERFORM pg_temp.act_owner();
END
$e04$;
SELECT pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = current_setting('t3618.p')::uuid) = 'A1 private', 'e04j A1 template unchanged');
