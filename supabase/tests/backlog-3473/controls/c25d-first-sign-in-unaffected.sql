-- C25d (K4): the override trigger can never disturb a first sign-in.
--   u_p's first sign-in, after migration 1   : status 'created' AND an
--   organization_plans row for the returned org, on the individual plan
-- (status alone is not enough: it comes from the organizations insert, so a
-- trigger that returned NULL would skip the plan row and still say 'created').
-- Mutants: m47 (PERFORM 1/0 before the early return -> 22012), m48 (after it
-- -> stays GREEN), m49 (RETURN NULL on the early-return path -> no plan row).

SELECT pg_temp.act_owner();
DO $c25d$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public._ensure_personal_organization_for(pg_temp.id('u_p'));
  PERFORM pg_temp.check(v_res ->> 'status' = 'created', format('status created, got %s', v_res));
  PERFORM pg_temp.check(
    (SELECT p.tier || '/' || coalesce(op.feature_overrides::text, 'NULL')
       FROM public.organization_plans op JOIN public.plans p ON p.id = op.plan_id
      WHERE op.organization_id = (v_res ->> 'organization_id')::uuid) = 'individual/{}',
    'the plan row exists, on the individual plan, with the default overrides');
END
$c25d$;
