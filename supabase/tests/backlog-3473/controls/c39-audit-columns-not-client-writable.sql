-- C39 (BACKLOG-3474 PR 3): a client can never write updated_by or archived_by.
-- Every case passes RLS (the caller is an editor of the row's organization),
-- so only the column grant can refuse.
--   broker UPDATE updated_by  -> PRIV        broker UPDATE archived_by -> PRIV
--   broker INSERT naming updated_by / archived_by -> PRIV
--   broker UPDATE name = name -> rows:1 (the same caller reaches the row)
-- Mutant: m69 (UPDATE and INSERT granted on the two columns).

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C39 updated_by forged',
  format('UPDATE public.checklist_templates SET updated_by = %L WHERE id = %L', pg_temp.id('u_t1_admin'), pg_temp.id('tpl_t1_a')), 'PRIV');
SELECT pg_temp.expect('C39 archived_by forged',
  format('UPDATE public.checklist_templates SET archived_by = %L WHERE id = %L', pg_temp.id('u_t1_admin'), pg_temp.id('tpl_t1_a')), 'PRIV');
SELECT pg_temp.expect('C39 insert naming updated_by',
  format('INSERT INTO public.checklist_templates (organization_id, name, updated_by) VALUES (%L, %L, %L)',
         pg_temp.id('o_t1'), 'c39 forged', pg_temp.id('u_t1_admin')), 'PRIV');
SELECT pg_temp.expect('C39 insert naming archived_by',
  format('INSERT INTO public.checklist_templates (organization_id, name, archived_at, archived_by) VALUES (%L, %L, now(), %L)',
         pg_temp.id('o_t1'), 'c39 forged 2', pg_temp.id('u_t1_admin')), 'PRIV');
SELECT pg_temp.expect('C39 name update reaches the row',
  format('UPDATE public.checklist_templates SET name = name WHERE id = %L', pg_temp.id('tpl_t1_a')), 'rows:1');
SELECT pg_temp.act_owner();
SELECT pg_temp.check((SELECT updated_by FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_a')) = pg_temp.id('u_t1_broker'),
                     'C39 the reachable update recorded the caller, not a forged value');
