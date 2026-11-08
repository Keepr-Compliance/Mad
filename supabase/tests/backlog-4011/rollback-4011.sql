-- BACKLOG-4011 rollback: remove the check added by
-- 20261108200000_backlog_4011_email_queue_type_check.sql. Before it, email_delivery_queue had
-- only email_delivery_queue_status_check (read on prod and keepr-test, 2026-11-07).
--
-- Narrows nothing, deletes no data rows. Run in one transaction (under execute_sql one call
-- is one transaction). The last statement removes the 20261108200000 ledger row (only if the
-- ledger exists).

ALTER TABLE public.email_delivery_queue
  DROP CONSTRAINT IF EXISTS email_delivery_queue_email_type_check;

DO $ledger$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108200000';
  END IF;
END $ledger$;
