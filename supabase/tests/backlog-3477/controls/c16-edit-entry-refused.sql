-- C16 (SR condition C13, second probe on its own): editing an existing entry
-- in place -- same length, entry 0 changed -- is refused. Split from C13 so a
-- mutant that drops the prefix test is seen by this probe independently of
-- C13's first probe (C13 stops at its first failure).
SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C16 edit entry 0',
  format('UPDATE public.transaction_submissions SET status_history = jsonb_set(status_history, ''{0,notes}'', ''"edited"'') WHERE id = %L', pg_temp.id('s_sub')),
  '~^42501:status_history_append_only$');
SELECT pg_temp.expect('C16 replace entry 0 with another status',
  format('UPDATE public.transaction_submissions SET status_history = jsonb_build_array(jsonb_build_object(''status'', ''approved'')) WHERE id = %L', pg_temp.id('s_sub')),
  '~^42501:status_history_append_only$');
SELECT pg_temp.act_owner();
SELECT pg_temp.check(pg_temp.hist(pg_temp.id('s_sub')) -> 0 ->> 'status' = 'submitted' AND pg_temp.hist(pg_temp.id('s_sub')) -> 0 -> 'notes' = 'null'::jsonb,
                     'C16 entry 0 unchanged');
