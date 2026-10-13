-- C07: a suspended/expired agent's desktop upload is refused at the storage
-- upload (stage 2), before any transaction_submissions row exists, and the
-- submission row insert is refused too. The active agent can do both. u_gs is
-- active in org2 (fixtures), so status must come from the org1 membership. An
-- '{org1}/...' upload into a bucket with no policy of its own is refused even for
-- the active agent (the policy is scoped to bucket 'submission-attachments').
DO $$ DECLARE st text; actor text; m text; deny boolean; BEGIN
  FOREACH st IN ARRAY ARRAY['suspended', 'expired', 'active'] LOOP
    actor := CASE WHEN st = 'active' THEN 'u_g' ELSE 'u_gs' END;
    IF st <> 'active' THEN PERFORM pg_temp.set_status('m_gs', st); END IF;
    deny := st <> 'active';
    m := pg_temp.as_user(actor, $q$insert into storage.objects(bucket_id,name,owner) values ('submission-attachments','{org1}/{new_sub}/upload.pdf',auth.uid())$q$);
    PERFORM pg_temp.check('c07 '||st||' agent: storage upload '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user(actor, $q$insert into public.transaction_submissions(id,organization_id,submitted_by,local_transaction_id,property_address,status) values ('{new_sub}','{org1}',auth.uid(),'lt-c07','2 Fixture St','uploading')$q$);
    PERFORM pg_temp.check('c07 '||st||' agent: submission row insert '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
  END LOOP;
  m := pg_temp.as_user('u_gs', $q$insert into storage.objects(bucket_id,name,owner) values ('submission-attachments','{org2}/{new_sub}/upload.pdf',auth.uid())$q$);
  PERFORM pg_temp.check('c07 agent suspended in org1, active in org2: org2 upload allowed', m = 'OK rows=1', m);
  PERFORM pg_temp.check('c07 second bucket has no storage.objects policy of its own',
    NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                 AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%b3917-other%'));
  m := pg_temp.as_user('u_g', $q$insert into storage.objects(bucket_id,name,owner) values ('b3917-other','{org1}/{new_sub}/upload.pdf',auth.uid())$q$);
  PERFORM pg_temp.check('c07 active agent: org1 path into a second bucket refused', pg_temp.refused(m), m);
  PERFORM pg_temp.check('c07 no submission row and no file written',
    NOT EXISTS (SELECT 1 FROM public.transaction_submissions WHERE id = pg_temp.id('new_sub'))
    AND NOT EXISTS (SELECT 1 FROM storage.objects WHERE name LIKE '%' || pg_temp.id('new_sub')::text || '%'));
END $$;
