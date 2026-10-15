-- D02 (3938 regression): every policy/trigger caller of the two helpers still works,
-- and a signed-out read still returns nothing without an error.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.organization_members)$q$);
  PERFORM pg_temp.check('d02 anon organization_members read: 0 rows, no error', m = 'OK 0', m);
  m := pg_temp.as_role('anon', NULL, $q$update public.organization_members set role = 'agent' where id = '{m_g}'$q$);
  PERFORM pg_temp.check('d02 anon member write refused', pg_temp.refused(m), m);
  m := pg_temp.as_user('u_a', $q$select (select count(*) from public.organization_members where organization_id = '{org1}')$q$);
  PERFORM pg_temp.check('d02 admin reads org1 roster (7)', m = 'OK 7', m);
  m := pg_temp.as_user('u_g', $q$select (select count(*) from public.organization_members where organization_id = '{org1}')$q$);
  PERFORM pg_temp.check('d02 active agent reads org1 roster via get_user_org_ids (7)', m = 'OK 7', m);
  m := pg_temp.as_user('u_a', $q$update public.organization_members set role = 'agent' where id = '{m_g}'$q$);
  PERFORM pg_temp.check('d02 admin edits a member (policy + trigger is_org_admin)', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_g', $q$update public.organization_members set role = 'admin' where id = '{m_g}'$q$);
  PERFORM pg_temp.check('d02 agent cannot edit', pg_temp.refused(m), m);
  m := pg_temp.as_user('u_g', $q$select (select count(*) from public.checklist_templates where id = '{tpl_org}')$q$);
  PERFORM pg_temp.check('d02 agent reads org template', m = 'OK 1', m);
  m := pg_temp.as_user('u_p', $q$select (select count(*) from public.checklist_templates where id = '{tpl_own_p}')$q$);
  PERFORM pg_temp.check('d02 personal owner reads own template', m = 'OK 1', m);
END $$;
