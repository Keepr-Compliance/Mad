-- harness: rollback-3618
-- e13 (SR C4): rollback-3618.sql deletes every private template first, then
-- restores production exactly (the fingerprint recorded before the 3618 file
-- AND production's own, lib/fixtures-3618.sql). A brokerage template created
-- after the 3618 file survives; the broker never sees the private one.
SELECT set_config('t3618.p', pg_temp.tpl3618('o_t1', pg_temp.id('u_t1_agent'), 'e13 private', false)::text, true) IS NOT NULL;
SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('e13a broker creates a brokerage template under 3618', $q$SELECT * FROM public.save_checklist_template(p_org_id => current_setting('t3473.o_t1')::uuid, p_template_id => NULL, p_expected_updated_at => NULL, p_name => 'e13 brokerage', p_description => NULL, p_items => '[{"title":"x"}]'::jsonb)$q$, 'rows:1');
SELECT pg_temp.act_owner();
SELECT pg_temp.check((SELECT count(*) FROM public.checklist_templates WHERE name = 'e13 private') = 1, 'e13b private template present before the rollback');
-- @@ROLLBACK@@
SELECT pg_temp.check(pg_temp.fp_diff('SELECT * FROM pg_temp.fp3618()', 'SELECT * FROM t3618_before') = '',
       'e13c rollback = before: ' || pg_temp.fp_diff('SELECT * FROM pg_temp.fp3618()', 'SELECT * FROM t3618_before'));
SELECT pg_temp.check(pg_temp.fp_diff('SELECT * FROM pg_temp.fp3618()', 'SELECT * FROM pg_temp.prod3618()') = '',
       'e13d rollback = production: ' || pg_temp.fp_diff('SELECT * FROM pg_temp.fp3618()', 'SELECT * FROM pg_temp.prod3618()'));
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE name = 'e13 private'), 'e13e the private template is gone, not turned into a brokerage one');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_template_items WHERE template_id = current_setting('t3618.p')::uuid), 'e13f its items are gone');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_templates WHERE name = 'e13 brokerage'), 'e13g brokerage template kept');
SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('e13h broker sees no row named e13 private', $q$SELECT 1 FROM public.checklist_templates WHERE name = 'e13 private'$q$, 'rows:0');
SELECT pg_temp.expect('e13i the six-argument save works again', $q$SELECT * FROM public.save_checklist_template(current_setting('t3473.o_t1')::uuid, NULL, NULL, 'e13 after', NULL, '[{"title":"x"}]'::jsonb)$q$, 'rows:1');
SELECT pg_temp.act_owner();
