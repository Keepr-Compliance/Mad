-- C13: review RPC. set_submission_checklist_reviewer_check gates through
-- can_review_submission: a suspended/expired admin is refused (42501), the active
-- twin ticks the item. Each call is rolled back.
DO $$ DECLARE st text; actor text; m text; deny boolean; BEGIN
  FOREACH st IN ARRAY ARRAY['suspended', 'expired', 'active'] LOOP
    actor := CASE WHEN st = 'active' THEN 'u_a' ELSE 'u_s' END;
    IF st <> 'active' THEN PERFORM pg_temp.set_status('m_s', st); END IF;
    deny := st <> 'active';
    m := pg_temp.as_user(actor, $q$select public.set_submission_checklist_reviewer_check('{scl_item}', true)$q$);
    PERFORM pg_temp.check('c13 '||st||' admin: reviewer check '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN m LIKE 'ERR 42501 %' ELSE m LIKE 'OK %"changed": true%' END, m);
  END LOOP;
  PERFORM pg_temp.check('c13 item unchanged',
    (SELECT reviewer_checked FROM public.submission_checklist_items WHERE id = pg_temp.id('scl_item')) = false);
END $$;
