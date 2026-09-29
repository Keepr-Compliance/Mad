-- C6: templates are archived, never deleted.
--   T1 broker DELETE T1's seeded template A      : PRIV, row still present
-- Mutants: m08a (GRANT DELETE, no policy -> rows:0, not PRIV),
--          m08b (GRANT DELETE + editor DELETE policy -> rows:1).

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C6 broker DELETE template',
  format('DELETE FROM public.checklist_templates WHERE id = %L', pg_temp.id('tpl_t1_a')), 'PRIV');
SELECT pg_temp.act_owner();
DO $post$
BEGIN
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_a')),
                        'template still present');
END
$post$;
