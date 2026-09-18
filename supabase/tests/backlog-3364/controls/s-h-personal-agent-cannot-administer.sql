-- S-h: the owner of a personal organization is an `agent` there, so as the
-- signed-in user they cannot change the organization, add members or change
-- its plan row.

DO $setup$
DECLARE
  v jsonb;
BEGIN
  v := public._ensure_personal_organization_for(current_setting('t3364.u_personal_f')::uuid);
  PERFORM pg_temp.check(v->>'status' = 'created', format('personal organization created, got %s', v));
  PERFORM set_config('t3364.ph_org', v->>'organization_id', true);
END
$setup$;

SELECT pg_temp.act_as(current_setting('t3364.u_personal_f')::uuid);
DO $as_personal$
DECLARE
  n integer;
BEGIN
  UPDATE public.organizations SET name = 'fixture-3364 renamed'
   WHERE id = current_setting('t3364.ph_org')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('t3364.sh_update_org', n::text, true);

  BEGIN
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
    VALUES (current_setting('t3364.ph_org')::uuid, current_setting('t3364.u_other')::uuid, 'agent', 'active', now());
    PERFORM set_config('t3364.sh_add_member', 'allowed', true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.sh_add_member', 'denied', true);
  END;

  UPDATE public.organization_plans SET feature_overrides = '{"fixture_3364": true}'::jsonb
   WHERE organization_id = current_setting('t3364.ph_org')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('t3364.sh_update_plan', n::text, true);
END
$as_personal$;
RESET ROLE;

DO $assert$
BEGIN
  PERFORM pg_temp.check(current_setting('t3364.sh_update_org') = '0',
                        format('personal agent updates 0 organization rows, got %s', current_setting('t3364.sh_update_org')));
  PERFORM pg_temp.check(current_setting('t3364.sh_add_member') = 'denied',
                        format('personal agent cannot add a member, got %s', current_setting('t3364.sh_add_member')));
  PERFORM pg_temp.check(current_setting('t3364.sh_update_plan') = '0',
                        format('personal agent updates 0 plan rows, got %s', current_setting('t3364.sh_update_plan')));
  PERFORM pg_temp.check((SELECT name FROM public.organizations WHERE id = current_setting('t3364.ph_org')::uuid) = 'Personal',
                        'organization name unchanged');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members
                                    WHERE organization_id = current_setting('t3364.ph_org')::uuid
                                      AND user_id = current_setting('t3364.u_other')::uuid),
                        'no member added');
END
$assert$;
