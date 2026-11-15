-- BACKLOG-3962 "Join now" rollback: undoes 20261112114500_backlog_3962_capture_join_now.sql.
-- Drops _domain_capture_join_now and the joined_early_at column (the early-join audit time is lost).
DROP FUNCTION IF EXISTS public._domain_capture_join_now(uuid, uuid);
ALTER TABLE public.domain_capture_switches DROP COLUMN IF EXISTS joined_early_at;
