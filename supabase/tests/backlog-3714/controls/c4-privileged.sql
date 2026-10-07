-- Writers that must keep working: service_role (its own table grant and the
-- service_role policy) and a SECURITY DEFINER function owned by postgres
-- (admin_suspend_user, called by a user holding an internal role).
-- If the venue has no admin_roles row or no admin_suspend_user, this control
-- ERRORs; it does not pass.
INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.id('u_admin'), (SELECT id FROM public.admin_roles ORDER BY id LIMIT 1);
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_role('service_role', NULL,
    'update public.users set subscription_tier = ''pro'' where id = ''{u_self}''', true);
  PERFORM pg_temp.check('c4 service_role: UPDATE of subscription_tier stored',
    m = 'OK rows=1' AND pg_temp.snap('u_self')->>'subscription_tier' = 'pro', m);
  m := pg_temp.as_role('authenticated', pg_temp.id('u_admin'),
    'select public.admin_suspend_user(''{u_self}''::uuid, ''c4 3714'')', true);
  PERFORM pg_temp.check('c4 admin_suspend_user (SECURITY DEFINER) as an internal-role user: status stored',
    m = 'OK rows=1' AND pg_temp.snap('u_self')->>'status' = 'suspended'
    AND pg_temp.snap('u_self')->>'suspension_reason' = 'c4 3714',
    m || ' status=' || coalesce(pg_temp.snap('u_self')->>'status', '<null>'));
END $$;
