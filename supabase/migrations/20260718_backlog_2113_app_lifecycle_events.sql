-- Migration: app_lifecycle_events + pre-wipe reset/uninstall logging (BACKLOG-2113)
--
-- PURPOSE
--   When a user RESETS or UNINSTALLS the desktop app, support currently has
--   zero visibility. The app is the only authenticated place that can record
--   the event, and it must be written BEFORE local data is wiped -- best-effort,
--   so an offline user can still complete the wipe.
--
--   This migration creates the destination table plus RLS that lets an
--   authenticated desktop client INSERT only its OWN rows (user_id = auth.uid())
--   and restricts SELECT to internal roles (support/admin). There is NO anon
--   access of any kind: anon is granted nothing and has no policy.
--
-- SECURITY MODEL (matches the canonical internal_roles guard used by
--   admin_audit_logs -- 20260307_auth_event_logging.sql -- and the credit-read
--   hardening -- 20260717_backlog_2094_harden_credit_read_rpcs.sql):
--     * authenticated desktop client -> may INSERT rows for itself only
--       (WITH CHECK user_id = auth.uid()); may NOT read the table.
--     * internal_roles member -> may SELECT (support forensics). No INSERT policy
--       needed for them beyond the self-insert one; they read via SELECT.
--     * anon -> no policy, no grants. Fully denied.
--     * service_role -> bypasses RLS (portal/support tooling reads as needed).
--
--   user_id is ON DELETE SET NULL so a reset/uninstall record SURVIVES deletion
--   of the user's auth row -- the whole point is post-hoc support forensics.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.app_lifecycle_events;

-- ============================================================================
-- Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.app_lifecycle_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id   text,
  event_type  text        NOT NULL CHECK (event_type IN ('reset', 'uninstall', 'reinstall')),
  app_version text,
  platform    text,
  reason      text,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_lifecycle_events IS
  'Best-effort reset/uninstall/reinstall lifecycle events written by the desktop app BEFORE local data wipe. Support/internal visibility only (BACKLOG-2113).';

-- ============================================================================
-- Index: support pulls a user''s lifecycle history newest-first.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_app_lifecycle_events_user_created
  ON public.app_lifecycle_events (user_id, created_at DESC);

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.app_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- INSERT: an authenticated desktop client may record only its OWN events.
DROP POLICY IF EXISTS "Users can insert own lifecycle events" ON public.app_lifecycle_events;
CREATE POLICY "Users can insert own lifecycle events"
  ON public.app_lifecycle_events
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- SELECT: internal roles (support/admin) only. Regular users cannot read.
DROP POLICY IF EXISTS "Internal roles can read lifecycle events" ON public.app_lifecycle_events;
CREATE POLICY "Internal roles can read lifecycle events"
  ON public.app_lifecycle_events
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
REVOKE ALL ON public.app_lifecycle_events FROM anon;
REVOKE ALL ON public.app_lifecycle_events FROM PUBLIC;
GRANT INSERT, SELECT ON public.app_lifecycle_events TO authenticated;
