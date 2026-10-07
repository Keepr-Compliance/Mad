-- harness: rollback
-- harness: full-rollback
-- Data rollback, then FULL_ROLLBACK_FILE: trigger and function gone, the
-- updated_at trigger untouched, listed rows still null.
DO $$ BEGIN
  PERFORM pg_temp.check('c5c full rollback: trigger absent', pg_temp.trg_state() = '<absent>', pg_temp.trg_state());
  PERFORM pg_temp.check('c5c full rollback: function absent',
    to_regprocedure('public.users_keep_onboarding_completed()') IS NULL);
  PERFORM pg_temp.check('c5c full rollback: updated_at trigger still enabled',
    (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'update_users_updated_at') = 'O');
  PERFORM pg_temp.check('c5c full rollback: listed rows null, unlisted as before',
    NOT EXISTS (SELECT 1 FROM t3673_pre p JOIN public.users u USING (id) WHERE u.onboarding_completed_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM public.users u JOIN t3673_before b USING (id)
                     WHERE u.id NOT IN (SELECT id FROM t3673_pre)
                       AND u.onboarding_completed_at IS DISTINCT FROM b.rec));
END $$;
