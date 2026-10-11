-- harness: baseline
-- Before the migration: no write-once trigger, no function; the pre-check
-- selects u_pending only among the fixtures.
DO $$ BEGIN
  PERFORM pg_temp.check('c1 baseline: trigger absent', pg_temp.trg_state() = '<absent>', pg_temp.trg_state());
  PERFORM pg_temp.check('c1 baseline: function absent',
    to_regprocedure('public.users_keep_onboarding_completed()') IS NULL);
  PERFORM pg_temp.check('c1 baseline: pre-check selects u_pending, not u_fresh / u_set',
    pg_temp.id('u_pending') IN (SELECT id FROM t3673_pre)
    AND pg_temp.id('u_fresh') NOT IN (SELECT id FROM t3673_pre)
    AND pg_temp.id('u_set') NOT IN (SELECT id FROM t3673_pre));
  PERFORM pg_temp.check('c1 baseline: without the trigger a set record CAN be cleared (the guard is the migration''s)',
    pg_temp.as_user(pg_temp.id('u_set'),
      'update public.users set onboarding_completed_at = null where id = ''{u_set}''', true) = 'OK rows=1'
    AND pg_temp.rec('u_set') IS NULL);
END $$;
