-- Migration: commission figures on transaction_submissions (BACKLOG-3519, M2)
--
-- Follows BACKLOG-3503 (M1: agent_split_agreements, the standing split table).
-- FIGURES ONLY. No charge (franchise/office/E&O/marketing) and no computed
-- brokerage/agent dollar amount is added here — that is BACKLOG-3537, waiting
-- on BACKLOG-3534 (closing-charges model), because brokerages differ on
-- whether a charge applies before or after the split (founder, pm_comments
-- 95992a3e on BACKLOG-3503). This migration stores what the agent enters
-- (commission_*) and a FROZEN SNAPSHOT of the split resolved at submission
-- time (split_*), never a computed dollar split.
--
-- APPLY-ORDERING CONSTRAINT (cannot be enforced by SQL, must be held by
-- whoever applies these -- see the durable copy on BACKLOG-3503 in
-- pm_comments, not just this comment): this migration MUST be applied
-- together with BACKLOG-3503's, in stamp order, in the same maintenance
-- window -- NOT relying on filename/version order to sequence them
-- automatically; see the correction further down this file for why that
-- reliance would be wrong.
--   - It cannot apply BEFORE 3503: split_agreement_id's FK target
--     (agent_split_agreements) does not exist until 3503 runs.
--   - It must not apply AFTER 3503 by more than the time it takes to run this
--     file: the moment 3503 is live, any desktop build carrying this item's
--     submissionService.ts code can successfully call
--     split_agreement_in_force() over RPC and receive split_* values to
--     write. If THIS migration is not yet applied at that moment, the write
--     to transaction_submissions fails with PGRST204 (unknown column) on
--     every submission, for every user, until this migration lands. The
--     desktop code guards the split_* keys with `undefined` (never `null`)
--     precisely so that while 3503 is unapplied the RPC call fails cleanly
--     (measured: PGRST202, function not found) and no new key ever reaches
--     the INSERT body -- but once 3503 is live that guard no longer helps.
--
-- RATE PRECISION DELIBERATELY DIFFERS FROM THE SPLIT TABLE'S.
--   agent_split_agreements.agent_pct/brokerage_pct are numeric(5,2): a split
--   is a negotiated whole or half point (50, 70.5), never observed finer.
--   commission_offered_rate/commission_actual_rate are numeric(6,3): a
--   commission rate can legitimately carry three decimals in some MLS/market
--   conventions (e.g. 2.375%), and numeric(5,2) would silently TRUNCATE that
--   third digit -- silently truncating money is worse than a wider column
--   that costs nothing. split_agent_pct/split_brokerage_pct below are a
--   SNAPSHOT of the split table's own values and therefore stay numeric(5,2)
--   to match what they are copied from.
--
-- WHY split_resolved_on IS ITS OWN COLUMN, SET ONLY ON RESOLUTION SUCCESS.
--   The founder's backdating ruling (pm_comments 92f46fb4 on the split item):
--   a deal is judged by the terms in force on its CLOSING date, not the date
--   it happens to be recorded. So the split is resolved against
--   transaction.closed_at, UTC-truncated exactly as BACKLOG-3503's own INSERT
--   policy truncates deactivated_at -- `(closed_at AT TIME ZONE 'UTC')::date`
--   -- so the two dates are compared the same way everywhere in this system.
--   When closed_at is NULL (a submission can happen before a deal closes),
--   the fallback is the submission date. split_resolved_on records WHICH
--   date was actually used, so a reader never has to infer it from
--   split_effective_from or from silence.
--   It is set ONLY when the resolution RPC call itself succeeded (whether or
--   not a row was found) -- never on an RPC error. Setting it on every
--   attempt, including a PGRST202 (BACKLOG-3503 not yet applied), would
--   write "resolved on <date>, no agreement found" when the true state is
--   "resolution was not available at all" -- a false compliance statement on
--   a record this table exists to keep honest.
--
-- split_agreement_id IS A REAL FK, NOT A BARE UUID (founder decision,
-- superseding the engineer's checkpoint recommendation of a bare uuid). A
-- dangling id pointing at nothing is a worse failure on a compliance record
-- than the ordering constraint above, which is enforceable by discipline
-- (see the APPLY-ORDERING note) where a dangling FK is not.
--
-- CORRECTION (SR review, pm_comments 701d1100 on BACKLOG-3519): an earlier
-- draft of this note claimed "migrations apply in filename/version order,
-- 3503 is stamped earlier than this file, so the referenced table always
-- exists by the time this one runs." That is FALSE for this project as
-- measured against the live `supabase_migrations.schema_migrations` table on
-- 2026-09-25: 3503 (`20260922220719`) is an OUT-OF-ORDER pending migration --
-- seven later-stamped files are already applied (highest `20260925053321`),
-- and `supabase db push` refuses to apply an out-of-order file without
-- `--include-all`. Filename order therefore guarantees NOTHING here; 3503
-- could be skipped entirely on a routine push, and this migration would then
-- fail on its FK target at apply time. That failure is LOUD (missing
-- relation, the whole file rolls back inside its own BEGIN/COMMIT), not a
-- silent-corruption risk -- but do not rely on ordering to avoid it. Apply
-- 3503 and this file together, explicitly, in stamp order, in the same
-- window (`supabase db push --include-all`, or two explicit applies) -- see
-- the apply-ordering constraint recorded on BACKLOG-3503 in pm_comments.
--
-- NO CHECK TIES commission_adjustment_reason TO A RATE MISMATCH. The scope
-- note ("recordable when actual differs from offered, in either direction")
-- describes UI guidance for BACKLOG-3520, not a data-integrity rule -- an
-- agent may reasonably want to record a reason even when the rates match
-- (e.g. "confirmed, no change"). Only a length bound is enforced, matching
-- agent_split_agreements.note's own convention.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_transaction_submissions_split_agreement_id;
--   ALTER TABLE public.transaction_submissions
--     DROP CONSTRAINT IF EXISTS transaction_submissions_offered_rate_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_actual_rate_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_gross_amount_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_adjustment_reason_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_split_agent_pct_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_split_brokerage_pct_check,
--     DROP CONSTRAINT IF EXISTS transaction_submissions_split_sum_check;
--   ALTER TABLE public.transaction_submissions
--     DROP COLUMN IF EXISTS commission_offered_rate,
--     DROP COLUMN IF EXISTS commission_actual_rate,
--     DROP COLUMN IF EXISTS commission_gross_amount,
--     DROP COLUMN IF EXISTS commission_adjustment_reason,
--     DROP COLUMN IF EXISTS split_agreement_id,
--     DROP COLUMN IF EXISTS split_agent_pct,
--     DROP COLUMN IF EXISTS split_brokerage_pct,
--     DROP COLUMN IF EXISTS split_effective_from,
--     DROP COLUMN IF EXISTS split_resolved_on;
--
-- Tested by supabase/tests/backlog-3519/ (acceptance case + CHECK boundary
-- sweep) against a disposable local Postgres carrying 3503's shipped file;
-- not in CI (CI has no database).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ============================================================================
-- 1. What the agent enters (commission_*)
-- ============================================================================
ALTER TABLE public.transaction_submissions
  -- Percentage, e.g. 2.50 -- NOT a fraction (0.025). Matches
  -- agent_split_agreements.agent_pct's convention and the founder's own
  -- worked example (100,000 x 10% -> 10,000).
  ADD COLUMN IF NOT EXISTS commission_offered_rate      numeric(6,3),
  ADD COLUMN IF NOT EXISTS commission_actual_rate       numeric(6,3),
  -- Computed and rounded to cents ONCE by the writer (BACKLOG-3520), stored
  -- rather than derived on read -- so a later correction to sale_price
  -- cannot silently change a submission's historical gross commission.
  ADD COLUMN IF NOT EXISTS commission_gross_amount      numeric(12,2),
  ADD COLUMN IF NOT EXISTS commission_adjustment_reason text;

-- ============================================================================
-- 2. The frozen split snapshot (split_*) -- resolved and written by the
--    submit pipeline, cloud-side only. Never mirrored onto local
--    `transactions`: the split is cloud-resolved from agent_split_agreements
--    (an organization/agent concept the local SQLite schema has no
--    equivalent of), and a resubmission re-resolving into a LOCAL copy would
--    silently overwrite the very freeze this snapshot exists to provide.
-- ============================================================================
ALTER TABLE public.transaction_submissions
  ADD COLUMN IF NOT EXISTS split_agreement_id uuid
    CONSTRAINT transaction_submissions_split_agreement_fkey
    REFERENCES public.agent_split_agreements(id),
  -- Snapshot of agent_split_agreements.agent_pct/brokerage_pct AT
  -- split_resolved_on. numeric(5,2) to match what they are copied from --
  -- see the header note on why this differs from commission_*'s precision.
  ADD COLUMN IF NOT EXISTS split_agent_pct      numeric(5,2),
  ADD COLUMN IF NOT EXISTS split_brokerage_pct  numeric(5,2),
  ADD COLUMN IF NOT EXISTS split_effective_from date,
  -- The date split_agreement_in_force() was actually called with. See the
  -- header note: set ONLY on a successful RPC call, whether or not a row was
  -- found, and NEVER on an RPC error.
  ADD COLUMN IF NOT EXISTS split_resolved_on    date;

-- ============================================================================
-- 3. Domain checks -- nullable throughout; a NULL commission/split is not an
--    error, it is "not resolved / not yet entered" (founder: never block).
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
           OR char_length(btrim(commission_adjustment_reason)) BETWEEN 1 AND 2000),
  ADD CONSTRAINT transaction_submissions_split_agent_pct_check
    CHECK (split_agent_pct IS NULL OR (split_agent_pct >= 0 AND split_agent_pct <= 100)),
  ADD CONSTRAINT transaction_submissions_split_brokerage_pct_check
    CHECK (split_brokerage_pct IS NULL OR (split_brokerage_pct >= 0 AND split_brokerage_pct <= 100)),
  -- Both null (no split resolved) or both present and summing to 100 -- never
  -- one without the other. Mirrors agent_split_agreements' own sum CHECK.
  -- BOTH NON-NULL is spelled out explicitly rather than left to the sum
  -- expression alone: a CHECK constraint is satisfied when its expression
  -- evaluates to NULL (not just TRUE), so `60 + NULL = 100` -> NULL would
  -- silently ADMIT an asymmetric fill (agent set, brokerage NULL) if the
  -- non-null test were dropped. Measured against this exact migration on a
  -- local Postgres before this constraint was written this way: the version
  -- without the explicit IS NOT NULL pair let (60, NULL) through.
  ADD CONSTRAINT transaction_submissions_split_sum_check
    CHECK ((split_agent_pct IS NULL AND split_brokerage_pct IS NULL)
           OR (split_agent_pct IS NOT NULL AND split_brokerage_pct IS NOT NULL
               AND split_agent_pct + split_brokerage_pct = 100));

