-- BACKLOG-3513 PR-3h rollback (20261114100000_backlog_3513_submissions_rows_multi.sql).
-- Drops the new signature only. broker_report_submissions_rows (the single-value function) was not
-- changed by the migration and is not touched here.
-- Run as a migration-capable role.

DROP FUNCTION IF EXISTS public.broker_report_submissions_rows_multi(uuid, uuid, text[], uuid[], timestamptz, timestamptz, text, integer, integer);
