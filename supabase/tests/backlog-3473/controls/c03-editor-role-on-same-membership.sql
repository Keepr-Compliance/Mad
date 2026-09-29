-- C3: the editor role must be held on the SAME organization's membership row.
-- u_x is a broker in T1 and an agent in E (E is entitled: enterprise).
--   u_x INSERT a T1 template                 : rows:1   <- u_x IS an editor somewhere
--   u_x INSERT an E template                 : RLS
--   u_x UPDATE E's seeded template           : rows:0 (FILTERED), unchanged
-- Mutant: m05 (helper split into "editor role anywhere" AND "member of this org").

SELECT pg_temp.act_as(pg_temp.id('u_x'));
SELECT pg_temp.expect('C3 u_x INSERT into T1 (broker there)',
  format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t1'), 'c03 t1'), 'rows:1');
SELECT pg_temp.expect('C3 u_x INSERT into E (agent there)',
  format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_e'), 'c03 e'), 'RLS');
SELECT pg_temp.expect('C3 u_x UPDATE E seeded template',
  format('UPDATE public.checklist_templates SET name = %L WHERE id = %L', 'c03 e', pg_temp.id('tpl_e_a')), 'rows:0');

SELECT pg_temp.act_owner();
DO $post$
BEGIN
  PERFORM pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = pg_temp.id('tpl_e_a')) = 'Fixture starter A',
                        'E template unchanged');
END
$post$;
