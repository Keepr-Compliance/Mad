-- E06 (strict): second asker/target pair per helper, strict anon EXECUTE refusal per helper,
-- service_role (NULL auth.uid()) gets false by design, anon SELECT on links refused by grant.
DO $$ DECLARE m text; BEGIN
  -- guard dropped: a second non-self asker (org admin) about staff / super
  m := pg_temp.as_user('u_a', $q$select public.has_internal_role('{u_i}')$q$);
  PERFORM pg_temp.check('e06 orgadmin has_internal_role(staff) = false', m = 'OK false', m);
  m := pg_temp.as_user('u_a', $q$select public.has_permission('{u_i}', 'probe3946.perm')$q$);
  PERFORM pg_temp.check('e06 orgadmin has_permission(staff) = false', m = 'OK false', m);
  m := pg_temp.as_user('u_a', $q$select public.has_any_permission('{u_i}', ARRAY['probe3946.perm'])$q$);
  PERFORM pg_temp.check('e06 orgadmin has_any_permission(staff) = false', m = 'OK false', m);
  m := pg_temp.as_user('u_a', $q$select (select count(*) from public.get_user_permissions('{u_i}'))$q$);
  PERFORM pg_temp.check('e06 orgadmin get_user_permissions(staff) = 0', m = 'OK 0', m);
  m := pg_temp.as_user('u_a', $q$select public.is_super_admin('{u_sa}')$q$);
  PERFORM pg_temp.check('e06 orgadmin is_super_admin(super) = false', m = 'OK false', m);
  -- parameter ignored: a second asker-who-holds-it about a target who does not
  m := pg_temp.as_user('u_i', $q$select public.has_internal_role('{u_a}')$q$);
  PERFORM pg_temp.check('e06 staff has_internal_role(orgadmin) = false', m = 'OK false', m);
  m := pg_temp.as_user('u_i', $q$select public.has_permission('{u_sa}', 'probe3946.perm')$q$);
  PERFORM pg_temp.check('e06 staff has_permission(super w/o perm) = false', m = 'OK false', m);
  m := pg_temp.as_user('u_i', $q$select public.has_any_permission('{u_sa}', ARRAY['probe3946.perm'])$q$);
  PERFORM pg_temp.check('e06 staff has_any_permission(super w/o perm) = false', m = 'OK false', m);
  m := pg_temp.as_user('u_i', $q$select (select count(*) from public.get_user_permissions('{u_sa}'))$q$);
  PERFORM pg_temp.check('e06 staff get_user_permissions(super w/o perm) = 0', m = 'OK 0', m);
  m := pg_temp.as_user('u_sa', $q$select public.is_super_admin('{u_a}')$q$);
  PERFORM pg_temp.check('e06 super is_super_admin(orgadmin) = false', m = 'OK false', m);
  -- strict anon refusal, one per helper (behavioural twin of the e04 catalogue check)
  m := pg_temp.as_role('anon', NULL, $q$select public.has_internal_role('{u_i}')$q$);
  PERFORM pg_temp.check('e06 anon exec has_internal_role = 42501', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select public.is_super_admin('{u_sa}')$q$);
  PERFORM pg_temp.check('e06 anon exec is_super_admin = 42501', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.get_user_permissions('{u_i}'))$q$);
  PERFORM pg_temp.check('e06 anon exec get_user_permissions = 42501', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select public.has_permission('{u_i}', 'probe3946.perm')$q$);
  PERFORM pg_temp.check('e06 anon exec has_permission = 42501', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select public.has_any_permission('{u_i}', ARRAY['probe3946.perm'])$q$);
  PERFORM pg_temp.check('e06 anon exec has_any_permission = 42501', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.get_user_org_ids('{u_a}'))$q$);
  PERFORM pg_temp.check('e06 anon exec get_user_org_ids = 42501', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select public.is_org_admin('{u_a}', '{org1}')$q$);
  PERFORM pg_temp.check('e06 anon exec is_org_admin = 42501', m LIKE 'ERR 42501%', m);
  -- service_role: NULL auth.uid() -> false by design (no service caller exists; this pins it)
  m := pg_temp.as_role('service_role', NULL, $q$select public.has_permission('{u_i}', 'probe3946.perm')$q$);
  PERFORM pg_temp.check('e06 service_role has_permission(staff) = false', m = 'OK false', m);
  m := pg_temp.as_role('service_role', NULL, $q$select public.has_internal_role('{u_i}')$q$);
  PERFORM pg_temp.check('e06 service_role has_internal_role(staff) = false', m = 'OK false', m);
  m := pg_temp.as_role('service_role', NULL, $q$select (select count(*) from public.get_user_permissions('{u_i}'))$q$);
  PERFORM pg_temp.check('e06 service_role get_user_permissions(staff) = 0', m = 'OK 0', m);
  m := pg_temp.as_role('service_role', NULL, $q$select public.has_any_permission('{u_i}', ARRAY['probe3946.perm'])$q$);
  PERFORM pg_temp.check('e06 service_role has_any_permission(staff) = false', m = 'OK false', m);
  m := pg_temp.as_role('service_role', NULL, $q$select public.is_super_admin('{u_sa}')$q$);
  PERFORM pg_temp.check('e06 service_role is_super_admin(super) = false', m = 'OK false', m);
  -- links: anon SELECT refused by grant (C1)
  m := pg_temp.as_role('anon', NULL, 'select (select count(*) from public.support_ticket_backlog_links)');
  PERFORM pg_temp.check('e06 anon select links = 42501', m LIKE 'ERR 42501%', m);
END $$;
