-- S-e: a user who joined a brokerage and then left it gets the SAME personal
-- organization and plan row back on the next ensure.

DO $control$
DECLARE
  k_user  uuid := current_setting('t3364.u_leaver')::uuid;
  k_brk_a uuid := current_setting('t3364.o_brk_a')::uuid;
  v1 jsonb;
  v2 jsonb;
  v_org uuid;
  v_plan_row uuid;
  n integer;
BEGIN
  v1 := public._ensure_personal_organization_for(k_user);
  PERFORM pg_temp.check(v1->>'status' = 'created', format('personal organization created, got %s', v1));
  v_org := (v1->>'organization_id')::uuid;
  SELECT id INTO v_plan_row FROM public.organization_plans WHERE organization_id = v_org;

  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
  VALUES (k_brk_a, k_user, 'agent', 'active', now());
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = v_org AND user_id = k_user),
                        'precondition: joining retired the personal membership');

  DELETE FROM public.organization_members WHERE organization_id = k_brk_a AND user_id = k_user;

  v2 := public._ensure_personal_organization_for(k_user);
  PERFORM pg_temp.check(v2->>'status' = 'attached', format('re-attach returns attached, got %s', v2));
  PERFORM pg_temp.check(v2->>'organization_id' = v_org::text, format('same organization id, first %s now %s', v_org, v2->>'organization_id'));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = v_org AND user_id = k_user AND role = 'agent' AND license_status = 'active'),
                        'membership back in the same organization');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_plans WHERE id = v_plan_row AND organization_id = v_org),
                        'same plan row');
  SELECT count(*) INTO n FROM public.organizations WHERE personal_owner_user_id = k_user;
  PERFORM pg_temp.check(n = 1, format('still one personal organization, got %s', n));
END
$control$;