-- ============================================================================
-- 4. Index for the FK (BACKLOG-1638's own rule: an unindexed FK is a future
--    slow JOIN/DELETE). Plain, non-CONCURRENT, inside this transaction --
--    matches BACKLOG-3364's precedent for adding an index to an existing,
--    already-populated table; bounded by the lock_timeout set above.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_transaction_submissions_split_agreement_id
  ON public.transaction_submissions (split_agreement_id);

COMMENT ON COLUMN public.transaction_submissions.commission_offered_rate IS
  'BACKLOG-3519: percentage (2.50, not 0.025). What the agent was offered.';
COMMENT ON COLUMN public.transaction_submissions.commission_actual_rate IS
  'BACKLOG-3519: percentage. What actually applied; may differ from offered.';
COMMENT ON COLUMN public.transaction_submissions.commission_gross_amount IS
  'BACKLOG-3519: sale_price x commission_actual_rate, rounded to cents once by the writer. Stored, never derived on read.';
COMMENT ON COLUMN public.transaction_submissions.commission_adjustment_reason IS
  'BACKLOG-3519: optional free text. Recordable when actual differs from offered, in either direction; empty never blocks.';
COMMENT ON COLUMN public.transaction_submissions.split_agreement_id IS
  'BACKLOG-3519: FK to agent_split_agreements.id, the row this submission''s split was resolved from. NULL if none was in force on split_resolved_on, or if resolution failed (BACKLOG-3503 not yet applied).';
COMMENT ON COLUMN public.transaction_submissions.split_agent_pct IS
  'BACKLOG-3519: frozen snapshot of agent_split_agreements.agent_pct at split_resolved_on. Never rewritten by a later split change.';
COMMENT ON COLUMN public.transaction_submissions.split_brokerage_pct IS
  'BACKLOG-3519: frozen snapshot of agent_split_agreements.brokerage_pct at split_resolved_on.';
COMMENT ON COLUMN public.transaction_submissions.split_effective_from IS
  'BACKLOG-3519: the resolved agent_split_agreements row''s own effective_from, copied verbatim.';
COMMENT ON COLUMN public.transaction_submissions.split_resolved_on IS
  'BACKLOG-3519: the date split_agreement_in_force() was called with -- transaction.closed_at (AT TIME ZONE UTC)::date, or the submission date when closed_at is NULL. Set ONLY when the RPC call succeeded (row found or not); NULL means resolution was never attempted or failed, not "no split exists".';

COMMIT;
