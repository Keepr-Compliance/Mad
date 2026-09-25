-- C42 (BACKLOG-3535 item 4): the seed trigger's floor is
-- feature_definitions.min_tier for transaction_checklists, swept at both
-- boundaries. The fixture catalogue holds zz_test_a and zz_test_b.
-- Mutants: m36 (floor removed) -> C42.1; m75 (floor literal 'individual') ->
-- C42.1; m76 (floor left at literal 'team') -> C42.2; m77 (<= for <) -> C42.2.
CREATE FUNCTION pg_temp.c42_n(p_org uuid) RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.checklist_templates WHERE organization_id = p_org AND seed_key IS NOT NULL $$;
CREATE FUNCTION pg_temp.c42_rewrite(p_org uuid, p_min text) RETURNS bigint
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.feature_definitions SET min_tier = p_min WHERE key = 'transaction_checklists';
  UPDATE public.organization_plans SET plan_id = plan_id WHERE organization_id = p_org;  -- UPDATE OF plan_id fires the trigger
  RETURN pg_temp.c42_n(p_org);
END $$;

SELECT pg_temp.act_owner();
DO $c42$
DECLARE v_res jsonb; v_org uuid;
BEGIN
  -- I was created during fixtures, before this migration: no copies.
  PERFORM pg_temp.check(pg_temp.c42_n(pg_temp.id('o_i')) = 0, 'C42 pre: I holds no copies');
  -- individual boundary
  PERFORM pg_temp.check(pg_temp.c42_rewrite(pg_temp.id('o_i'), 'team') = 0, 'C42.1 min_tier team: individual org I not seeded');
  PERFORM pg_temp.check(pg_temp.c42_rewrite(pg_temp.id('o_i'), 'individual') = 2, 'C42.2 min_tier individual: I seeded with both starters');
  -- team boundary (T2 is team; clear its fixture copies first)
  DELETE FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_t2');
  PERFORM pg_temp.check(pg_temp.c42_rewrite(pg_temp.id('o_t2'), 'enterprise') = 0, 'C42.3 min_tier enterprise: team org T2 not seeded');
  PERFORM pg_temp.check(pg_temp.c42_rewrite(pg_temp.id('o_t2'), 'team') = 2, 'C42.4 min_tier team: T2 seeded');
  -- null min_tier: no floor
  DELETE FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_i');
  PERFORM pg_temp.check(pg_temp.c42_rewrite(pg_temp.id('o_i'), NULL) = 2, 'C42.5 min_tier NULL: I seeded');
  -- the real first-sign-in producer at min_tier individual
  UPDATE public.feature_definitions SET min_tier = 'individual' WHERE key = 'transaction_checklists';
  v_res := public._ensure_personal_organization_for(pg_temp.id('u_p'));
  PERFORM pg_temp.check(v_res ->> 'status' = 'created', format('C42.6 u_p first sign-in created, got %s', v_res));
  v_org := (v_res ->> 'organization_id')::uuid;
  PERFORM pg_temp.check(pg_temp.c42_n(v_org) = 2, 'C42.6 u_p personal org seeded at first sign-in');
END
$c42$;
