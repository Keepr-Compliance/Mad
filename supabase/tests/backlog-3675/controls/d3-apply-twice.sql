-- harness: apply-twice
DO $$ BEGIN
  PERFORM pg_temp.check('d3 one feature row after applying twice',
    (SELECT count(*) FROM public.feature_definitions WHERE key = 'unlimited_transactions') = 1);
  PERFORM pg_temp.check('d3 one plan row per plan after applying twice',
    (SELECT count(*) FROM public.plan_features pf JOIN public.feature_definitions fd ON fd.id = pf.feature_id
      WHERE fd.key = 'unlimited_transactions') = (SELECT count(*) FROM public.plans));
END $$;
