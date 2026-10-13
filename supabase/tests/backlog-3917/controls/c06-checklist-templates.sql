-- C06: template writes. A suspended/expired admin cannot write organization
-- templates (can_edit_checklist_templates); a suspended agent cannot create an
-- own template (can_create_own_checklist_templates). Active twins can.
DO $$ DECLARE st text; m text; deny boolean; BEGIN
  FOREACH st IN ARRAY ARRAY['suspended', 'expired', 'active'] LOOP
    deny := st <> 'active';
    PERFORM pg_temp.set_status('m_s', st); PERFORM pg_temp.set_status('m_gs', st);
    m := pg_temp.as_user('u_s', $q$insert into public.checklist_templates(organization_id,name,owner_user_id,include_in_submission) values ('{org1}','c06 org',null,true)$q$);
    PERFORM pg_temp.check('c06 '||st||' admin: create organization template '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user('u_s', $q$select public.can_edit_checklist_templates('{org1}')$q$);
    PERFORM pg_temp.check('c06 '||st||' admin: can_edit_checklist_templates = '||(NOT deny)::text, m = 'OK '||(NOT deny)::text, m);
    m := pg_temp.as_user('u_gs', $q$insert into public.checklist_templates(organization_id,name,owner_user_id,include_in_submission) values ('{org1}','c06 own',auth.uid(),false)$q$);
    PERFORM pg_temp.check('c06 '||st||' agent: create own template '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user('u_gs', $q$select public.can_create_own_checklist_templates('{org1}')$q$);
    PERFORM pg_temp.check('c06 '||st||' agent: can_create_own_checklist_templates = '||(NOT deny)::text, m = 'OK '||(NOT deny)::text, m);
  END LOOP;
END $$;
