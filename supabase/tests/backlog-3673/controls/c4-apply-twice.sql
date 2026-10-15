-- harness: apply-twice
-- The second apply raises nothing and leaves one trigger, one function and the same values.
DO $$ BEGIN
  PERFORM pg_temp.check('c4 apply twice: one trigger, enabled', pg_temp.trg_state() = 'O', pg_temp.trg_state());
  PERFORM pg_temp.check('c4 apply twice: one function',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'users_keep_onboarding_completed') = 1);
  PERFORM pg_temp.check('c4 apply twice: backfilled values unchanged (= email answer)',
    NOT EXISTS (SELECT 1 FROM t3673_pre p JOIN public.users u USING (id)
                 WHERE u.onboarding_completed_at IS DISTINCT FROM u.email_onboarding_completed_at));
  PERFORM pg_temp.check('c4 apply twice: u_set and u_fresh unchanged',
    pg_temp.rec('u_set') = '2026-09-20T10:00:00Z'::timestamptz AND pg_temp.rec('u_fresh') IS NULL);
END $$;
