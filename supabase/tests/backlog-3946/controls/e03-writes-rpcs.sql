-- E03: helper-gated writes and RPCs still work for the right caller and refuse the wrong one.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user('u_sa', $q$insert into public.internal_roles (user_id, role_id) values ('{u_x}', '{arole}')$q$);
  PERFORM pg_temp.check('e03 super admin grants an internal role', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_i', $q$insert into public.internal_roles (user_id, role_id) values ('{u_x}', '{arole}')$q$);
  PERFORM pg_temp.check('e03 non-super staff cannot grant an internal role', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$insert into public.internal_roles (user_id, role_id) values ('{u_x}', '{arole}')$q$);
  PERFORM pg_temp.check('e03 anon cannot grant an internal role', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_i', $q$insert into public.pending_internal_invitations (email, role_id, invited_by) values ('p-3946@example.test', '{arole}', '{u_i}')$q$);
  PERFORM pg_temp.check('e03 staff creates internal invitation', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_g', $q$insert into public.pending_internal_invitations (email, role_id, invited_by) values ('q-3946@example.test', '{arole}', '{u_g}')$q$);
  PERFORM pg_temp.check('e03 agent cannot create internal invitation', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_a', $q$update public.organization_members set role = 'agent' where id = '{m_g}'$q$);
  PERFORM pg_temp.check('e03 org admin edits a member (is_org_admin policy + invite trigger)', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_g', $q$update public.organization_members set role = 'admin' where id = '{m_g2}'$q$);
  PERFORM pg_temp.check('e03 agent cannot edit a member', m = 'OK rows=0' OR m LIKE 'ERR 42501%', m);
  -- RPC smoke, three argument patterns: auth.uid() direct, v_admin_id := auth.uid(), and has_permission(auth.uid())
  m := pg_temp.as_user('u_i', $q$select (select count(*) >= 0 from public.admin_search_users('3917', 5))$q$);
  PERFORM pg_temp.check('e03 staff admin_search_users works', m = 'OK true', m);
  m := pg_temp.as_user('u_g', $q$select (select count(*) from public.admin_search_users('3917', 5))$q$);
  PERFORM pg_temp.check('e03 agent admin_search_users refused', m LIKE 'ERR % Unauthorized%', m);
  m := pg_temp.as_user('u_i', $q$select public.admin_get_org_plan('{org1}')->>'error'$q$);
  PERFORM pg_temp.check('e03 staff admin_get_org_plan passes permission gate', m NOT IN ('OK insufficient_permissions','OK not_authenticated') AND m LIKE 'OK %', m);
  m := pg_temp.as_user('u_sa', $q$select public.admin_get_org_plan('{org1}')->>'error'$q$);
  PERFORM pg_temp.check('e03 staff without plans.view refused by admin_get_org_plan', m = 'OK insufficient_permissions', m);
  m := pg_temp.as_user('u_i', $q$select jsonb_typeof(public.admin_list_user_devices('{u_g}'))$q$);
  PERFORM pg_temp.check('e03 staff admin_list_user_devices works', m LIKE 'OK %' AND m NOT LIKE 'ERR%', m);
  m := pg_temp.as_user('u_g', $q$select jsonb_typeof(public.admin_list_user_devices('{u_g}'))$q$);
  PERFORM pg_temp.check('e03 agent admin_list_user_devices refused', m LIKE 'ERR % Unauthorized%', m);
END $$;
