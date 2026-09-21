-- C5: template writes need the organization's entitlement.
-- T2 is team with no override: its transaction_checklists plan row is false.
--   T2 broker INSERT a T2 template              : RLS
--   T2 broker UPDATE T2's seeded template        : rows:0 (FILTERED), unchanged
--   T1 broker INSERT a T1 template              : rows:1   <- entitled org, same role
-- Mutant: m07 (helper without the check_feature_access term).

SELECT pg_temp.act_as(pg_temp.id('u_t2_broker'));
SELECT pg_temp.expect('C5 T2 broker INSERT template',
  format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t2'), 'c05 t2'), 'RLS');
SELECT pg_temp.expect('C5 T2 broker UPDATE seeded template',
  format('UPDATE public.checklist_templates SET name = %L WHERE id = %L', 'c05 t2', pg_temp.id('tpl_t2_a')), 'rows:0');

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C5 T1 broker INSERT template',
  format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t1'), 'c05 t1'), 'rows:1');

SELECT pg_temp.act_owner();
DO $post$
BEGIN
  PERFORM pg_temp.check((SELECT name FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t2_a')) = 'Fixture starter A',
                        'T2 template unchanged');
END
$post$;
