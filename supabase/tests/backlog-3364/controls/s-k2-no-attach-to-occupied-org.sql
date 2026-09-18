-- S-k2: ensure attaches a user only to a personal organization that holds no
-- other membership row. Fixture: an organization whose column names the user
-- (set by the owner role, the only role that can) and which already holds
-- another user's membership. ensure writes no membership and no plan row.

DO $control$
DECLARE
  k_target uuid := current_setting('t3364.u_target')::uuid;
  k_other  uuid := current_setting('t3364.u_other')::uuid;
  v_org uuid;
  v jsonb;
  n integer;
BEGIN
  INSERT INTO public.organizations (name, slug, max_seats, personal_owner_user_id)
  VALUES ('Fixture 3364 occupied', 'fixture-3364-occupied', 10, k_target)
  RETURNING id INTO v_org;
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
  VALUES (v_org, k_other, 'admin', 'active', now());

  v := public._ensure_personal_organization_for(k_target);

  PERFORM pg_temp.check(v->>'status' = 'conflict', format('ensure returns conflict, got %s', v));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = k_target),
                        'no membership written for the user');
  SELECT count(*) INTO n FROM public.organization_plans WHERE organization_id = v_org;
  PERFORM pg_temp.check(n = 0, format('no plan row written for the occupied organization, got %s', n));
  SELECT count(*) INTO n FROM public.organization_members WHERE organization_id = v_org;
  PERFORM pg_temp.check(n = 1, format('the occupied organization still holds only its original member, got %s', n));
END
$control$;
