-- BACKLOG-4001: email_delivery_log's two check constraints allow every value the
-- broker-portal email sender writes.
--
-- email_type: adds 'ticket_resolved' and 'receipt'. The list now equals EMAIL_TYPES in
--   broker-portal/lib/email/types.ts.
-- status: adds 'queued' (written when a send is moved to email_delivery_queue). The list
--   now equals EMAIL_LOG_STATUSES in that file plus the legacy 'attempted', which nothing
--   writes and which is kept so no existing value is narrowed away.
-- broker-portal/__tests__/migrations/email-log-checks-4001.test.ts compares both lists.
--
-- Widening only. One ALTER TABLE: both checks are dropped and re-added in the same
-- statement. ADD CONSTRAINT ... CHECK scans the existing rows under the ALTER's lock;
-- no table rewrite. Touches only email_delivery_log. Re-running this file is a no-op
-- (same definitions).
-- Rollback: supabase/tests/backlog-4001/rollback-4001.sql.

ALTER TABLE public.email_delivery_log
  DROP CONSTRAINT IF EXISTS email_delivery_log_email_type_check,
  DROP CONSTRAINT IF EXISTS email_delivery_log_status_check,
  ADD CONSTRAINT email_delivery_log_email_type_check CHECK (email_type IN (
    'invite',
    'ticket_notification',
    'ticket_confirmation',
    'ticket_reply',
    'ticket_resolved',
    'receipt',
    'other'
  )),
  ADD CONSTRAINT email_delivery_log_status_check CHECK (status IN (
    'attempted',
    'sent',
    'failed',
    'skipped',
    'queued'
  ));
