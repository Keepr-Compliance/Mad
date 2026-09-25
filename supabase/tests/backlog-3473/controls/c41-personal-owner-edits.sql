-- C41 (BACKLOG-3535 item 2): the owner of a personal organization edits THAT
-- organization's templates; nobody else gains anything.
-- Needs 20260924183422 (min_tier individual) loaded, so personal org I's
-- fixture override {"transaction_checklists": {"enabled": true}} is honoured.
-- Mutants: m74 (owner clause removed: the item not implemented) -> C41.1;
-- m71 (owner of ANY org) -> C41.6; m72 (any member of a personal org) and
-- m73 (member of SOME personal org) -> C41.4 [synthetic fixture]; m04 (agent
-- admitted) -> C41.3; m07 (entitlement dropped) -> C41.5.
-- Not a mutant: the owner clause moved OUTSIDE the membership EXISTS. It is
-- masked by check_feature_access's non-member refusal (SR ruling on the plan);
-- the CI text tripwire solo-checklists-3535.test.ts is its control.
CREATE FUNCTION pg_temp.c41_can(p_uid uuid, p_org uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v boolean;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  v := public.can_edit_checklist_templates(p_org);
  PERFORM pg_temp.act_owner();
  RETURN v;
END $$;
CREATE FUNCTION pg_temp.c41_rls_insert(p_uid uuid, p_org uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE res text;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  BEGIN
    INSERT INTO public.checklist_templates (organization_id, name) VALUES (p_org, 'c41 rls');
    res := 'ok';
  EXCEPTION WHEN OTHERS THEN res := SQLSTATE; END;
  PERFORM pg_temp.act_owner();
  RETURN res;
END $$;

SELECT pg_temp.act_owner();
DO $c41$
DECLARE
  one jsonb := '[{"title": "c41 x"}]'::jsonb;
  res text;
BEGIN
  -- preconditions: I is the real producer's personal org, u_i its owner and only member, role agent
  PERFORM pg_temp.check((SELECT personal_owner_user_id FROM public.organizations WHERE id = pg_temp.id('o_i')) = pg_temp.id('u_i'), 'C41 pre: u_i owns I');
  PERFORM pg_temp.check((SELECT string_agg(role, ',') FROM public.organization_members WHERE organization_id = pg_temp.id('o_i')) = 'agent', 'C41 pre: I has one member, role agent');
  PERFORM pg_temp.check((public.check_feature_access(pg_temp.id('o_i'), 'transaction_checklists') IS NOT NULL), 'C41 pre: feature call');

  -- 41.1 owner, feature on
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_i'), pg_temp.id('o_i')) IS TRUE, 'C41.1 owner of I may edit I');
  res := pg_temp.t3474_save(pg_temp.id('u_i'), pg_temp.id('o_i'), NULL, NULL, 'c41 solo', NULL, one);
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C41.1 owner saves a new template in I, got %s', res));
  PERFORM pg_temp.check(pg_temp.c41_rls_insert(pg_temp.id('u_i'), pg_temp.id('o_i')) = 'ok', 'C41.1 owner passes the insert policy in I');

  -- 41.2 owner has no reach outside I
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_i'), pg_temp.id('o_t1')) IS FALSE, 'C41.2 owner of I may not edit T1');
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_i'), pg_temp.id('o_e')) IS FALSE, 'C41.2 owner of I may not edit E');

  -- 41.3 brokerage agents stay refused (feature on in T1 and E)
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_t1_agent'), pg_temp.id('o_t1')) IS FALSE, 'C41.3 T1 agent refused');
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_x'), pg_temp.id('o_e')) IS FALSE, 'C41.3 agent in E (broker in T1) refused in E');
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1')) IS TRUE, 'C41.3 T1 broker still allowed');

  -- 41.4 other users on I
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_outsider'), pg_temp.id('o_i')) IS FALSE, 'C41.4 non-member refused on I');
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_t1_broker'), pg_temp.id('o_i')) IS FALSE, 'C41.4 a brokerage broker refused on I');
  -- SYNTHETIC (no producer writes a second member into a personal org:
  -- _ensure_personal_organization_for returns 'conflict'). Defence in depth
  -- against a rule that admits any member of a personal org.
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
  VALUES (pg_temp.id('o_i'), pg_temp.id('u_outsider'), 'agent', 'active', now());
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_outsider'), pg_temp.id('o_i')) IS FALSE, 'C41.4 non-owner member of I refused [synthetic]');
  PERFORM pg_temp.check(pg_temp.c41_rls_insert(pg_temp.id('u_outsider'), pg_temp.id('o_i')) = '42501', 'C41.4 non-owner member refused by the insert policy [synthetic]');
  DELETE FROM public.organization_members WHERE organization_id = pg_temp.id('o_i') AND user_id = pg_temp.id('u_outsider');

  -- 41.5 feature off for I -> owner refused
  UPDATE public.organization_plans SET feature_overrides = feature_overrides - 'transaction_checklists' WHERE organization_id = pg_temp.id('o_i');
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_i'), pg_temp.id('o_i')) IS FALSE, 'C41.5 owner refused when the feature is off for I');
  UPDATE public.organization_plans SET feature_overrides = feature_overrides || '{"transaction_checklists": {"enabled": true}}'::jsonb WHERE organization_id = pg_temp.id('o_i');
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_i'), pg_temp.id('o_i')) IS TRUE, 'C41.5 owner allowed again');

  -- 41.6 the real "solo user joins a brokerage" path: a T1 agent row for u_i.
  -- _retire_personal_membership deletes u_i's row in I; I keeps its owner.
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
  VALUES (pg_temp.id('o_t1'), pg_temp.id('u_i'), 'agent', 'active', now());
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = pg_temp.id('o_i') AND user_id = pg_temp.id('u_i')), 'C41.6 pre: the personal membership was retired');
  PERFORM pg_temp.check((SELECT personal_owner_user_id FROM public.organizations WHERE id = pg_temp.id('o_i')) = pg_temp.id('u_i'), 'C41.6 pre: I still names u_i as owner');
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_i'), pg_temp.id('o_t1')) IS FALSE, 'C41.6 former solo user, now a T1 agent, refused in T1');
  PERFORM pg_temp.check(pg_temp.c41_can(pg_temp.id('u_i'), pg_temp.id('o_i')) IS FALSE, 'C41.6 former solo user refused on the personal org he no longer belongs to');
END
$c41$;
