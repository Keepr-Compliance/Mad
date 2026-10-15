-- C03: review writes (transaction_submissions_update_public reviewer branch,
-- users_can_create_comments) are refused for a suspended/expired admin and
-- allowed for the active twin.
DO $$ DECLARE st text; actor text; m text; deny boolean; BEGIN
  FOREACH st IN ARRAY ARRAY['suspended', 'expired', 'active'] LOOP
    actor := CASE WHEN st = 'active' THEN 'u_a' ELSE 'u_s' END;
    IF st <> 'active' THEN PERFORM pg_temp.set_status('m_s', st); END IF;
    deny := st <> 'active';
    m := pg_temp.as_user(actor, $q$update public.transaction_submissions set status='approved', reviewed_by=auth.uid(), reviewed_at=now() where id='{sub}'$q$);
    PERFORM pg_temp.check('c03 '||st||' admin: approve '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user(actor, $q$update public.transaction_submissions set status='under_review' where id='{sub}'$q$);
    PERFORM pg_temp.check('c03 '||st||' admin: mark under review '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user(actor, $q$insert into public.submission_comments(submission_id,user_id,content) values ('{sub}',auth.uid(),'c03')$q$);
    PERFORM pg_temp.check('c03 '||st||' admin: comment '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
  END LOOP;
  PERFORM pg_temp.check('c03 submission unchanged',
    (SELECT status FROM public.transaction_submissions WHERE id = pg_temp.id('sub')) = 'submitted');
END $$;
