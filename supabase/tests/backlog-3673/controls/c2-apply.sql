-- After one apply: trigger present and enabled; EXECUTE revoked from PUBLIC,
-- anon and authenticated; the backfilled set equals the pre-check set, each
-- value equals the email answer; u_fresh and u_set untouched.
DO $$
DECLARE fn regprocedure := to_regprocedure('public.users_keep_onboarding_completed()');
        changed int; pre int; extra int; missing int;
BEGIN
  PERFORM pg_temp.check('c2 apply: trigger present and enabled (O)', pg_temp.trg_state() = 'O', pg_temp.trg_state());
  PERFORM pg_temp.check('c2 apply: trigger is BEFORE UPDATE OF onboarding_completed_at, FOR EACH ROW',
    (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass
      AND tgname = 'users_keep_onboarding_completed')
      ~* 'BEFORE UPDATE OF onboarding_completed_at ON public\.users FOR EACH ROW');
  PERFORM pg_temp.check('c2 apply: EXECUTE not held by anon',
    NOT has_function_privilege('anon', fn, 'EXECUTE'));
  PERFORM pg_temp.check('c2 apply: EXECUTE not held by authenticated',
    NOT has_function_privilege('authenticated', fn, 'EXECUTE'));
  PERFORM pg_temp.check('c2 apply: EXECUTE not granted to PUBLIC',
    NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'));
  PERFORM pg_temp.check('c2 apply: function is SECURITY INVOKER with empty search_path',
    (SELECT NOT prosecdef AND proconfig = ARRAY['search_path=""'] FROM pg_proc WHERE oid = fn),
    (SELECT prosecdef::text || ' ' || coalesce(proconfig::text, '<null>') FROM pg_proc WHERE oid = fn));

  SELECT count(*) INTO pre FROM t3673_pre;
  SELECT count(*) INTO changed FROM public.users u JOIN t3673_before b USING (id)
   WHERE b.rec IS NULL AND u.onboarding_completed_at IS NOT NULL;
  SELECT count(*) INTO extra FROM public.users u JOIN t3673_before b USING (id)
   WHERE b.rec IS NULL AND u.onboarding_completed_at IS NOT NULL AND u.id NOT IN (SELECT id FROM t3673_pre);
  SELECT count(*) INTO missing FROM t3673_pre p JOIN public.users u USING (id)
   WHERE u.onboarding_completed_at IS NULL;
  PERFORM pg_temp.check('c2 apply: backfilled set = pre-check set',
    pre > 0 AND changed = pre AND extra = 0 AND missing = 0,
    format('pre=%s changed=%s extra=%s missing=%s', pre, changed, extra, missing));
  PERFORM pg_temp.check('c2 apply: every backfilled value = its email answer',
    NOT EXISTS (SELECT 1 FROM t3673_pre p JOIN public.users u USING (id)
                 WHERE u.onboarding_completed_at IS DISTINCT FROM u.email_onboarding_completed_at));
  PERFORM pg_temp.check('c2 apply: u_fresh untouched (null)', pg_temp.rec('u_fresh') IS NULL);
  PERFORM pg_temp.check('c2 apply: u_set untouched (keeps its own value, not the email answer)',
    pg_temp.rec('u_set') = '2026-09-20T10:00:00Z'::timestamptz, pg_temp.rec('u_set')::text);
  PERFORM pg_temp.check('c2 apply: no other row changed',
    NOT EXISTS (SELECT 1 FROM public.users u JOIN t3673_before b USING (id)
                 WHERE u.id NOT IN (SELECT id FROM t3673_pre)
                   AND u.onboarding_completed_at IS DISTINCT FROM b.rec));
END $$;
