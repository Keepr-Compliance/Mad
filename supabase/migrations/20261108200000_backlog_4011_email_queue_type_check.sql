-- BACKLOG-4011: email_delivery_queue.email_type gets the same check as
-- email_delivery_log.email_type.
--
-- The only writer of email_delivery_queue is enqueueEmail (broker-portal/lib/email/queue.ts),
-- whose input type is EMAIL_TYPES in broker-portal/lib/email/types.ts. The list below is those
-- 7 values, identical to email_delivery_log_email_type_check
-- (20261020120000_backlog_4001_email_log_type_status_checks.sql).
-- broker-portal/__tests__/migrations/email-queue-check-4011.test.ts compares the lists.
--
-- Pre-check: raises (nothing changed) if any existing row has a type outside the list.
-- Adds the constraint only if it is not there yet, so re-running this file is a no-op.
-- ADD CONSTRAINT ... CHECK scans the existing rows under the ALTER's lock; no table rewrite.
-- No function or table is created. Touches only email_delivery_queue.
-- Rollback: supabase/tests/backlog-4011/rollback-4011.sql.

SET lock_timeout = '5s';

DO $check$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.email_delivery_queue
   WHERE email_type NOT IN (
     'invite', 'ticket_notification', 'ticket_confirmation', 'ticket_reply',
     'ticket_resolved', 'receipt', 'other'
   );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'BACKLOG-4011: % email_delivery_queue row(s) have an email_type outside the allowed list', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.email_delivery_queue'::regclass
       AND conname = 'email_delivery_queue_email_type_check'
  ) THEN
    ALTER TABLE public.email_delivery_queue
      ADD CONSTRAINT email_delivery_queue_email_type_check CHECK (email_type IN (
        'invite',
        'ticket_notification',
        'ticket_confirmation',
        'ticket_reply',
        'ticket_resolved',
        'receipt',
        'other'
      ));
  END IF;
END
$check$;
