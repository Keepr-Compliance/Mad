-- Rollback of 20261013020819_backlog_3849_billing_drain.sql.
-- 1. Unschedules every cron job whose command calls billing_drain_invoke, so no
--    job is left calling a function that no longer exists.
-- 2. Drops billing_drain_invoke(text) and billing_drain_secret().
-- 3. Deletes the drain's vault rows: the secret and both target URLs.
-- Touches no table and not billing_outbox_claim (BACKLOG-3845). After this the
-- drain route answers 401 (the secret lookup fails).

DO $rb$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%billing_drain_invoke%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END
$rb$;

DROP FUNCTION IF EXISTS public.billing_drain_invoke(text);
DROP FUNCTION IF EXISTS public.billing_drain_secret();

DELETE FROM vault.secrets
WHERE name IN ('billing_drain_secret', 'billing_drain_url_live', 'billing_drain_url_test');
