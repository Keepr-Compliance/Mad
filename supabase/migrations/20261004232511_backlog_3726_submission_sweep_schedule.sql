-- ============================================
-- SUBMISSION SWEEP: hourly schedule
-- Migration: 20261005120100_backlog_3726_submission_sweep_schedule
-- Task: BACKLOG-3726
--
-- Runs public.submission_sweep_invoke() at minute 41 of every hour. Applied at
-- its own deploy step, after 20261005120000 and after the submission-sweep Edge
-- Function is deployed. Re-running replaces the job (cron.schedule upserts by name).
-- Stop: SELECT cron.unschedule('submission-sweep');
-- ============================================

SELECT cron.schedule('submission-sweep', '41 * * * *', 'SELECT public.submission_sweep_invoke()');
