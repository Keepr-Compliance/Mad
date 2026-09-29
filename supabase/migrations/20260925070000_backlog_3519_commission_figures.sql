-- Migration: commission figures on transaction_submissions (BACKLOG-3519, M2)
--
-- NOT APPLIED TO ANY ENVIRONMENT BY THIS PR. The apply is a separate step
-- taken on the founder's word.
--
-- FIGURES ONLY (founder decision, pm_comments 4d2e15df on BACKLOG-3519). The
-- split snapshot this file used to carry (five split_* columns, an FK into
-- agent_split_agreements, and the resolve-at-submit RPC) is REMOVED. This
-- file therefore depends on NOTHING unapplied: its only referenced object is
-- public.transaction_submissions. It does not need BACKLOG-3503 and may be
-- applied before, after, or without it. The split returns with BACKLOG-3610.
--
-- No charge (franchise/office/E&O/marketing) and no computed brokerage/agent
-- dollar amount is stored here -- that is BACKLOG-3537, waiting on
-- BACKLOG-3534. This migration stores what the agent enters at close.
--
-- WHY THE APPLY MATTERS FOR THE DESKTOP APP. Once BACKLOG-3520's capture
-- screen writes figures, the submit INSERT carries these four keys. Against
-- a database WITHOUT these columns PostgREST answers PGRST204 (unknown
-- column) and that submission fails. The desktop deliberately does not strip
-- the keys and retry: that would submit a record that silently lacks what the
-- agent typed. Apply this file before anyone submits a transaction that has
-- commission figures.
--
-- RATE PRECISION: numeric(6,3), not numeric(5,2). A commission rate can
-- legitimately carry three decimals in some MLS/market conventions (2.375%),
-- and numeric(5,2) would silently TRUNCATE the third digit. Rates are stored
-- as PERCENTAGES (2.50, not 0.025).
--
-- NO CHECK TIES commission_adjustment_reason TO A RATE MISMATCH. "Recordable
-- when actual differs from offered, in either direction" is UI guidance for
-- BACKLOG-3520, not a data-integrity rule. Only a length bound is enforced.
--
-- ROLLBACK (the trigger first: it names the columns in its OF list):
--   DROP TRIGGER IF EXISTS commission_figures_locked ON public.transaction_submissions;
--   DROP FUNCTION IF EXISTS public.guard_commission_figures_locked();
--   ALTER TABLE public.transaction_submissions
--     DROP CONSTRAINT IF EXISTS transaction_submissions_offered_rate_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_actual_rate_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_gross_amount_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_adjustment_reason_check;
--   ALTER TABLE public.transaction_submissions
--     DROP COLUMN IF EXISTS commission_offered_rate,
--     DROP COLUMN IF EXISTS commission_actual_rate,
--     DROP COLUMN IF EXISTS commission_gross_amount,
--     DROP COLUMN IF EXISTS commission_adjustment_reason;
--
-- Tested by supabase/tests/backlog-3519/: probes.sql (CHECK boundary sweep,
-- disposable local Postgres) and lock-probes.sql (section 5, run inside a
-- rolled-back transaction against a Supabase-shaped Postgres). Not in CI (CI
-- has no database).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ============================================================================
-- 1. What the agent enters (commission_*)
-- ============================================================================
ALTER TABLE public.transaction_submissions
  -- Percentage, e.g. 2.50 -- NOT a fraction (0.025). The founder's own worked
  -- example: 100,000 x 10% -> 10,000.
  ADD COLUMN IF NOT EXISTS commission_offered_rate      numeric(6,3),
  ADD COLUMN IF NOT EXISTS commission_actual_rate       numeric(6,3),
  -- Computed and rounded to WHOLE DOLLARS (half up) ONCE by the writer
  -- (BACKLOG-3520): Math.round(sale x rate%), so 412,500 x 2.5% = 10,313. Stored
  -- rather than derived on read -- so a later correction to sale_price
  -- cannot silently change a submission's historical gross commission.
  ADD COLUMN IF NOT EXISTS commission_gross_amount      numeric(12,2),
  ADD COLUMN IF NOT EXISTS commission_adjustment_reason text;

