-- C2: an agent of an entitled organization cannot write its templates.
--   T1 agent INSERT a T1 template                  : RLS
--   T1 agent INSERT an item into a T1 template     : RLS
--   T1 agent UPDATE a T1 template                  : rows:0 (FILTERED), name unchanged
--   T1 agent UPDATE a T1 item                      : rows:0 (FILTERED), title unchanged
--   T1 agent DELETE a T1 item                      : rows:0 (FILTERED), item still present
-- T1 is entitled (team + override ON), the agent is a member, every column
-- written is granted: only the helper's role list can refuse.
-- Mutant: m04 (helper admits 'agent').

SELECT pg_temp.act_owner();
DO $pre$
BEGIN
  PERFORM pg_temp.check(current_setting('t3473.tpl_t1_a') <> '' AND current_setting('t3473.item_t1_a1') <> '',
                        'fixtures published T1''s seeded template and item');
END
$pre$;

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C2 agent INSERT template',
  format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t1'), 'c02 agent'), 'RLS');
SELECT pg_temp.expect('C2 agent INSERT item',
  format('INSERT INTO public.checklist_template_items (template_id, title) VALUES (%L, %L)', pg_temp.id('tpl_t1_a'), 'c02 agent'), 'RLS');
SELECT pg_temp.expect('C2 agent UPDATE template',
  format('UPDATE public.checklist_templates SET name = %L WHERE id = %L', 'c02 agent', pg_temp.id('tpl_t1_a')), 'rows:0');
SELECT pg_temp.expect('C2 agent UPDATE item',
  format('UPDATE public.checklist_template_items SET title = %L WHERE id = %L', 'c02 agent', pg_temp.id('item_t1_a1')), 'rows:0');
SELECT pg_temp.expect('C2 agent DELETE item',
  format('DELETE FROM public.checklist_template_items WHERE id = %L', pg_temp.id('item_t1_a1')), 'rows:0');

SELECT pg_temp.act_owner();
DO $post$
BEGIN
  PERFORM pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_a')) = 'Fixture starter A',
                        'template name unchanged');
  PERFORM pg_temp.check((SELECT title FROM public.checklist_template_items WHERE id = pg_temp.id('item_t1_a1')) = 'Fixture item A1',
                        'item still present, title unchanged');
END
$post$;
