-- Writers that must keep working: service_role (its own table grant and the
-- service_role policy) and a SECURITY DEFINER function owned by postgres
-- (admin_suspend_user, called by a user holding an internal role).
-- Fixture shape transcribed from production catalog: internal_roles.role_id is
-- NOT NULL and references admin_roles(id); admin_roles requires name and slug
-- (both unique). A venue may have no admin_roles row, so a synthetic one is
-- created inside the transaction (rolled back with it).
INSERT INTO public.admin_roles (name, slug)
  VALUES ('x3714 synthetic role', 'x3714-synthetic-role');
INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.id('u_admin'), (SELECT id FROM public.admin_roles WHERE slug = 'x3714-synthetic-role');
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
