-- BACKLOG-3851 PR-2f M4a (additive): optional first and last name on an invitation.
--
-- 1. organization_members.invited_first_name, organization_members.invited_last_name:
--    nullable text, each CHECK (char_length <= 100). Written by the broker-portal invite
--    form; copied into public.users (blank names only) when the invitation is accepted
--    (M4, 20261018170000).
-- 2. No function, policy or grant changes. Existing rows read NULL.
--
-- Apply order: M4a BEFORE the release that carries PR-2f (the portal selects and inserts
-- these columns) and BEFORE M4 (M4's pre-check requires both columns). M4a has no other
-- dependency. Its version sorts before M4's, matching the dependency.
-- Re-running this file is a no-op. Pre-check: each column is absent or present as text.
--
-- Rollback: supabase/tests/backlog-3851/pr2f/rollback-m4a.sql (after rollback-m4.sql).

DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.column_name, c.data_type
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'organization_members'
       AND c.column_name IN ('invited_first_name', 'invited_last_name')
  LOOP
    IF r.data_type IS DISTINCT FROM 'text' THEN
      RAISE EXCEPTION '3851 M4a pre-check: % exists as %', r.column_name, r.data_type;
    END IF;
  END LOOP;
END $pre$;

ALTER TABLE public.organization_members
  ADD COLUMN IF NOT EXISTS invited_first_name text,
  ADD COLUMN IF NOT EXISTS invited_last_name text;

DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organization_members'::regclass
       AND conname = 'organization_members_invited_first_name_length'
  ) THEN
    ALTER TABLE public.organization_members
      ADD CONSTRAINT organization_members_invited_first_name_length
      CHECK (invited_first_name IS NULL OR char_length(invited_first_name) <= 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organization_members'::regclass
       AND conname = 'organization_members_invited_last_name_length'
  ) THEN
    ALTER TABLE public.organization_members
      ADD CONSTRAINT organization_members_invited_last_name_length
      CHECK (invited_last_name IS NULL OR char_length(invited_last_name) <= 100);
  END IF;
END $chk$;
