-- harness: rollback
-- rollback-3675.sql leaves no trace, including grants on organizations.
DO $$ BEGIN
  PERFORM pg_temp.check('d8 after rollback: no feature row',
    (SELECT count(*) FROM public.feature_definitions WHERE key = 'unlimited_transactions') = 0);
  PERFORM pg_temp.check('d8 after rollback: no override carries the key',
    (SELECT count(*) FROM public.organization_plans WHERE feature_overrides ? 'unlimited_transactions') = 0);
END $$;
