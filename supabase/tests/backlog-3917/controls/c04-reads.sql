-- C04: reads. A suspended/expired admin sees only their own membership row, no
-- submission, comment, attachment row, message row, attachment file or
-- colleague user row, and the reviewer check is false; the organization row
-- itself stays visible (organizations_select_public is unchanged). The active
-- twin reads everything. u_s also holds an active membership in org2 (fixtures),
-- so the membership and org-id checks are scoped to org1.
DO $$ DECLARE st text; actor text; deny boolean; m text;
  q text[] := ARRAY[
    'roster rows|select (select count(*) from public.organization_members where organization_id=''{org1}'')|1|6',
    'own membership row|select (select count(*) from public.organization_members where user_id=auth.uid() and organization_id=''{org1}'')|1|1',
    'submission|select (select count(*) from public.transaction_submissions where id=''{sub}'')|0|1',
    'comments (incl. internal)|select (select count(*) from public.submission_comments where submission_id=''{sub}'')|0|2',
    'attachment rows|select (select count(*) from public.submission_attachments where submission_id=''{sub}'')|0|1',
    'message rows|select (select count(*) from public.submission_messages where submission_id=''{sub}'')|0|1',
    'attachment file|select (select count(*) from storage.objects where bucket_id=''submission-attachments'' and name like ''{org1}/%'')|0|1',
    'colleague users rows|select (select count(*) from public.users where id in (''{u_a}'',''{u_g}'',''{u_ta}''))|0|3',
    'own users row|select (select count(*) from public.users where id=auth.uid())|1|1',
    'can_review_submission|select public.can_review_submission(''{org1}'')|false|true',
    'get_user_org_ids has org1|select (select count(*) from public.get_user_org_ids(auth.uid()) g(org_id) where g.org_id=''{org1}'')|0|1',
    'org template|select (select count(*) from public.checklist_templates where id=''{tpl_org}'')|0|1',
    'organization row (embed)|select (select count(*) from public.organizations where id=''{org1}'')|1|1'];
  x text; parts text[];
BEGIN
  FOREACH st IN ARRAY ARRAY['suspended', 'expired', 'active'] LOOP
    actor := CASE WHEN st = 'active' THEN 'u_a' ELSE 'u_s' END;
    IF st <> 'active' THEN PERFORM pg_temp.set_status('m_s', st); END IF;
    deny := st <> 'active';
    FOREACH x IN ARRAY q LOOP
      parts := string_to_array(x, '|');
      m := pg_temp.as_user(actor, parts[2]);
      PERFORM pg_temp.check('c04 '||st||' admin: '||parts[1]||' = '||CASE WHEN deny THEN parts[3] ELSE parts[4] END,
        m = 'OK '||CASE WHEN deny THEN parts[3] ELSE parts[4] END, m);
    END LOOP;
  END LOOP;
END $$;
