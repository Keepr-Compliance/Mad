-- e05: who may create their own (plan R5, SR4): member + plan feature; not a
-- feature-off org, not a non-member, not anon.
SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.check(public.can_create_own_checklist_templates(pg_temp.id('o_t1')), 'e05a entitled agent: true');
SELECT pg_temp.check(NOT public.can_create_own_checklist_templates(pg_temp.id('o_e')), 'e05b non-member: false');
SELECT pg_temp.act_as(pg_temp.id('u_t2_agent'));
SELECT pg_temp.check(NOT public.can_create_own_checklist_templates(pg_temp.id('o_t2')), 'e05c feature-off org: false');
SELECT pg_temp.expect('e05d feature-off agent INSERT private', format('INSERT INTO public.checklist_templates (organization_id, owner_user_id, name) VALUES (%L, %L, %L)', pg_temp.id('o_t2'), pg_temp.id('u_t2_agent'), 'e05d'), 'RLS');
SELECT pg_temp.expect('e05e feature-off agent save personal', format($q$SELECT * FROM public.save_checklist_template(%L, NULL, NULL, 'e05e', NULL, '[{"title":"x"}]'::jsonb, true)$q$, pg_temp.id('o_t2')), '~^42501:not_authorized');
SELECT pg_temp.act_anon();
SELECT pg_temp.expect('e05f anon SELECT templates', 'SELECT 1 FROM public.checklist_templates', '~^(rows:0|42501:permission denied)');
SELECT pg_temp.expect('e05g anon can_create_own', format('SELECT public.can_create_own_checklist_templates(%L)', pg_temp.id('o_t1')), 'PRIV');
SELECT pg_temp.expect('e05h anon can_write', format('SELECT public.can_write_checklist_template(%L, NULL)', pg_temp.id('o_t1')), 'PRIV');
SELECT pg_temp.act_owner();
