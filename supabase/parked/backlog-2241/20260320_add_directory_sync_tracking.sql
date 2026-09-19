-- TASK-2307: Add directory_sync_error column to organizations
-- Sprint: SPRINT-N (Azure Completion)
--
-- The directory_sync_last_at column already exists (added in 20260203_add_organizations_sso_columns.sql).
-- This migration adds an error tracking column so the Edge Function can record
-- the last sync error per organization for admin visibility.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS directory_sync_error TEXT;
