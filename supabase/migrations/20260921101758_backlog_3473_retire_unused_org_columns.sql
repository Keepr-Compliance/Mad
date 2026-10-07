-- ============================================================================
-- Migration: drop three unused organizations columns
-- Backlog: BACKLOG-3473
--
-- NOT APPLIED TO PRODUCTION BY THIS PR. The apply is a separate step taken on
-- the founder's word, after 20260921101756_backlog_3473_feature_reads_honour_min_tier.sql
-- and 20260921101757_backlog_3473_transaction_checklists.sql. It is the one
-- irreversible file of the three and may be held back on its own.
--
-- Drops organizations.require_dual_approval, organizations.auto_reject_incomplete
-- and organizations.minimum_attachment_types (added by
-- 20260122_b2b_broker_portal.sql). No function, view, policy or app code reads
-- them.
--
-- Guard: before dropping anything, the file counts organizations holding a
-- non-default value in any of the three (require_dual_approval true,
-- auto_reject_incomplete true, minimum_attachment_types not null). If any
-- exist it raises with the message prefix `retire_unused_org_columns:` and
-- drops nothing. Each count is taken only for a column that still exists
-- (information_schema + dynamic SQL), so a second run after the drop is a
-- no-op.
--
-- No BEGIN/COMMIT: the caller supplies the transaction.
-- ============================================================================

DO $guard$
DECLARE
  v_col   text;
  v_where text;
  v_count bigint;
BEGIN
  FOR v_col, v_where IN
    SELECT c.col, c.cond
      FROM (VALUES
        ('require_dual_approval',    'require_dual_approval IS TRUE'),
        ('auto_reject_incomplete',   'auto_reject_incomplete IS TRUE'),
        ('minimum_attachment_types', 'minimum_attachment_types IS NOT NULL')
      ) AS c(col, cond)
  LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'organizations'
         AND column_name = v_col
    ) THEN
      EXECUTE format('SELECT count(*) FROM public.organizations WHERE %s', v_where) INTO v_count;
      IF v_count > 0 THEN
        RAISE EXCEPTION 'retire_unused_org_columns: % organization(s) hold a non-default %; nothing dropped',
          v_count, v_col;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

ALTER TABLE public.organizations DROP COLUMN IF EXISTS require_dual_approval;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS auto_reject_incomplete;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS minimum_attachment_types;
