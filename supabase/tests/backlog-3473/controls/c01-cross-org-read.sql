-- C1: an organization's templates and items are invisible to another organization.
--   E broker, E agent (members of E only) SELECT T1's templates   : rows:0 each
--   E broker, E agent SELECT T1's items (by template id)            : rows:0 each
--   T1 agent SELECT T1's templates / items                          : rows:2 / rows:3
--       <- proves the rows exist and the member policy admits T1's own members
-- Mutants: m01 (templates SELECT USING true), m02 (items SELECT USING true).

SELECT pg_temp.act_owner();
SELECT set_config('t3473.c1_tpl_ids',
  (SELECT string_agg(id::text, ',') FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_t1')), true);
DO $owner$
BEGIN
  PERFORM pg_temp.check(pg_temp.n(format('SELECT count(*) FROM public.checklist_templates WHERE organization_id = %L', pg_temp.id('o_t1'))) = 2,
                        'owner: T1 holds 2 seeded templates');
  PERFORM pg_temp.check(pg_temp.n(format('SELECT count(*) FROM public.checklist_template_items WHERE template_id = ANY (%L::uuid[])',
                                         '{' || current_setting('t3473.c1_tpl_ids') || '}')) = 3,
                        'owner: T1 templates hold 3 items');
END
$owner$;

SELECT pg_temp.act_as(pg_temp.id('u_e_broker'));
SELECT pg_temp.expect('C1 E broker reads T1 templates',
  format('SELECT 1 FROM public.checklist_templates WHERE organization_id = %L', pg_temp.id('o_t1')), 'rows:0');
SELECT pg_temp.expect('C1 E broker reads T1 items',
  format('SELECT 1 FROM public.checklist_template_items WHERE template_id = ANY (%L::uuid[])', '{' || current_setting('t3473.c1_tpl_ids') || '}'), 'rows:0');

SELECT pg_temp.act_as(pg_temp.id('u_e_agent'));
SELECT pg_temp.expect('C1 E agent reads T1 templates',
  format('SELECT 1 FROM public.checklist_templates WHERE organization_id = %L', pg_temp.id('o_t1')), 'rows:0');
SELECT pg_temp.expect('C1 E agent reads T1 items',
  format('SELECT 1 FROM public.checklist_template_items WHERE template_id = ANY (%L::uuid[])', '{' || current_setting('t3473.c1_tpl_ids') || '}'), 'rows:0');

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C1 T1 agent reads T1 templates',
  format('SELECT 1 FROM public.checklist_templates WHERE organization_id = %L', pg_temp.id('o_t1')), 'rows:2');
SELECT pg_temp.expect('C1 T1 agent reads T1 items',
  format('SELECT 1 FROM public.checklist_template_items WHERE template_id = ANY (%L::uuid[])', '{' || current_setting('t3473.c1_tpl_ids') || '}'), 'rows:3');

SELECT pg_temp.act_owner();
