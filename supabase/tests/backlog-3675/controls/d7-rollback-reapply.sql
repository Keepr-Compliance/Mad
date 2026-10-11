-- harness: rollback
-- harness: reapply
-- rollback-3675.sql removes everything; the migration then applies cleanly again.
DO $$ BEGIN
  PERFORM pg_temp.check('d7 after rollback + reapply: one feature row',
    (SELECT count(*) FROM public.feature_definitions WHERE key = 'unlimited_transactions') = 1);
  PERFORM pg_temp.check('d7 after rollback + reapply: all plan rows off',
    (SELECT count(*) FILTER (WHERE pf.enabled = false) = (SELECT count(*) FROM public.plans)
       FROM public.plan_features pf JOIN public.feature_definitions fd ON fd.id = pf.feature_id
      WHERE fd.key = 'unlimited_transactions'));
END $$;
