-- Migration: a sync run leaves evidence even when it never ends (BACKLOG-3440)
--
-- WHY
--   On 2026-09-16 two users each lost about three hours to an iPhone sync that never
--   completed, and the founder heard about it from them two days later. One run left
--   a row saying `cancelled` after 181.7 minutes with `backup:transferring` open for
--   169 of them. The other left NO ROW AT ALL.
--
--   `sync_outcomes` records a run when it FINISHES one of its known ways. A run that
--   is killed, quit, or still going is therefore invisible: the record is assembled at
--   the end, so a run with no end has no record. Every other improvement to this data
--   only covers runs that already report.
--
--   This migration is what lets the desktop app write the row at the START of a run and
--   keep it current while the run is alive.
--
-- THE THREE WRITES, AND WHY THE VERBS DIFFER
--     start     INSERT ... ON CONFLICT DO NOTHING   carries outcome = 'running'
--     heartbeat UPDATE                              NEVER carries `outcome`
--     terminal  INSERT ... ON CONFLICT DO UPDATE    carries the terminal outcome
--
--   The start write ignores a conflict rather than erroring. A sync that fails in its
--   first milliseconds — a pre-flight disk or driver check — can land its terminal write
--   before the start write's round trip completes, and a plain INSERT would then raise a
--   duplicate-key error that the fire-and-forget catch logs as "outcome row dropped"
--   when in fact the row is present and correct. DO NOTHING also means a late start
--   write physically cannot revert a finished run to `running`.
--
--   The heartbeat must never carry `outcome`. Every one of these writes is
--   fire-and-forget with no ordering guarantee, so a heartbeat still in flight when the
--   terminal write lands would revert a COMPLETED run to `running` and leave it that
--   way forever — a new false signal produced by the instrument built to remove false
--   signals. With `outcome` structurally absent from the heartbeat payload, a late
--   heartbeat can only bump the progress columns, which is harmless on a finished row.
--
--   The terminal write is an UPSERT and not a bare UPDATE because the start INSERT can
--   be DROPPED: `syncOutcomeSupabase.ts` drops rows when the machine is offline, by
--   design, and syncs happen in offices with bad Wi-Fi. If the start row never landed
--   and the terminal write were an UPDATE, a run that SUCCEEDED would leave zero rows —
--   a regression against the guarantee this table already provides. With an upsert on a
--   client-generated `id`, whichever write lands first creates the row.
--
-- WHY started_at AND NOT created_at
--   Same reason. `created_at DEFAULT now()` records whichever write landed first, so on
--   exactly the runs that had a bad network it would record the END time — the one
--   number this whole item exists to produce. `started_at` is set from the client's
--   `beginSync` clock and sent on every write, so it is correct whichever write wins
--   and is immune to merge order.
--
-- CONSEQUENCE TO ACCEPT OPENLY
--   `outcome` gains 'running', so a bare `count(*)` over this table STOPS being a count
--   of finished runs. Queries that want finished runs must say
--   `where outcome <> 'running'`. That is the point: the runs that were previously
--   missing are the ones worth looking at.
--
-- NO CHECK CONSTRAINT ON THE NEW TEXT COLUMNS
--   Following 20260828143000's own rule: this write is BEST-EFFORT, so a CHECK that
--   rejects a value a future producer introduces does not raise an error anyone sees —
--   it silently drops rows out of the corpus, which is the failure mode this table
--   exists to prevent. Only `outcome` is constrained, and only because it already was.
--
-- PII: byte counts, timestamps, a phase NAME, an error code. No UDID, no device name,
--   no serial, no file path. `reason_code` is the existing closed `BackupErrorCode`
--   union; `device_error_code` is an integer MBErrorDomain code.
--
-- ROLLBACK:
--   ALTER TABLE public.sync_outcomes DROP CONSTRAINT IF EXISTS sync_outcomes_outcome_check;
--   ALTER TABLE public.sync_outcomes ADD CONSTRAINT sync_outcomes_outcome_check
--     CHECK (outcome IN ('complete', 'cancelled', 'error'));
--   DROP POLICY IF EXISTS "Users can update own sync outcomes" ON public.sync_outcomes;
--   DROP POLICY IF EXISTS "Users can read own sync outcomes" ON public.sync_outcomes;
--   ALTER TABLE public.sync_outcomes
--     DROP COLUMN IF EXISTS started_at,
--     DROP COLUMN IF EXISTS updated_at,
--     DROP COLUMN IF EXISTS bytes_transferred,
--     DROP COLUMN IF EXISTS bytes_last_increased_at,
--     DROP COLUMN IF EXISTS last_phase,
--     DROP COLUMN IF EXISTS reason_code,
--     DROP COLUMN IF EXISTS device_error_code,
--     DROP COLUMN IF EXISTS ended_by;
--   (Any row left at outcome = 'running' must be resolved first, or the CHECK will fail.)

