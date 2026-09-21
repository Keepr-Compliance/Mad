-- C19 (+ R8 for authenticated): seeding is not client-callable, the catalogue
-- is not client-readable, and the two internal helpers are not executable.
-- As the T1 broker (an editor of an entitled org):
--   EXECUTE _seed_org_checklist_templates(T1)      : PRIV
--   SELECT the catalogue                           : PRIV
--   EXECUTE _checklist_seed_items_valid, _override_above_tier : PRIV
--   EXECUTE can_edit_checklist_templates(T1)       : rows:1  <- the one the policies use
-- Mutants: m40 (EXECUTE on the seed function granted), m41 (SELECT on the
-- catalogue granted; RLS on, no policy -> rows:0, not PRIV).

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C19 EXECUTE seed function',
  format('SELECT public._seed_org_checklist_templates(%L)', pg_temp.id('o_t1')), 'PRIV');
SELECT pg_temp.expect('C19 SELECT catalogue', 'SELECT 1 FROM public.checklist_seed_templates', 'PRIV');
SELECT pg_temp.expect('C19 EXECUTE validator', 'SELECT public._checklist_seed_items_valid(''[]''::jsonb)', 'PRIV');
SELECT pg_temp.expect('C19 EXECUTE _override_above_tier',
  'SELECT public._override_above_tier(''sso_login'', ''enterprise'', ''team'', ''{"enabled": true}''::jsonb)', 'PRIV');
SELECT pg_temp.expect('C19 EXECUTE can_edit_checklist_templates',
  format('SELECT public.can_edit_checklist_templates(%L)', pg_temp.id('o_t1')), 'rows:1');
SELECT pg_temp.act_owner();
