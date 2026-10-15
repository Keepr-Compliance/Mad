-- harness: rollback
-- harness: reapply
-- After the data rollback the migration applies cleanly again and backfills the same set.
DO $$ BEGIN
  PERFORM pg_temp.check('c5b rollback + reapply: trigger present and enabled', pg_temp.trg_state() = 'O', pg_temp.trg_state());
  PERFORM pg_temp.check('c5b rollback + reapply: listed rows backfilled again (= email answer)',
    NOT EXISTS (SELECT 1 FROM t3673_pre p JOIN public.users u USING (id)
                 WHERE u.onboarding_completed_at IS DISTINCT FROM u.email_onboarding_completed_at));
  PERFORM pg_temp.check('c5b rollback + reapply: unlisted rows as before',
    NOT EXISTS (SELECT 1 FROM public.users u JOIN t3673_before b USING (id)
                 WHERE u.id NOT IN (SELECT id FROM t3673_pre)
                   AND u.onboarding_completed_at IS DISTINCT FROM b.rec));
END $$;
