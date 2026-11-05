-- BACKLOG-4130 — Email Sync Timing report: catalog key and read policy
--
-- The admin-portal Email Sync Timing report (registry slug 'email-precache') reads sync_outcomes rows
-- of source 'email-precache'. Since BACKLOG-4144 every report needs:
--   1. its key in public.reports (20261105100000), or report_my_access('email-precache') answers NULL
--      for everyone, Super Admins included, and the page is a 404;
--   2. a branch in the sync_outcomes internal-read policy (20261105110000), or an internal viewer
--      reads no 'email-precache' rows except their own.
--
-- The policy is changed IN PLACE with ALTER POLICY (same name, command and roles). ALTER POLICY
-- replaces the whole USING expression, so the two 4144 branches are restated unchanged and the third
-- is added after them. Own rows stay a separate policy ("Users can read own sync outcomes"), unchanged.
--
-- No function or table is created here. report_my_access() is the 4144 caller-bound function
-- (auth.uid() inside, EXECUTE to authenticated only); this file changes no grant.
--
-- Idempotent: the INSERT is ON CONFLICT DO NOTHING; ALTER POLICY sets the same text on every run.
-- Rollback: supabase/tests/backlog-4130/rollback-4130.sql.

-- ============================================================
-- 1. Report catalog key
-- ============================================================
INSERT INTO public.reports (report_key) VALUES
  ('email-precache')
ON CONFLICT (report_key) DO NOTHING;

-- ============================================================
-- 2. sync_outcomes — iphone-sync / google-messages-sync / email-precache
-- ============================================================
ALTER POLICY "Internal roles can read sync outcomes" ON public.sync_outcomes
  USING (
    (
      source = 'iphone-backup'
      AND (SELECT public.report_my_access('iphone-sync')) IS NOT NULL
    )
    OR (
      source = 'google-messages'
      AND (SELECT public.report_my_access('google-messages-sync')) IS NOT NULL
    )
    OR (
      source = 'email-precache'
      AND (SELECT public.report_my_access('email-precache')) IS NOT NULL
    )
  );

COMMENT ON POLICY "Internal roles can read sync outcomes" ON public.sync_outcomes IS
  'BACKLOG-4144/4130: iphone-backup rows to iphone-sync report access; google-messages rows to google-messages-sync report access; email-precache rows to email-precache report access.';