-- ============================================================================
-- 2. Domain checks -- nullable throughout; a NULL commission is not an error,
--    it is "not yet entered" (founder: never block).
-- ============================================================================
ALTER TABLE public.transaction_submissions
  ADD CONSTRAINT transaction_submissions_offered_rate_check
    CHECK (commission_offered_rate IS NULL
           OR (commission_offered_rate >= 0 AND commission_offered_rate <= 100)),
  ADD CONSTRAINT transaction_submissions_actual_rate_check
    CHECK (commission_actual_rate IS NULL
           OR (commission_actual_rate >= 0 AND commission_actual_rate <= 100)),
  ADD CONSTRAINT transaction_submissions_gross_amount_check
    CHECK (commission_gross_amount IS NULL OR commission_gross_amount >= 0),
  ADD CONSTRAINT transaction_submissions_adjustment_reason_check
    CHECK (commission_adjustment_reason IS NULL
           OR char_length(btrim(commission_adjustment_reason)) BETWEEN 1 AND 2000);

-- ============================================================================
-- 3. Column documentation
-- ============================================================================
COMMENT ON COLUMN public.transaction_submissions.commission_offered_rate IS
  'BACKLOG-3519: percentage (2.50, not 0.025). What the agent was offered.';
COMMENT ON COLUMN public.transaction_submissions.commission_actual_rate IS
  'BACKLOG-3519: percentage. What actually applied; may differ from offered.';
COMMENT ON COLUMN public.transaction_submissions.commission_gross_amount IS
  'BACKLOG-3519: sale_price x commission_actual_rate, rounded to whole dollars (half up) once by the writer. Stored, never derived on read.';
COMMENT ON COLUMN public.transaction_submissions.commission_adjustment_reason IS
  'BACKLOG-3519: optional free text. Recordable when actual differs from offered, in either direction; empty never blocks.';

-- ============================================================================
-- 4. (reserved)
-- ============================================================================

-- ============================================================================
-- 5. Commission lock: the figures cannot be edited after the INSERT
-- ============================================================================
-- Specification: SR ruling pm_comments 768e6b93 on BACKLOG-3610, R1; founder
-- decision pm_comments 4d2e15df on BACKLOG-3519.
--
--   * Permits a change to one of the four figures only when
--       auth.role() = 'service_role'
--       OR (auth.role() IS NULL AND current_user NOT IN ('authenticated','anon'))
--     and raises 42501 in every other case, including any unknown role value
--     (allowlist; fails closed).
--   * auth.role() is the primary discriminator. It reads the request's JWT
--     claims, so it stays 'authenticated' inside a SECURITY DEFINER function a
--     client calls, while current_user becomes that function's owner. The
--     current_user term only decides the NULL-claims case: migrations, pg_cron
--     and direct connections stay permitted; a client role with no claims
--     does not.
--   * SECURITY INVOKER: it reads no table, and INVOKER keeps current_user
--     meaningful. search_path is pinned to '' and every name is qualified.
--   * BEFORE UPDATE OF <the four columns>: fires only when one of them is in
--     the UPDATE's SET list. The submit pipeline's finalize sets `status`
--     alone and never fires it. Each column has its own IS DISTINCT FROM
--     test, so a SET that repeats the stored value is not a change.
--   * INSERT is not locked: the submit writes the figures with the INSERT.
--   * closed_at is NOT locked (founder decision 4d2e15df).
--   * A later change to the figures is its own correction record
--     (BACKLOG-3521), never an edit of this row.
--
-- Proved against a real Postgres by supabase/tests/backlog-3519/lock-probes.sql.
CREATE OR REPLACE FUNCTION public.guard_commission_figures_locked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_role text := auth.role();
BEGIN
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF v_role IS NULL AND current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.commission_offered_rate IS DISTINCT FROM OLD.commission_offered_rate THEN
    RAISE EXCEPTION 'commission_figures_locked: commission_offered_rate'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.commission_actual_rate IS DISTINCT FROM OLD.commission_actual_rate THEN
    RAISE EXCEPTION 'commission_figures_locked: commission_actual_rate'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.commission_gross_amount IS DISTINCT FROM OLD.commission_gross_amount THEN
    RAISE EXCEPTION 'commission_figures_locked: commission_gross_amount'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.commission_adjustment_reason IS DISTINCT FROM OLD.commission_adjustment_reason THEN
    RAISE EXCEPTION 'commission_figures_locked: commission_adjustment_reason'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.guard_commission_figures_locked() IS
  'BACKLOG-3519: refuses a client UPDATE of the four commission_* figures (42501). Bound by trigger commission_figures_locked.';

-- A trigger function is never called directly; firing does not need EXECUTE.
REVOKE ALL ON FUNCTION public.guard_commission_figures_locked() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS commission_figures_locked ON public.transaction_submissions;
CREATE TRIGGER commission_figures_locked
  BEFORE UPDATE OF commission_offered_rate, commission_actual_rate,
                   commission_gross_amount, commission_adjustment_reason
  ON public.transaction_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_commission_figures_locked();

COMMIT;
