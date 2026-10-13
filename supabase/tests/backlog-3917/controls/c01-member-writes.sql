-- C01: an admin whose membership is suspended or expired cannot change, remove
-- or add members of the organization (organization_members_all_public via
-- is_org_admin); the active admin twin can. Each attempt is rolled back.
DO $$ DECLARE st text; actor text; m text; deny boolean; BEGIN
  FOREACH st IN ARRAY ARRAY['suspended', 'expired', 'pending', 'active'] LOOP
    actor := CASE WHEN st = 'active' THEN 'u_a' ELSE 'u_s' END;
    IF st <> 'active' THEN PERFORM pg_temp.set_status('m_s', st); END IF;
    deny := st <> 'active';
    m := pg_temp.as_user(actor, $q$update public.organization_members set role='admin' where id='{m_g}'$q$);
    PERFORM pg_temp.check('c01 '||st||' admin: promote agent '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user(actor, $q$update public.organization_members set role='agent' where id=CASE WHEN auth.uid()='{u_s}' THEN '{m_a}'::uuid ELSE '{m_ta}'::uuid END$q$);
    PERFORM pg_temp.check('c01 '||st||' admin: demote another admin '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user(actor, $q$delete from public.organization_members where id='{m_g}'$q$);
    PERFORM pg_temp.check('c01 '||st||' admin: remove member '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user(actor, $q$insert into public.organization_members(organization_id,role,license_status,invited_email,invited_by,provisioned_by,group_sync_enabled) values ('{org1}','agent','pending','new-3917@example.test',auth.uid(),'invite',false)$q$);
    PERFORM pg_temp.check('c01 '||st||' admin: add invite '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user(actor, $q$select public.is_org_admin(auth.uid(), '{org1}')$q$);
    PERFORM pg_temp.check('c01 '||st||' admin: is_org_admin = '||(NOT deny)::text, m = 'OK '||(NOT deny)::text, m);
  END LOOP;
  -- u_s is suspended in org1 and active admin of org2: the org2 membership grants
  -- access in org2 and nothing in org1 (checked above with it present).
  m := pg_temp.as_user('u_s', $q$select public.is_org_admin(auth.uid(), '{org2}')$q$);
  PERFORM pg_temp.check('c01 admin suspended in org1, active in org2: is_org_admin(org2) = true', m = 'OK true', m);
  -- the refused attempts left nothing behind
  PERFORM pg_temp.check('c01 rows unchanged',
    (SELECT count(*) FROM public.organization_members WHERE organization_id = pg_temp.id('org1')) = 6
    AND (SELECT role FROM public.organization_members WHERE id = pg_temp.id('m_g')) = 'agent');
END $$;
