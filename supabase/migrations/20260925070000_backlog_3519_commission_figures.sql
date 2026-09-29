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
-- ROLLBACK:
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
--   (Section 5, when it exists, adds its own trigger + function to drop.)
--
-- Tested by supabase/tests/backlog-3519/ (acceptance case + CHECK boundary
-- sweep) against a disposable local Postgres; not in CI (CI has no database).

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
  -- Computed and rounded to cents ONCE by the writer (BACKLOG-3520), stored
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
  'BACKLOG-3519: sale_price x commission_actual_rate, rounded to cents once by the writer. Stored, never derived on read.';
COMMENT ON COLUMN public.transaction_submissions.commission_adjustment_reason IS
  'BACKLOG-3519: optional free text. Recordable when actual differs from offered, in either direction; empty never blocks.';

-- ============================================================================
-- 4. (reserved)
-- ============================================================================

-- ============================================================================
-- 5. >>> COMMISSION LOCK -- INTENTIONALLY NOT WRITTEN IN THIS COMMIT <<<
-- ============================================================================
-- A BEFORE UPDATE OF (commission_offered_rate, commission_actual_rate,
-- commission_gross_amount, commission_adjustment_reason) guard belongs HERE,
-- in THIS migration, so the columns never exist unguarded. Its ABSENCE FROM
-- THIS COMMIT IS NOT AN OVERSIGHT: it is access-control, and its build and
-- review are a separate Opus step (coordinator instruction, 2026-09-29).
--
-- Specification (SR ruling pm_comments 768e6b93 on BACKLOG-3610, R1):
--   * SECURITY INVOKER (it reads no table; INVOKER keeps current_user
--     meaningful).
--   * Raise 42501 UNLESS
--       auth.role() = 'service_role'
--       OR (auth.role() IS NULL AND current_user NOT IN ('authenticated','anon')).
--     Allowlist form: fails closed, including on any unknown role value.
--   * Fires ONLY when one of the four columns is named in the UPDATE's SET
--     list, so the submit pipeline's own finalize -- which updates `status`
--     alone (submissionService.ts, .update({ status: finalStatus })) -- must
--     NOT trip it. That is a required control.
--   * The closing date stays editable. Do NOT lock it.
--   * INSERT stays unlocked: the submit writes the figures with the INSERT.
-- DO NOT APPLY THIS FILE TO PRODUCTION BEFORE SECTION 5 EXISTS: without it a
-- client can UPDATE a submitted record's figures.

COMMIT;
