-- C00 (read as a member of each org -- check_feature_access answers members only): the fixture states every other control rests on. Not a gate on the
-- migration; a red here means the fixtures, not the code, are wrong.
--   T1 holds transaction_checklists; T2 does not.
--   T1 has starter A (live) and starter B (archived); E has starter A.
--   S_sub carries one status entry.
SELECT pg_temp.check(COALESCE((pg_temp.cell('check_feature_access', pg_temp.id('o_t1'), 'transaction_checklists', pg_temp.id('u_t1_broker')) ->> 'enabled')::boolean, false),
                     'T1 holds transaction_checklists');
SELECT pg_temp.check(NOT COALESCE((pg_temp.cell('check_feature_access', pg_temp.id('o_t2'), 'transaction_checklists', pg_temp.id('u_t2_broker')) ->> 'enabled')::boolean, false),
                     'T2 does not hold transaction_checklists');
SELECT pg_temp.check(current_setting('t3473.tpl_t1_a') <> '', 'T1 starter A exists');
SELECT pg_temp.check((SELECT archived_at IS NOT NULL FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_b')), 'T1 starter B archived');
SELECT pg_temp.check(current_setting('t3473.tpl_e_a') <> '', 'E starter A exists');
SELECT pg_temp.check(jsonb_array_length(pg_temp.hist(pg_temp.id('s_sub'))) = 1, 'S_sub has one status entry');
SELECT pg_temp.check((SELECT count(*) FROM public.checklist_template_items WHERE template_id = pg_temp.id('tpl_t1_a')) = 2,
                     'T1 starter A has two items');
