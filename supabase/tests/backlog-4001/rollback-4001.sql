-- BACKLOG-4001 rollback: restore email_delivery_log's two check constraints to the
-- definitions before 20261020120000_backlog_4001_email_log_type_status_checks.sql
-- (read from prod and keepr-test with pg_get_constraintdef on 2026-10-19).
--
-- Deletes nothing. If any row already uses 'ticket_resolved', 'receipt' or 'queued' the
-- ADD CONSTRAINT fails with 23514 and nothing changes; decide what to do with those rows
-- first. Run in one transaction (under execute_sql one call is one transaction).
-- The last statement deletes the 20261020120000 ledger row (only if the ledger exists).

ALTER TABLE public.email_delivery_log
  DROP CONSTRAINT IF EXISTS email_delivery_log_email_type_check,
  DROP CONSTRAINT IF EXISTS email_delivery_log_status_check,
  ADD CONSTRAINT email_delivery_log_email_type_check CHECK (email_type IN (
    'invite',
    'ticket_notification',
    'ticket_confirmation',
    'ticket_reply',
    'other'
  )),
  ADD CONSTRAINT email_delivery_log_status_check CHECK (status IN (
    'attempted',
    'sent',
    'failed',
    'skipped'
  ));

DO $ledger$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261020120000';
  END IF;
END $ledger$;
