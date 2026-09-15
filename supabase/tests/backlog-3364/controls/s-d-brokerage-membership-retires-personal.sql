-- S-d: when a user gains a membership in a non-personal organization, their
-- personal membership is removed; the personal organization and its plan row
-- stay. Covered writers:
--   (1) a claimed membership INSERTed directly (SCIM / setup / admin shape);
--   (2) an invite CLAIMED by UPDATE, through the real public.claim_pending_invite()
--       called as the signed-in user;
-- and the negatives:
--   (3) inserting an UNCLAIMED invite row (user_id NULL) removes nothing;
--   (4) joining a second brokerage leaves the first brokerage membership alone;
--   (5) another user's personal membership stays through every write above.

DO $control$
DECLARE
  k_joiner  uuid := current_setting('t3364.u_joiner')::uuid;
  k_claimer uuid := current_setting('t3364.u_claimer')::uuid;
  k_two     uuid := current_setting('t3364.u_two_brk')::uuid;
  k_brk_a   uuid := current_setting('t3364.o_brk_a')::uuid;
  k_brk_b   uuid := current_setting('t3364.o_brk_b')::uuid;
  k_bystander uuid := current_setting('t3364.u_bystander')::uuid;
  v jsonb;
  v_org uuid;
  v_plan uuid;
  v_bystander_org uuid;
BEGIN
  -- (5) setup: a second user with their own personal organization.
  v := public._ensure_personal_organization_for(k_bystander);
  PERFORM pg_temp.check(v->>'status' = 'created', format('bystander: personal organization created first, got %s', v));
  v_bystander_org := (v->>'organization_id')::uuid;
  PERFORM set_config('t3364.bystander_org', v_bystander_org::text, true);

  -- (1) direct INSERT of a claimed brokerage membership
  v := public._ensure_personal_organization_for(k_joiner);
  PERFORM pg_temp.check(v->>'status' = 'created', format('joiner: personal organization created first, got %s', v));
  v_org := (v->>'organization_id')::uuid;
  SELECT plan_id INTO v_plan FROM public.organization_plans WHERE organization_id = v_org;

  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
  VALUES (k_brk_b, k_joiner, 'agent', 'active', now());

  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = v_org AND user_id = k_joiner),
                        'joiner: personal membership removed when a brokerage membership is inserted');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organizations WHERE id = v_org AND personal_owner_user_id = k_joiner),
                        'joiner: personal organization kept');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_plans WHERE organization_id = v_org AND plan_id = v_plan),
                        'joiner: plan row kept, same plan');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = k_brk_b AND user_id = k_joiner),
                        'joiner: brokerage membership present');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = v_bystander_org AND user_id = k_bystander),
                        'bystander: personal membership kept when another user joins a brokerage');
END
$control$;

-- (2) + (3): claim by UPDATE through claim_pending_invite(), as the signed-in user.
DO $control$
DECLARE
  k_claimer uuid := current_setting('t3364.u_claimer')::uuid;
  k_brk_b   uuid := current_setting('t3364.o_brk_b')::uuid;
  v jsonb;
BEGIN
  v := public._ensure_personal_organization_for(k_claimer);
  PERFORM pg_temp.check(v->>'status' = 'created', format('claimer: personal organization created first, got %s', v));
  PERFORM set_config('t3364.claimer_org', v->>'organization_id', true);

  -- The invite arrives after the personal organization exists.
  INSERT INTO public.organization_members
    (organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at)
  VALUES (k_brk_b, NULL, 'agent', 'pending', 'claimer@fixture-3364.example.test', 'fixture-3364-token-claimer', now() + interval '7 days');

  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members
                                WHERE organization_id = (v->>'organization_id')::uuid AND user_id = k_claimer),
                        'claimer: an unclaimed invite row (user_id NULL) removes nothing');
END
$control$;

SELECT pg_temp.act_as(current_setting('t3364.u_claimer')::uuid);
SELECT set_config('t3364.claim_result', public.claim_pending_invite()::text, true) IS NOT NULL AS claimed;
RESET ROLE;

DO $control$
DECLARE
  k_claimer uuid := current_setting('t3364.u_claimer')::uuid;
  k_brk_b   uuid := current_setting('t3364.o_brk_b')::uuid;
  k_org     uuid := current_setting('t3364.claimer_org')::uuid;
  k_two     uuid := current_setting('t3364.u_two_brk')::uuid;
  k_brk_a   uuid := current_setting('t3364.o_brk_a')::uuid;
  v jsonb := current_setting('t3364.claim_result')::jsonb;
BEGIN
  PERFORM pg_temp.check((v->>'success')::boolean IS TRUE, format('claim_pending_invite succeeded, got %s', v));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = k_brk_b AND user_id = k_claimer AND license_status = 'active'),
                        'claimer: invite row now claimed by the user');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = k_org AND user_id = k_claimer),
                        'claimer: personal membership removed when the invite is claimed by UPDATE');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organizations WHERE id = k_org AND personal_owner_user_id = k_claimer),
                        'claimer: personal organization kept');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_plans WHERE organization_id = k_org),
                        'claimer: plan row kept');

  -- (4) a second brokerage membership leaves the first one alone.
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
  VALUES (k_brk_b, k_two, 'agent', 'active', now());
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = k_brk_a AND user_id = k_two),
                        'two brokerages: first brokerage membership kept');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = k_brk_b AND user_id = k_two),
                        'two brokerages: second brokerage membership present');

  -- (5) after the claim by UPDATE and the second-brokerage INSERT above.
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.organization_members
                                WHERE organization_id = current_setting('t3364.bystander_org')::uuid
                                  AND user_id = current_setting('t3364.u_bystander')::uuid),
                        'bystander: personal membership kept through the other users'' brokerage writes');
END
$control$;
