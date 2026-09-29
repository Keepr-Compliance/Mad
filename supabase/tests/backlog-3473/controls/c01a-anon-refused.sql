-- C1-anon (Addendum B R8): the anon role holds no privilege on any new object.
--   anon SELECT each of the 7 tables                     : PRIV
--   anon INSERT checklist_templates                      : PRIV
--   anon EXECUTE can_edit_checklist_templates,
--     _seed_org_checklist_templates,
--     _checklist_seed_items_valid, _override_above_tier  : PRIV
-- Policies are TO authenticated, so a stray anon grant would give rows:0 with
-- no error -- which PRIV refuses to accept.
-- Mutant: m03 (GRANT SELECT ON checklist_templates TO anon) -> rows:0 -> red.

SELECT pg_temp.act_anon();
SELECT pg_temp.expect('C1-anon SELECT ' || t, format('SELECT 1 FROM %s', t), 'PRIV')
  FROM unnest(ARRAY['public.checklist_seed_templates', 'public.checklist_templates',
                    'public.checklist_template_items', 'public.submission_checklists',
                    'public.submission_checklist_items', 'public.submission_checklist_links',
                    'public.submission_checklist_link_members']) t;
SELECT pg_temp.expect('C1-anon INSERT checklist_templates',
  format('INSERT INTO public.checklist_templates (organization_id, name) VALUES (%L, %L)', pg_temp.id('o_t1'), 'anon'), 'PRIV');
SELECT pg_temp.expect('C1-anon EXECUTE can_edit_checklist_templates',
  format('SELECT public.can_edit_checklist_templates(%L)', pg_temp.id('o_t1')), 'PRIV');
SELECT pg_temp.expect('C1-anon EXECUTE _seed_org_checklist_templates',
  format('SELECT public._seed_org_checklist_templates(%L)', pg_temp.id('o_t1')), 'PRIV');
SELECT pg_temp.expect('C1-anon EXECUTE _checklist_seed_items_valid',
  'SELECT public._checklist_seed_items_valid(''[]''::jsonb)', 'PRIV');
SELECT pg_temp.expect('C1-anon EXECUTE _override_above_tier',
  'SELECT public._override_above_tier(''sso_login'', ''enterprise'', ''team'', ''{"enabled": true}''::jsonb)', 'PRIV');
SELECT pg_temp.act_owner();
