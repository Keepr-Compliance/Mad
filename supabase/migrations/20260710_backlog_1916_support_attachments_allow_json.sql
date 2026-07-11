-- ============================================
-- SUPPORT TICKETING: ALLOW application/json ATTACHMENTS
-- Migration: 20260710_backlog_1916_support_attachments_allow_json
-- Backlog: BACKLOG-1916
-- Purpose: Durably add 'application/json' to the support-attachments bucket
--          allowed_mime_types allowlist.
--
-- WHY: The bucket was created by 20260313_support_storage.sql with an
--      allowed_mime_types ARRAY that did NOT include 'application/json'.
--      In-app support tickets upload a diagnostics.json file
--      (electron/handlers/supportTicketHandlers.ts, Step 3) which Storage
--      silently rejected, so tickets were created with NO diagnostics
--      (screenshots survived because 'image/png' IS allowlisted). A prod
--      hotfix was applied manually on 2026-07-10; this migration makes that
--      change durable so a fresh re-provision cannot revert it.
--
-- IDEMPOTENT: array_agg(DISTINCT ...) over array_append() will not create a
--      duplicate entry if 'application/json' is already present (e.g. on the
--      already-hotfixed prod bucket), so this is safe to re-run.
-- ============================================

UPDATE storage.buckets
SET allowed_mime_types = (
  SELECT array_agg(DISTINCT m)
  FROM unnest(array_append(allowed_mime_types, 'application/json')) AS m
)
WHERE id = 'support-attachments';