-- ============================================================================
-- 1. `outcome` admits a run that has not finished
-- ============================================================================
ALTER TABLE public.sync_outcomes
  DROP CONSTRAINT IF EXISTS sync_outcomes_outcome_check;

ALTER TABLE public.sync_outcomes
  ADD CONSTRAINT sync_outcomes_outcome_check
  CHECK (outcome IN ('complete', 'cancelled', 'error', 'running'));

-- ============================================================================
-- 2. The columns a run in flight needs
-- ============================================================================
ALTER TABLE public.sync_outcomes
  -- WHEN the run began, from the client's own clock. See "WHY started_at" above.
  ADD COLUMN IF NOT EXISTS started_at              timestamptz,

  -- WHEN this row was last written. The pair (updated_at, bytes_last_increased_at) is
  -- what separates the three shapes that were previously indistinguishable:
  --   both advancing            -> alive, moving data
  --   updated_at only           -> alive, moving NOTHING  (the stall)
  --   neither                   -> the process or the app is gone
  ADD COLUMN IF NOT EXISTS updated_at              timestamptz,

  -- The high-water mark of bytes the backup reported transferring.
  ADD COLUMN IF NOT EXISTS bytes_transferred       bigint,

  -- THE FIELD THE 2026-09-16 INCIDENT NEEDED AND DID NOT HAVE. We knew the transfer
  -- ran 2h49m; we did not know whether it moved 57 GB slowly or moved 2 GB and stopped
  -- dead. Those are different defects with different fixes.
  --
  -- It is NOT a duplicate of the existing 30-minute no-progress watchdog. That watchdog
  -- counts STREAM activity — any stdout chunk plus a curated stderr signal list — and
  -- says nothing about bytes. Its silence during the 169-minute transfer is itself
  -- evidence: the process was producing accepted chatter the whole time. This column is
  -- the orthogonal instrument.
  ADD COLUMN IF NOT EXISTS bytes_last_increased_at timestamptz,

  -- Which phase was open at the last write, so an abandoned row says WHERE it stopped.
  ADD COLUMN IF NOT EXISTS last_phase              text,

  -- The machine-readable failure code the device path already produces
  -- (DEVICE_LOCKED, CONNECTION_LOST, BACKUP_TIMEOUT, …) and which the orchestrator
  -- previously discarded, forwarding only the human sentence.
  ADD COLUMN IF NOT EXISTS reason_code             text,

  -- The MBErrorDomain code the device itself reported (105 = host disk full,
  -- 208 = device locked). NULL means "the device did not say", never "no error".
  ADD COLUMN IF NOT EXISTS device_error_code       integer,

  -- WHO ended the run. `cancelled` has never meant "the user pressed Cancel" — it means
  -- the abort signal was set, which also happens when a user clicks Sync or Try Again
  -- while a run is already going. Those are different reports from a user and they were
  -- the same row.
  ADD COLUMN IF NOT EXISTS ended_by                text;

COMMENT ON COLUMN public.sync_outcomes.outcome IS
  'complete | cancelled | error | running. `running` means the run had not finished when the row was last written — it is the normal state of a live run, and a PERMANENT `running` is a run that was killed, quit, or abandoned. Counts of finished runs must say `where outcome <> ''running''` (BACKLOG-3440).';

COMMENT ON COLUMN public.sync_outcomes.started_at IS
  'When the run began, from the client clock at beginSync. Sent on every write, so it survives the start INSERT being dropped offline and the terminal upsert creating the row instead (BACKLOG-3440).';

COMMENT ON COLUMN public.sync_outcomes.bytes_last_increased_at IS
  'Last time the reported byte count went UP. Compared against updated_at this separates a slow transfer from one that stopped dead — the question the 2026-09-16 incident could not answer (BACKLOG-3440).';

