-- S5: rollback-3849.sql removes both functions, the drain's vault rows and every
-- cron job calling billing_drain_invoke, leaves other jobs alone, and the
-- migration applies again afterwards (with a new secret). Rolled back with the run.
CREATE FUNCTION pg_temp.n_fns() RETURNS int LANGUAGE sql AS $f$
  SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('billing_drain_secret', 'billing_drain_invoke') $f$;
CREATE FUNCTION pg_temp.n_secrets() RETURNS int LANGUAGE sql AS $f$
  SELECT count(*)::int FROM vault.secrets WHERE name LIKE 'billing_drain%' $f$;
CREATE FUNCTION pg_temp.n_jobs() RETURNS int LANGUAGE sql AS $f$
  SELECT count(*)::int FROM cron.job WHERE command ILIKE '%billing_drain_invoke%' $f$;
CREATE FUNCTION pg_temp.n_other() RETURNS int LANGUAGE sql AS $f$
  SELECT count(*)::int FROM cron.job WHERE jobname = 't3849_other' $f$;

SELECT pg_temp.check('test cron job calling the invoker scheduled',
  cron.schedule('t3849_drain', '* * * * *', $c$SELECT public.billing_drain_invoke('test')$c$) > 0);
SELECT pg_temp.check('unrelated cron job scheduled',
  cron.schedule('t3849_other', '* * * * *', $c$SELECT 1$c$) > 0);
SELECT pg_temp.check('test URL row stored (inert loopback)',
  vault.create_secret('http://127.0.0.1:9/none', 'billing_drain_url_test') IS NOT NULL);

SELECT pg_temp.check('before rollback: fns=2 secrets=2 jobs=1',
  pg_temp.n_fns() = 2 AND pg_temp.n_secrets() = 2 AND pg_temp.n_jobs() = 1,
  format('fns=%s secrets=%s jobs=%s', pg_temp.n_fns(), pg_temp.n_secrets(), pg_temp.n_jobs()));
DO $s$ BEGIN IF to_regprocedure('public.billing_outbox_claim(text,integer)') IS NULL THEN CREATE FUNCTION public.billing_outbox_claim(text, integer) RETURNS int LANGUAGE sql AS 'SELECT 1'; END IF; END $s$;
SELECT set_config('t3849.claim_fns', (SELECT count(*)::text FROM pg_proc WHERE proname = 'billing_outbox_claim'), true) IS NULL;
-- @step rollback
SELECT pg_temp.check('rollback ran', pg_temp.step_ok('rollback'), pg_temp.step_err('rollback'));
SELECT pg_temp.check('after rollback: fns=0 secrets=0 jobs=0',
  pg_temp.n_fns() = 0 AND pg_temp.n_secrets() = 0 AND pg_temp.n_jobs() = 0,
  format('fns=%s secrets=%s jobs=%s', pg_temp.n_fns(), pg_temp.n_secrets(), pg_temp.n_jobs()));
SELECT pg_temp.check('unrelated cron job kept', pg_temp.n_other() = 1, format('other=%s', pg_temp.n_other()));
SELECT pg_temp.check('billing_outbox_claim untouched', to_regprocedure('public.billing_outbox_claim(text,integer)') IS NOT NULL);
-- @step reapply
SELECT pg_temp.check('re-apply after rollback ran', pg_temp.step_ok('reapply'), pg_temp.step_err('reapply'));
SELECT pg_temp.check('after re-apply: fns=2 secrets=1 jobs=0',
  pg_temp.n_fns() = 2 AND pg_temp.n_secrets() = 1 AND pg_temp.n_jobs() = 0,
  format('fns=%s secrets=%s jobs=%s', pg_temp.n_fns(), pg_temp.n_secrets(), pg_temp.n_jobs()));
SELECT pg_temp.check('re-apply generated a new secret value',
  current_setting('t3849.secret_md5_after1') <> (SELECT md5(decrypted_secret) FROM vault.decrypted_secrets WHERE name = 'billing_drain_secret'));
