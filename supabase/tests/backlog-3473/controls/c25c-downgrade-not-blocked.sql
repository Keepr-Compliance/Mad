-- C25c (B.1, K7): a plan downgrade is never blocked by the override trigger.
-- Through the real producer:
--   org D on enterprise (admin_assign_org_plan as u_staff)          : success
--   owner writes sso_login ON (valid at write: enterprise)           : rows:1
--   u_d added to D as an agent (the read functions need a member)
--   admin_assign_org_plan(D, team) as u_staff                        : success true
--   all three read functions as u_d: sso_login                       : false / plan / ignored
-- Mutant: m46 (strict: fires on every write, validates every entry against
-- NEW.plan_id -> the downgrade raises).

SELECT pg_temp.act_owner();
DO $c25c$
DECLARE
  v_res jsonb;
  rpc   text;
  got   jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, slug, max_seats)
  VALUES (pg_temp.id('o_d'), 'Fixture Brokerage 3473 D', 'fixture-3473-d', 20);

  PERFORM pg_temp.act_as(pg_temp.id('u_staff'));
  v_res := public.admin_assign_org_plan(pg_temp.id('o_d'), pg_temp.id('p_enterprise'));
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((v_res ->> 'success')::boolean IS TRUE, format('D assigned enterprise, got %s', v_res));

  PERFORM pg_temp.expect('C25c sso_login ON on enterprise D',
    format($q$UPDATE public.organization_plans SET feature_overrides = '{"sso_login": {"enabled": true}}'::jsonb
               WHERE organization_id = %L$q$, pg_temp.id('o_d')),
    'rows:1');
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
  VALUES (pg_temp.id('o_d'), pg_temp.id('u_d'), 'agent', 'active', now());

  PERFORM pg_temp.act_as(pg_temp.id('u_staff'));
  v_res := public.admin_assign_org_plan(pg_temp.id('o_d'), pg_temp.id('p_team'));
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((v_res ->> 'success')::boolean IS TRUE, format('D downgraded to team, got %s', v_res));

  FOREACH rpc IN ARRAY ARRAY['check_feature_access', 'get_org_features', 'broker_get_org_features'] LOOP
    got := pg_temp.cell(rpc, pg_temp.id('o_d'), 'sso_login', pg_temp.id('u_d'));
    PERFORM pg_temp.check(got = '{"enabled": false, "value": "false", "source": "plan", "override_ignored": true}'::jsonb,
                          format('%s after the downgrade: want false / plan / ignored, got %s', rpc, got));
  END LOOP;
END
$c25c$;
