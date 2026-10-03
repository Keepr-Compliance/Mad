-- harness: rollback
-- The data rollback (ROLLBACK_FILE, keyed on the pre-check list) nulls exactly
-- the listed rows, leaves every other row as it was, and re-enables the trigger,
-- which then still enforces write-once.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('c5a rollback: every listed row is null again',
    NOT EXISTS (SELECT 1 FROM t3673_pre p JOIN public.users u USING (id) WHERE u.onboarding_completed_at IS NOT NULL));
  PERFORM pg_temp.check('c5a rollback: every unlisted row as before the migration',
    NOT EXISTS (SELECT 1 FROM public.users u JOIN t3673_before b USING (id)
                 WHERE u.id NOT IN (SELECT id FROM t3673_pre)
                   AND u.onboarding_completed_at IS DISTINCT FROM b.rec));
  PERFORM pg_temp.check('c5a rollback: write-once trigger re-enabled (O)', pg_temp.trg_state() = 'O', pg_temp.trg_state());
  PERFORM pg_temp.check('c5a rollback: updated_at trigger still enabled',
    (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'update_users_updated_at') = 'O');
  m := pg_temp.as_user(pg_temp.id('u_set'),
    'update public.users set onboarding_completed_at = null where id = ''{u_set}''', true);
  PERFORM pg_temp.check('c5a rollback: write-once enforced again after re-enable',
    pg_temp.rec('u_set') = '2026-09-20T10:00:00Z'::timestamptz,
    m || ' value=' || coalesce(pg_temp.rec('u_set')::text, '<null>'));
END $$;
