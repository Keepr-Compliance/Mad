-- S-a: ensure, called twice for a licensed user with no membership, writes one
-- personal organization, one plan row on the default individual plan and one
-- membership (agent, active). The organization stores max_seats 1, JIT off,
-- default role agent and the legacy plan column default 'trial'.
-- A user with no license, and a NULL user, get nothing.

DO $control$
DECLARE
  k_user  uuid := current_setting('t3364.u_solo')::uuid;
  k_nolic uuid := current_setting('t3364.u_nolicense')::uuid;
  v1 jsonb;
  v2 jsonb;
  v3 jsonb;
  v_org public.organizations%ROWTYPE;
  v_mem public.organization_members%ROWTYPE;
  n integer;
BEGIN
  v1 := public._ensure_personal_organization_for(k_user);
  v2 := public._ensure_personal_organization_for(k_user);

  PERFORM pg_temp.check(v1->>'status' = 'created', format('first call returns created, got %s', v1));
  PERFORM pg_temp.check(v2->>'status' = 'exists', format('second call returns exists, got %s', v2));
  PERFORM pg_temp.check(v1->>'organization_id' = v2->>'organization_id', 'both calls name the same organization');

  SELECT count(*) INTO n FROM public.organizations WHERE personal_owner_user_id = k_user;
  PERFORM pg_temp.check(n = 1, format('exactly one personal organization, got %s', n));

  SELECT * INTO v_org FROM public.organizations WHERE personal_owner_user_id = k_user;
  PERFORM pg_temp.check(v_org.id::text = v1->>'organization_id', 'returned id is the stored organization');
  PERFORM pg_temp.check(v_org.max_seats = 1, format('max_seats 1, got %s', v_org.max_seats));
  PERFORM pg_temp.check(v_org.jit_provisioning_enabled IS FALSE, format('jit_provisioning_enabled false, got %s', v_org.jit_provisioning_enabled));
  PERFORM pg_temp.check(v_org.default_member_role = 'agent', format('default_member_role agent, got %s', v_org.default_member_role));
  PERFORM pg_temp.check(v_org.plan = 'trial', format('legacy plan column stores the default trial, got %s', v_org.plan));
  PERFORM pg_temp.check(v_org.name = 'Personal', format('name Personal, got %s', v_org.name));
  PERFORM pg_temp.check(v_org.slug = 'personal-' || replace(k_user::text, '-', ''), format('slug from user id, got %s', v_org.slug));

  SELECT count(*) INTO n FROM public.organization_plans WHERE organization_id = v_org.id;
  PERFORM pg_temp.check(n = 1, format('one plan row, got %s', n));
  PERFORM pg_temp.check(EXISTS (
    SELECT 1 FROM public.organization_plans op JOIN public.plans p ON p.id = op.plan_id
    WHERE op.organization_id = v_org.id AND p.tier = 'individual' AND p.is_default AND p.is_active
  ), 'plan row points at the default active individual plan');

  SELECT count(*) INTO n FROM public.organization_members WHERE organization_id = v_org.id;
  PERFORM pg_temp.check(n = 1, format('one membership row in the personal organization, got %s', n));
  SELECT * INTO v_mem FROM public.organization_members WHERE organization_id = v_org.id;
  PERFORM pg_temp.check(v_mem.user_id = k_user, 'the membership is the owner''s');
  PERFORM pg_temp.check(v_mem.role = 'agent', format('role agent, got %s', v_mem.role));
  PERFORM pg_temp.check(v_mem.license_status = 'active', format('license_status active, got %s', v_mem.license_status));
  PERFORM pg_temp.check(v_mem.joined_at IS NOT NULL, 'joined_at set');
  PERFORM pg_temp.check(v_mem.provisioned_by IS NULL, format('provisioned_by NULL, got %s', v_mem.provisioned_by));

  SELECT count(*) INTO n FROM public.organization_members WHERE user_id = k_user;
  PERFORM pg_temp.check(n = 1, format('the user holds exactly one membership, got %s', n));

  -- No license.
  v3 := public._ensure_personal_organization_for(k_nolic);
  PERFORM pg_temp.check(v3->>'status' = 'no_license', format('no license returns no_license, got %s', v3));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = k_nolic), 'no organization for an unlicensed user');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = k_nolic), 'no membership for an unlicensed user');

  -- NULL user.
  v3 := public._ensure_personal_organization_for(NULL);
  PERFORM pg_temp.check(v3->>'status' = 'no_user', format('NULL user returns no_user, got %s', v3));
END
$control$;