COMMENT ON COLUMN public.sync_outcomes.ended_by IS
  'Which act ended the run: user-cancel | user-reset | restart-while-running | host-guard | watchdog | device-error. Absent when the run ended some other way or has not ended (BACKLOG-3440).';

-- ============================================================================
-- 3. Indexes
-- ============================================================================
-- THE QUESTION THIS ITEM EXISTS TO ANSWER: which runs never finished.
-- Partial, because `running` rows are the rare and interesting ones.
CREATE INDEX IF NOT EXISTS idx_sync_outcomes_running
  ON public.sync_outcomes (updated_at DESC)
  WHERE outcome = 'running';

-- ============================================================================
-- 4. RLS: the desktop client may now UPDATE its own rows
-- ============================================================================
-- Without this there is NO update path at all — a heartbeat and the terminal upsert
-- would both be refused, silently, because a refused write is logged at warn and
-- swallowed so it can never fail a sync. A mocked client cannot tell an RLS refusal
-- from a success, which is why this was verified against the real engine with
-- SET LOCAL ROLE authenticated before the migration was written down.
--
-- Scoped exactly like the INSERT policy: a client may only touch its own runs. USING
-- limits which rows it may reach; WITH CHECK stops it reassigning one to someone else.
DROP POLICY IF EXISTS "Users can update own sync outcomes" ON public.sync_outcomes;
CREATE POLICY "Users can update own sync outcomes"
  ON public.sync_outcomes
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- A USER MAY NOW READ THEIR OWN ROWS, AND THIS IS NOT A CONVENIENCE — IT IS REQUIRED.
--
-- 20260828143000 states "a user cannot read the corpus, including their own rows", and
-- that is deliberately reversed here for OWN ROWS ONLY. Measured against the live
-- engine (BEGIN / SET LOCAL ROLE authenticated / ROLLBACK), with the UPDATE policy
-- above in place and NO select policy for the owner:
--
--   * `UPDATE ... WHERE id = $1`   affected ZERO rows. No error. Postgres applies
--     SELECT policies to an UPDATE that reads columns, and `WHERE id` reads one — so
--     every heartbeat would have been a silent no-op.
--   * `INSERT ... ON CONFLICT (id) DO UPDATE` — the terminal write — failed outright
--     with 42501 `new row violates row-level security policy`.
--
--   The second is the dangerous one. That write is fire-and-forget with its rejection
--   logged at warn and swallowed, so the corpus would have stopped receiving ANY
--   terminal row while every test passed and nothing went red. A mocked Supabase client
--   cannot tell an RLS refusal from a success, which is precisely why this was run
--   against the real engine before the file was written.
--
-- THE 2914 CONCERN IS UNAFFECTED, and that was also measured: with this policy in
-- place, a second authenticated user selecting the first user's row by primary key gets
-- ZERO rows. The aggregate over other people's devices that 2914 was protecting is
-- still denied; what is now permitted is a user reading the durations of their own
-- syncs, on their own machine.
DROP POLICY IF EXISTS "Users can read own sync outcomes" ON public.sync_outcomes;
CREATE POLICY "Users can read own sync outcomes"
  ON public.sync_outcomes
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ============================================================================
-- 5. Grants
-- ============================================================================
-- `authenticated` already holds UPDATE here, from the schema-wide default privileges
-- Supabase installs — 20260828143000's `GRANT INSERT, SELECT` was additive and revoked
-- nothing. Stated explicitly so the table's intent does not depend on a default that
-- could be tightened later. Still no DELETE: the corpus is append-and-amend.
GRANT UPDATE ON public.sync_outcomes TO authenticated;

-- ============================================================================
-- 6. Backfill started_at for the rows already recorded
-- ============================================================================
-- Every existing row was written at the END of its run, so its start time is
-- recoverable exactly: created_at minus the elapsed time it measured. Without this the
-- 19 rows already in the corpus would be the only ones with no start time, which would
-- read as a gap in the instrument rather than as history.
UPDATE public.sync_outcomes
   SET started_at = created_at - make_interval(secs => elapsed_ms / 1000.0)
 WHERE started_at IS NULL
   AND elapsed_ms IS NOT NULL;
