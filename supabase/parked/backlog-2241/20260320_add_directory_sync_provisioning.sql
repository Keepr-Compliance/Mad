-- TASK-2304: Add directory_sync to provisioned_by and service_account_key column
-- Sprint: SPRINT-L (Provider Abstraction & SCIM Decomposition)
--
-- 1. Update the provisioned_by CHECK constraint on organization_members to
--    include 'directory_sync' as a valid value (for Google Workspace directory sync).
-- 2. Add service_account_key_encrypted column to organization_identity_providers
--    (stores encrypted Google service account JSON key for server-to-server auth).

-- Step 1: Drop and recreate the provisioned_by CHECK constraint
-- The existing constraint allows: 'manual', 'scim', 'jit', 'invite'
-- We add: 'directory_sync'
ALTER TABLE organization_members
  DROP CONSTRAINT IF EXISTS organization_members_provisioned_by_check;

ALTER TABLE organization_members
  ADD CONSTRAINT organization_members_provisioned_by_check
  CHECK (provisioned_by IS NULL OR provisioned_by IN ('manual', 'scim', 'jit', 'invite', 'directory_sync'));

-- Step 2: Add service_account_key_encrypted to organization_identity_providers
-- Used for Google Workspace directory sync (service account JSON key).
-- KNOWN LIMITATION: Column is named "_encrypted" as future-proofing for KMS
-- integration, but currently stores plaintext. Actual encryption requires a
-- KMS (e.g., AWS KMS, GCP KMS, Vault) which is not yet integrated.
ALTER TABLE organization_identity_providers
  ADD COLUMN IF NOT EXISTS service_account_key_encrypted TEXT;
