-- C9 (catalog half; the text half is broker-portal/__tests__/migrations/personal-organizations-3364.test.ts):
--   * no trigger on auth.users other than production's own on_auth_user_created;
--   * handle_new_user, create_active_individual_license and admin_assign_org_plan
--     are byte-identical to production (md5 of pg_get_functiondef, 2026-09-15);
--   * the 3364 trigger functions are attached exactly where migration 1 attaches
--     them, and nowhere else.

DO $control$
DECLARE
  v_extra text;
BEGIN
  SELECT string_agg(tgname, ', ') INTO v_extra
  FROM pg_trigger
  WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal AND tgname <> 'on_auth_user_created';
  PERFORM pg_temp.check(v_extra IS NULL, format('no trigger on auth.users besides on_auth_user_created, found: %s', v_extra));

  PERFORM pg_temp.check(md5(pg_get_functiondef('public.handle_new_user()'::regprocedure)) = 'f5f3b32bbe334a1dc4411bf5406fc6d6',
                        'handle_new_user unchanged');
  PERFORM pg_temp.check(md5(pg_get_functiondef('public.create_active_individual_license(uuid)'::regprocedure)) = '8e1da1ae469558e4b0b86053ce0cd405',
                        'create_active_individual_license unchanged');
  PERFORM pg_temp.check(md5(pg_get_functiondef('public.admin_assign_org_plan'::regproc)) = 'aaf885fa8ab5ce8bf697a352793754b3',
                        'admin_assign_org_plan unchanged');

  SELECT string_agg(t.tgrelid::regclass || '.' || t.tgname, ', ') INTO v_extra
  FROM pg_trigger t
  WHERE NOT t.tgisinternal
    AND t.tgfoid IN ('public._guard_personal_owner_user_id()'::regprocedure,
                     'public._retire_personal_membership()'::regprocedure,
                     'public._ensure_personal_organization_for(uuid)'::regprocedure,
                     'public.ensure_personal_organization()'::regprocedure)
    AND NOT (t.tgrelid = 'public.organizations'::regclass AND t.tgname = 'guard_personal_owner_user_id'
             AND t.tgfoid = 'public._guard_personal_owner_user_id()'::regprocedure)
    AND NOT (t.tgrelid = 'public.organization_members'::regclass AND t.tgname = 'retire_personal_membership'
             AND t.tgfoid = 'public._retire_personal_membership()'::regprocedure);
  PERFORM pg_temp.check(v_extra IS NULL, format('3364 functions are attached only where migration 1 attaches them, extra: %s', v_extra));

  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organizations'::regclass AND tgname = 'guard_personal_owner_user_id'),
                        'guard trigger present');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organization_members'::regclass AND tgname = 'retire_personal_membership'),
                        'retirement trigger present');
END
$control$;
