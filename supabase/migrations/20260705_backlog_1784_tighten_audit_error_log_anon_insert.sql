-- Migration: Tighten anon INSERT on audit_logs / error_logs (BACKLOG-1784)
--
-- SECURITY ISSUE
--   public.audit_logs and public.error_logs each carried an INSERT policy for
--   the {anon} role with WITH CHECK (true). Anyone holding the public anon
--   (publishable) key could therefore INSERT arbitrary rows into the audit
--   trail / error stream — spam, forgery, and (for audit_logs) forging entries
--   under any user_id. These were flagged as "intentionally permissive" in
--   20260415_fix_rls_policies.sql (BACKLOG-410); this migration revisits that
--   decision now that the actual writers are known.
--
-- WRITER INVENTORY (verified against electron/, broker-portal/, admin-portal/,
-- supabase/functions/ at BACKLOG-1784 time)
--   Only the Electron desktop app writes to these two tables, and it uses the
--   SUPABASE_ANON_KEY client exclusively (never service_role — see
--   electron/services/supabaseService.ts). When a Supabase session exists the
--   client attaches the user JWT, so PostgREST evaluates the request as the
--   {authenticated} role, not {anon}.
--
--   audit_logs:
--     - electron/services/supabaseService.ts batchInsertAuditLogs() — upserts
--       rows where user_id = the signed-in user's id (audit_logs.user_id is
--       NOT NULL). Runs while authenticated → {authenticated} role →
--       users_can_insert_audit_logs (WITH CHECK user_id = auth.uid()) covers it.
--     - (electron/handlers/sessionHandlers.ts references a *local SQLite* table
--       named audit_logs in an FK-migration list — NOT a Supabase writer.)
--   error_logs:
--     - electron/services/errorLoggingService.ts submitError() — user_id is
--       re-derived from auth.getUser() at submit time; it is NULL before login
--       (pre-auth crash / network / DB-init errors) and equals auth.uid() after
--       login. Retry flush re-derives user_id, so queued errors are never
--       replayed with a stale id.
--     - electron/services/submissionService.ts — inserts during an
--       authenticated submission (user_id = session.userId ?? NULL).
--   broker-portal / admin-portal / supabase/functions write to admin_audit_logs
--   (a DIFFERENT table) or only READ audit_logs. No target-table writers there.
--
-- DECISION
--   audit_logs — DROP the anon INSERT policy. user_id is NOT NULL, so no
--     legitimate pre-auth anon row (with no user context) can even exist, and
--     anon cannot be tied to an identity (no auth.uid()). The only real writer
--     runs authenticated and is already covered by users_can_insert_audit_logs.
--     service_role path is unaffected.
--   error_logs — NARROW the anon INSERT policy from WITH CHECK (true) to
--     WITH CHECK (user_id IS NULL). Legitimate pre-auth error reporting always
--     inserts user_id = NULL, so this preserves that path while blocking anon
--     callers from forging error rows under a specific user_id. Authenticated
--     inserts remain covered by authenticated_can_insert_error_logs; the
--     service_role path is unaffected.
--
-- RESIDUALS (filed as findings on BACKLOG-1784)
--   1. audit_logs rows generated locally while the app never establishes a
--      Supabase session will no longer sync (they only synced before because of
--      the WITH CHECK (true) anon policy). This is acceptable: such rows carry a
--      real user_id and will sync once that user authenticates.
--   2. If a legacy row's user_id differs from auth.uid() (dual-ID history), the
--      authenticated policy already rejects it independent of this change.

-- ============================================================================
-- audit_logs: remove permissive anon INSERT (authenticated policy already covers
-- the only real writer)
-- ============================================================================
DROP POLICY IF EXISTS anon_can_insert_audit_logs ON public.audit_logs;

-- ============================================================================
-- error_logs: replace anon INSERT WITH CHECK (true) with WITH CHECK (user_id IS NULL)
-- ============================================================================
DROP POLICY IF EXISTS anon_can_insert_error_logs ON public.error_logs;

CREATE POLICY anon_can_insert_error_logs ON public.error_logs
  FOR INSERT
  TO anon
  WITH CHECK (user_id IS NULL);

COMMENT ON POLICY anon_can_insert_error_logs ON public.error_logs IS
  'Narrowed (BACKLOG-1784): anonymous error reporting is limited to rows with '
  'NULL user_id (pre-auth crash / network / DB-init errors). Blocks anon '
  'callers from forging error rows under a specific user_id. Was previously '
  'WITH CHECK (true). See also BACKLOG-410.';
