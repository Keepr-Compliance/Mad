-- BACKLOG-1696: Widen pm_backlog_items.variance column from numeric(8,2) to numeric(12,2)
--
-- The 2026-05-10 backfill of actual_tokens produced variance values exceeding the old
-- numeric(8,2) bound (max +/-999,999.99). Several rows were capped at 999,999.99 to fit
-- (e.g. BACKLOG-1500: est 4K, actual 46.1M, real variance 1,152,542.83%). Widening to
-- numeric(12,2) extends max to +/-9,999,999,999.99 -- comfortable headroom for any
-- plausible variance going forward.
--
-- This migration is IDEMPOTENT -- safe to run multiple times. ALTER COLUMN TYPE is a
-- no-op if the column is already numeric(12,2), and the recompute UPDATE only touches
-- rows that are still at the old cap value.
BEGIN;

ALTER TABLE pm_backlog_items
ALTER COLUMN variance TYPE numeric(12, 2);

-- Recompute variance for rows that were previously capped at the numeric(8,2) bound.
-- Formula: (actual_tokens - est_tokens) / est_tokens * 100
UPDATE pm_backlog_items
SET variance = ROUND(((actual_tokens::numeric - est_tokens::numeric) / est_tokens::numeric) * 100, 2)
WHERE (variance = 999999.99 OR variance = -999999.99)
  AND est_tokens IS NOT NULL
  AND est_tokens <> 0
  AND actual_tokens IS NOT NULL;

COMMIT;
