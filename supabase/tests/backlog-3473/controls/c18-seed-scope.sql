-- C18 (Addendum B R7): which organizations get the starter copies.
--   T1, T2 (team, no override), E (enterprise), C (custom) each hold exactly
--   {zz_test_a, zz_test_b}: 2 templates, 3 items, seed_key + seeded_at set,
--   created_by NULL                                                 : yes
--   personal org I (individual)                                     : 0 templates
--     (I's plan row is written by the fixtures, under file 2's team floor,
--     before file 7 loads; existing orgs get starters from the backfill
--     query in file 7's header, not from the trigger)
--   u_p signs in for the first time -- the real producer, in this control,
--   AFTER migration 1's override trigger exists:
--     status is exactly 'created'; an organization_plans row exists for the
--     returned org on the individual plan; exactly {zz_test_a, zz_test_b}
--     (BACKLOG-3535: the seed floor follows min_tier = individual. Before
--     20260925044046 this asserted 0 templates.)
-- Mutants: m38 (PERFORM 1/0 BEFORE the early return: first sign-in raises),
-- m49 (the override trigger returns NULL on its early-return path: the plan
-- row is silently skipped). m37 and m39 retired by BACKLOG-3535 (reasons in
-- mutants/generate.mjs); the floor's mutants target C42.

SELECT pg_temp.act_owner();
DO $c18$
DECLARE
  o     text;
  v_res jsonb;
  v_org uuid;
BEGIN
  FOREACH o IN ARRAY ARRAY['o_t1', 'o_t2', 'o_e', 'o_c'] LOOP
    PERFORM pg_temp.check(
      (SELECT string_agg(seed_key, ',' ORDER BY seed_key) FROM public.checklist_templates
        WHERE organization_id = pg_temp.id(o)) = 'zz_test_a,zz_test_b',
      o || ' holds exactly {zz_test_a, zz_test_b}');
    PERFORM pg_temp.check(
      (SELECT count(*) FROM public.checklist_template_items i JOIN public.checklist_templates t ON t.id = i.template_id
        WHERE t.organization_id = pg_temp.id(o)) = 3,
      o || ' holds 3 items');
    PERFORM pg_temp.check(
      NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE organization_id = pg_temp.id(o)
                   AND (seeded_at IS NULL OR created_by IS NOT NULL)),
      o || ' copies carry seeded_at and no creator');
  END LOOP;
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_i')),
                        'personal org I holds no templates');

  v_res := public._ensure_personal_organization_for(pg_temp.id('u_p'));
  PERFORM pg_temp.check(v_res ->> 'status' = 'created', format('first sign-in of u_p: status created, got %s', v_res));
  v_org := (v_res ->> 'organization_id')::uuid;
  PERFORM pg_temp.check(
    (SELECT p.tier FROM public.organization_plans op JOIN public.plans p ON p.id = op.plan_id
      WHERE op.organization_id = v_org) = 'individual',
    'u_p''s personal org has its organization_plans row, on the individual plan');
  PERFORM pg_temp.check(
    (SELECT string_agg(seed_key, ',' ORDER BY seed_key) FROM public.checklist_templates
      WHERE organization_id = v_org) IS NOT DISTINCT FROM 'zz_test_a,zz_test_b',
    'u_p''s personal org holds exactly {zz_test_a, zz_test_b}');
END
$c18$;
