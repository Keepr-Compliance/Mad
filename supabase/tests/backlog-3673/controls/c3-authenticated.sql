-- As `authenticated` on the owner's own row (request.jwt.claims sub = fixture id).
-- (b) and (c) compare the STORED value: with the trigger, the UPDATE succeeds
-- and the old value is kept, so a row count would say nothing.
DO $$ DECLARE m text; BEGIN
  -- (a) null -> ts accepted, through the app's own statement (with RETURNING, as .select("id") sends it)
  m := pg_temp.as_user(pg_temp.id('u_fresh'),
    'update public.users set onboarding_completed_at = now() where id = ''{u_fresh}'' and onboarding_completed_at is null returning id', true);
  PERFORM pg_temp.check('c3a authenticated: null -> ts accepted, 1 row returned', m = 'OK rows=1', m);
  PERFORM pg_temp.check('c3a authenticated: value now set', pg_temp.rec('u_fresh') IS NOT NULL);

  -- (b) ts -> null unchanged
  m := pg_temp.as_user(pg_temp.id('u_set'),
    'update public.users set onboarding_completed_at = null where id = ''{u_set}''', true);
  PERFORM pg_temp.check('c3b authenticated: ts -> null leaves the value unchanged',
    pg_temp.rec('u_set') = '2026-09-20T10:00:00Z'::timestamptz,
    m || ' value=' || coalesce(pg_temp.rec('u_set')::text, '<null>'));

  -- (c) ts -> other ts unchanged
  m := pg_temp.as_user(pg_temp.id('u_set'),
    'update public.users set onboarding_completed_at = ''2001-01-01T00:00:00Z'' where id = ''{u_set}''', true);
  PERFORM pg_temp.check('c3c authenticated: ts -> other ts leaves the value unchanged',
    pg_temp.rec('u_set') = '2026-09-20T10:00:00Z'::timestamptz,
    m || ' value=' || coalesce(pg_temp.rec('u_set')::text, '<null>'));

  -- (d) the app's own statement on a set row updates 0 rows (u_set; u_pending set by the backfill)
  m := pg_temp.as_user(pg_temp.id('u_set'),
    'update public.users set onboarding_completed_at = now() where id = ''{u_set}'' and onboarding_completed_at is null returning id');
  PERFORM pg_temp.check('c3d authenticated: app statement on a set row (u_set) updates 0 rows', m = 'OK rows=0', m);
  m := pg_temp.as_user(pg_temp.id('u_pending'),
    'update public.users set onboarding_completed_at = now() where id = ''{u_pending}'' and onboarding_completed_at is null returning id');
  PERFORM pg_temp.check('c3d authenticated: app statement on a backfilled row (u_pending) updates 0 rows', m = 'OK rows=0', m);

  -- the owner policy still scopes the write: another user's row is not reachable
  m := pg_temp.as_user(pg_temp.id('u_fresh'),
    'update public.users set onboarding_completed_at = null where id = ''{u_pending}''');
  PERFORM pg_temp.check('c3 authenticated: another user''s row is not writable (0 rows)', m = 'OK rows=0', m);

  -- the function cannot be called directly by authenticated
  m := pg_temp.as_user(pg_temp.id('u_fresh'), 'select public.users_keep_onboarding_completed()');
  PERFORM pg_temp.check('c3 authenticated: direct call of the trigger function refused', m LIKE 'ERR %', m);
END $$;
