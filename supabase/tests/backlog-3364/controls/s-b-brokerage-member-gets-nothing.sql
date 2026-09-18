-- S-b: a user with a membership in a non-personal organization gets nothing,
-- whether that membership is active or suspended.

DO $control$
DECLARE
  k_active    uuid := current_setting('t3364.u_broker_agent')::uuid;
  k_suspended uuid := current_setting('t3364.u_suspended')::uuid;
  v jsonb;
  n integer;
BEGIN
  v := public._ensure_personal_organization_for(k_active);
  PERFORM pg_temp.check(v->>'status' = 'has_membership', format('active brokerage member returns has_membership, got %s', v));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = k_active), 'no personal organization for the active member');
  SELECT count(*) INTO n FROM public.organization_members WHERE user_id = k_active;
  PERFORM pg_temp.check(n = 1, format('active member still holds exactly the brokerage row, got %s', n));

  v := public._ensure_personal_organization_for(k_suspended);
  PERFORM pg_temp.check(v->>'status' = 'has_membership', format('suspended brokerage member returns has_membership, got %s', v));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = k_suspended), 'no personal organization for the suspended member');
  SELECT count(*) INTO n FROM public.organization_members WHERE user_id = k_suspended;
  PERFORM pg_temp.check(n = 1, format('suspended member still holds exactly the brokerage row, got %s', n));
END
$control$;
