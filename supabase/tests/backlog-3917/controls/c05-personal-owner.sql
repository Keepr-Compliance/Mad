-- C05: an active personal owner keeps their own organization, own templates and
-- template writes (get_user_org_ids, can_create_own_checklist_templates,
-- can_edit_checklist_templates); the organization row stays visible.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user('u_p', $q$select (select count(*) from public.checklist_templates where id='{tpl_own_p}')$q$);
  PERFORM pg_temp.check('c05 personal owner reads own template', m = 'OK 1', m);
  m := pg_temp.as_user('u_p', $q$select (select count(*) from public.get_user_org_ids(auth.uid()))$q$);
  PERFORM pg_temp.check('c05 personal owner org ids = 1', m = 'OK 1', m);
  m := pg_temp.as_user('u_p', $q$select (select count(*) from public.organization_members where organization_id='{org_p}')$q$);
  PERFORM pg_temp.check('c05 personal owner reads own membership', m = 'OK 1', m);
  m := pg_temp.as_user('u_p', $q$insert into public.checklist_templates(organization_id,name,owner_user_id,include_in_submission) values ('{org_p}','c05 own',auth.uid(),false)$q$);
  PERFORM pg_temp.check('c05 personal owner creates own template', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_p', $q$insert into public.checklist_templates(organization_id,name,owner_user_id,include_in_submission) values ('{org_p}','c05 org',null,true)$q$);
  PERFORM pg_temp.check('c05 personal owner creates organization template', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_p', $q$select (select count(*) from public.organizations where id='{org_p}' and personal_owner_user_id=auth.uid())$q$);
  PERFORM pg_temp.check('c05 personal organization row visible', m = 'OK 1', m);
  m := pg_temp.as_user('u_p', $q$select public.can_review_submission('{org_p}')$q$);
  PERFORM pg_temp.check('c05 personal owner (admin role) is a reviewer of own org', m = 'OK true', m);
END $$;
