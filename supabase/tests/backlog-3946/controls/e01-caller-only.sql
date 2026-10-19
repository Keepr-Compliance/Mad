-- E01: no identity helper answers about another user. Closed = false / 0 rows / 42501.
DO $$ DECLARE m text; BEGIN
  -- signed out
  m := pg_temp.as_role('anon', NULL, $q$select public.has_internal_role('{u_i}')$q$);
  PERFORM pg_temp.check('e01 anon has_internal_role(staff) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select public.is_super_admin('{u_sa}')$q$);
  PERFORM pg_temp.check('e01 anon is_super_admin(super) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.get_user_permissions('{u_i}'))$q$);
  PERFORM pg_temp.check('e01 anon get_user_permissions(staff) closed', m = 'OK 0' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select public.has_permission('{u_i}', 'probe3946.perm')$q$);
  PERFORM pg_temp.check('e01 anon has_permission(staff) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  -- signed in, not staff, asks about staff
  m := pg_temp.as_user('u_g', $q$select public.has_internal_role('{u_i}')$q$);
  PERFORM pg_temp.check('e01 agent has_internal_role(staff) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_g', $q$select public.has_permission('{u_i}', 'probe3946.perm')$q$);
  PERFORM pg_temp.check('e01 agent has_permission(staff) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_g', $q$select public.has_any_permission('{u_i}', ARRAY['probe3946.perm'])$q$);
  PERFORM pg_temp.check('e01 agent has_any_permission(staff) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_g', $q$select public.is_super_admin('{u_sa}')$q$);
  PERFORM pg_temp.check('e01 agent is_super_admin(super) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_g', $q$select (select count(*) from public.get_user_permissions('{u_i}'))$q$);
  PERFORM pg_temp.check('e01 agent get_user_permissions(staff) closed', m = 'OK 0' OR m LIKE 'ERR 42501%', m);
  -- staff asks about someone else (the only checks that catch "parameter ignored, auth.uid() used")
  m := pg_temp.as_user('u_i', $q$select public.has_internal_role('{u_g}')$q$);
  PERFORM pg_temp.check('e01 staff has_internal_role(agent) = false', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_i', $q$select public.has_permission('{u_g}', 'probe3946.perm')$q$);
  PERFORM pg_temp.check('e01 staff has_permission(agent) = false', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_i', $q$select public.has_any_permission('{u_g}', ARRAY['probe3946.perm'])$q$);
  PERFORM pg_temp.check('e01 staff has_any_permission(agent) = false', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_i', $q$select (select count(*) from public.get_user_permissions('{u_g}'))$q$);
  PERFORM pg_temp.check('e01 staff get_user_permissions(agent) = 0', m = 'OK 0' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_sa', $q$select public.is_super_admin('{u_i}')$q$);
  PERFORM pg_temp.check('e01 super is_super_admin(staff) = false', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  -- staff asks about fellow staff
  m := pg_temp.as_user('u_sa', $q$select public.has_internal_role('{u_i}')$q$);
  PERFORM pg_temp.check('e01 super has_internal_role(fellow staff) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_sa', $q$select (select count(*) from public.get_user_permissions('{u_i}'))$q$);
  PERFORM pg_temp.check('e01 super get_user_permissions(fellow staff) closed', m = 'OK 0' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_i', $q$select public.is_super_admin('{u_sa}')$q$);
  PERFORM pg_temp.check('e01 staff is_super_admin(super) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  -- positives: own id still answers
  m := pg_temp.as_user('u_i', $q$select public.has_internal_role('{u_i}')$q$);
  PERFORM pg_temp.check('e01 own has_internal_role = true', m = 'OK true', m);
  m := pg_temp.as_user('u_g', $q$select public.has_internal_role('{u_g}')$q$);
  PERFORM pg_temp.check('e01 own has_internal_role as agent = false', m = 'OK false', m);
  m := pg_temp.as_user('u_i', $q$select public.has_permission('{u_i}', 'probe3946.perm')$q$);
  PERFORM pg_temp.check('e01 own has_permission = true', m = 'OK true', m);
  m := pg_temp.as_user('u_i', $q$select public.has_permission('{u_i}', 'no.such.perm')$q$);
  PERFORM pg_temp.check('e01 own has_permission(unheld) = false', m = 'OK false', m);
  m := pg_temp.as_user('u_i', $q$select public.has_any_permission('{u_i}', ARRAY['x.none','probe3946.perm'])$q$);
  PERFORM pg_temp.check('e01 own has_any_permission = true', m = 'OK true', m);
  m := pg_temp.as_user('u_sa', $q$select public.is_super_admin('{u_sa}')$q$);
  PERFORM pg_temp.check('e01 own is_super_admin = true', m = 'OK true', m);
  m := pg_temp.as_user('u_i', $q$select public.is_super_admin('{u_i}')$q$);
  PERFORM pg_temp.check('e01 own is_super_admin as non-system staff = false', m = 'OK false', m);
  m := pg_temp.as_user('u_i', $q$select (select count(*) from public.get_user_permissions('{u_i}') g where g.key in ('plans.view','users.view','probe3946.perm'))$q$);
  PERFORM pg_temp.check('e01 own get_user_permissions = 3', m = 'OK 3', m);
END $$;
