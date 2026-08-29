-- Migration: sync_outcomes -- the durable corpus of sync runs (BACKLOG-2914)
--
-- PURPOSE
--   One row per sync, success AND failure, written best-effort by the desktop app.
--
--   This is the SECOND destination for the outcome row that PR #2422 built. The
--   first is Sentry, and the two answer different questions on purpose:
--
--     * SENTRY answers "did this release break something": grouping, alerting,
--       filter by `release`. It cannot answer the duration question -- no SQL, no
--       joins, coarse aggregation, and 30-90 day retention would expire the corpus
--       long before there is enough of it to fit anything against.
--     * THIS TABLE is Postgres. It is where BACKLOG-2894's per-phase duration model
--       gets fitted, months from now, by querying device model against phase
--       duration. It is also the founder's own database, which is a better place
--       for this data than a third party.
--
--   The model is later work. The CORPUS has to start now: a run that is not
--   recorded is gone, and by the time 50 users have synced it is too late to go
--   back and collect it.
--
-- WHY EXPLICIT COLUMNS AND NOT A metadata jsonb
--   The column list IS the PII allow-list. The outcome row is an open map that
--   BACKLOG-2952's other sources will add fields to, and a catch-all jsonb would
--   carry whatever a future producer happened to put there straight into durable
--   storage. With named columns a stray `udid` in the timeline context physically
--   cannot land here. The desktop mapper picks these names and nothing else.
--
-- WHY phases IS jsonb ANYWAY
--   The phase list is the one genuinely open part of the row: `backup:transferring`
--   and `backup:waiting-for-device` did not exist a week ago, and 2952's sources
--   will have phases of their own. A column per phase would need a migration every
--   time one is added. It is an ARRAY of {phase, elapsed_ms} rather than an object
--   because SyncTimeline deliberately creates a NEW record when a phase is
--   re-entered ("a phase that runs twice is two durations, never one doubled") --
--   a keyed object would silently collapse the second into the first, and order
--   would be lost.
--
-- WHY ONLY ONE CHECK CONSTRAINT
--   `outcome` is a closed union in TypeScript and mirrors 2113's `event_type`
--   check. `source`, `prior_backup` and `backup_mode_source` are deliberately
--   unconstrained: this insert is BEST-EFFORT, so a CHECK that rejects a value a
--   future producer introduces would not raise an error anyone sees -- it would
--   silently drop rows out of the corpus, which is the one failure mode this table
--   exists to prevent.
--
-- SECURITY MODEL (verbatim from 20260718_backlog_2113_app_lifecycle_events.sql,
--   itself following the canonical internal_roles guard):
--     * authenticated desktop client -> may INSERT rows for itself only
--       (WITH CHECK user_id = auth.uid()); may NOT read the table.
--     * internal_roles member -> may SELECT (this is where the founder queries the
--       corpus from).
--     * anon -> no policy, no grants. Fully denied.
--     * service_role -> bypasses RLS.
--
--   user_id is ON DELETE SET NULL so the corpus survives deletion of a user's auth
--   row: an anonymous duration measurement is still a valid data point, and losing
--   history every time an account is removed would bias the model toward whoever
--   stayed.
--
-- PII: model identifier, byte counts, OS version, durations, counts. NO UDID, no
--   device NAME (the founder's is a personal nickname), no serial, no file path.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.sync_outcomes;

-- ============================================================================
-- Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sync_outcomes (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,

  -- What ran, and how it ended.
  source                    text        NOT NULL,
  outcome                   text        NOT NULL CHECK (outcome IN ('complete', 'cancelled', 'error')),
  elapsed_ms                bigint,
  phases                    jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- How the run was shaped. Three-state on purpose (BACKLOG-2886): `unknown` is a
  -- real answer and is never collapsed into false.
  prior_backup              text,
  backup_mode_source        text,
  incremental               boolean,
  was_encrypted             boolean,

  -- The device. MODEL IDENTIFIER ONLY -- never the name, never the UDID.
  device_model              text,
  device_ios_version        text,
  device_used_bytes         bigint,
  device_free_bytes         bigint,
  device_capacity_bytes     bigint,

  -- The host. A sync on a machine with a 95%-full disk behaves differently from one
  -- at 40%; without this, "this release got slower" and "this user's disk filled up"
  -- are the same shape in the data.
  host_os_release           text,
  host_total_mem_bytes      bigint,
  host_disk_free_bytes      bigint,
  host_disk_total_bytes     bigint,

  -- What the run moved.
  backup_bytes              bigint,
  backup_bytes_unmeasured   boolean,
  messages_extracted        integer,
  conversations_extracted   integer,
  contacts_extracted        integer,
  extraction_ms             bigint,

  -- Which build produced the measurement. `app_version` is the axis the whole item
  -- turns on. `is_packaged` separates a developer's dev-mode run from a real user's
  -- sync, so the founder's own testing does not pollute the corpus the model is fitted
  -- against -- cheap to record, impossible to reconstruct later.
  app_version               text,
  platform                  text,
  is_packaged               boolean,

  created_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sync_outcomes IS
  'One best-effort row per sync run (success AND failure) written by the desktop app. The success rows are the DENOMINATOR: without them a rise in failures and a rise in usage are indistinguishable. Corpus for BACKLOG-2894''s per-phase duration model. Internal visibility only (BACKLOG-2914).';

COMMENT ON COLUMN public.sync_outcomes.phases IS
  'Ordered array of {phase, elapsed_ms}. An array, not an object: a re-entered phase is two durations, never one doubled.';

COMMENT ON COLUMN public.sync_outcomes.device_model IS
  'Device MODEL identifier (e.g. iPhone14,3). Never the device name or UDID.';

-- ============================================================================
-- Indexes
-- ============================================================================
-- A user's sync history, newest first (mirrors 2113).
CREATE INDEX IF NOT EXISTS idx_sync_outcomes_user_created
  ON public.sync_outcomes (user_id, created_at DESC);

-- The question this item exists to answer: did syncs get worse in this release.
CREATE INDEX IF NOT EXISTS idx_sync_outcomes_version_source_created
  ON public.sync_outcomes (app_version, source, created_at DESC);

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.sync_outcomes ENABLE ROW LEVEL SECURITY;

-- INSERT: an authenticated desktop client may record only its OWN runs.
DROP POLICY IF EXISTS "Users can insert own sync outcomes" ON public.sync_outcomes;
CREATE POLICY "Users can insert own sync outcomes"
  ON public.sync_outcomes
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- SELECT: internal roles only. A user cannot read the corpus, including their own
-- rows -- there is no product surface for it, and SELECT is where an aggregate over
-- other people's devices would leak.
DROP POLICY IF EXISTS "Internal roles can read sync outcomes" ON public.sync_outcomes;
CREATE POLICY "Internal roles can read sync outcomes"
  ON public.sync_outcomes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.internal_roles
      WHERE user_id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- Grants: authenticated may INSERT/SELECT (RLS scopes the rows). anon: nothing.
-- ============================================================================
REVOKE ALL ON public.sync_outcomes FROM anon;
REVOKE ALL ON public.sync_outcomes FROM PUBLIC;
GRANT INSERT, SELECT ON public.sync_outcomes TO authenticated;
