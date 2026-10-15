-- BACKLOG-3674: per-account "dashboard tour dismissed" record.
--
-- Version 20261008130000 claimed in the tracker before this file was written.
-- Apply as ONE transaction (`psql -1 -f <file>`, or the whole file in one SQL
-- editor run). It opens none of its own. Every statement is safe to run twice.
--
--   1. public.users gains a nullable tour_dismissed_at (timestamptz). The
--      desktop app sets it when the account finishes the dashboard tour, or
--      closes it with "Don't show this again" ticked. Null = not dismissed.
--      Existing rows stay null (no backfill).
--
--   2. UPDATE on that one column is granted to authenticated. Since
--      BACKLOG-3714 (20261007200000) client UPDATE on public.users is limited
--      to a named column list, so a new column is not client-writable without
--      this line. After this file authenticated holds UPDATE on 17 columns
--      (3714's 16 plus this one); anon still holds none.
--
-- NOT changed: SELECT / INSERT / REFERENCES (table-level, the new column
-- inherits them); every RLS policy on public.users (row access stays
-- `auth.uid() = id` for UPDATE); triggers; functions.
--
-- Rollback is posted with the apply packet on the backlog item, not kept here.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tour_dismissed_at timestamptz;

COMMENT ON COLUMN public.users.tour_dismissed_at IS
  'BACKLOG-3674: set when the account finished the dashboard tour or closed it with "Don''t show this again". Null = not dismissed.';

GRANT UPDATE (tour_dismissed_at) ON public.users TO authenticated;
