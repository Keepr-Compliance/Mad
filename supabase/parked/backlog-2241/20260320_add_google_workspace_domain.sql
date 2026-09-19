-- TASK-2304: Add google_workspace_domain column to organizations table
-- Sprint: SPRINT-L (Provider Abstraction & SCIM Decomposition)
--
-- Stores the Google Workspace domain for organizations using Google as their
-- identity provider. Used for JIT (Just-In-Time) provisioning lookups,
-- analogous to how microsoft_tenant_id is used for Azure AD JIT.

-- Add the column
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS google_workspace_domain TEXT;

-- Partial index for JIT lookup: only index rows that have a domain set
CREATE INDEX IF NOT EXISTS idx_organizations_google_workspace_domain
  ON organizations (google_workspace_domain)
  WHERE google_workspace_domain IS NOT NULL;
