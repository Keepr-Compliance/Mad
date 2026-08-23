-- ===========================================================================
-- PRE-v63 COMPOSITE FIXTURE — DO NOT EDIT, DO NOT "FIX"
-- ===========================================================================
-- Three CREATE TABLE statements, each TRANSCRIBED VERBATIM from the commit at
-- which that table genuinely still lacked the columns migration v63 adds. None
-- of it is hand-written; regenerate or verify with the `git show` command in
-- each section header, and the assertion that made this file is the same one
-- the generator runs: none of the seven columns appears in any body.
--
-- WHY A COMPOSITE, AND WHY THAT IS NOT "INVENTING A FIXTURE". No single point in
-- history has all three tables missing all seven columns: `attachments` did not
-- exist yet when `transactions.last_exported_on` landed (2025-11-17). So the
-- state this fixture describes is assembled, but every PART of it is real, and
-- the shape each table has is one the app really shipped.
--
-- WHY IT IS NEEDED AT ALL. The committed end-to-end fixture
-- (schema-2026-01-26-5cec24486.sql) is missing exactly ONE of the seven columns,
-- so it exercises exactly one of v63's seven ALTER statements. Fresh installs
-- skip the ALTER branch entirely (the columns are already in CREATE TABLE). That
-- would leave six ADD COLUMN statements shipping as never-executed SQL — the
-- precise "green because it was never exercised" shape BACKLOG-2750 is about.
-- It matters most for `license_type` and `submission_status`, the two carrying
-- DEFAULT + CHECK clauses, whose legality under ALTER TABLE ADD COLUMN is
-- asserted here by RUNNING it rather than by recall.
--
-- An older end-to-end fixture cannot replace this: every database old enough to
-- lack these columns dies inside migration v43 for an unrelated reason
-- (BACKLOG-2751), so isolation is the only coverage available until that lands.
--
-- No rows are seeded here; the test seeds them, so identities stay in the test.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- `users_local` — verbatim from `git show efb444a0b^:electron/database/schema.sql`
-- license_type / organization_id arrive in efb444a0b (2026-01-22)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users_local (
  -- Core Identity (synced from cloud)
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  avatar_url TEXT,

  -- OAuth Reference
  oauth_provider TEXT NOT NULL CHECK (oauth_provider IN ('google', 'microsoft')),
  oauth_id TEXT NOT NULL,

  -- Subscription (synced from cloud)
  subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro', 'enterprise')),
  subscription_status TEXT DEFAULT 'trial' CHECK (subscription_status IN ('trial', 'active', 'cancelled', 'expired')),
  trial_ends_at DATETIME,

  -- Account Status
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME,

  -- Legal compliance
  terms_accepted_at DATETIME,
  terms_version_accepted TEXT,
  privacy_policy_accepted_at DATETIME,
  privacy_policy_version_accepted TEXT,

  -- Preferences (local, synced to cloud)
  timezone TEXT DEFAULT 'America/Los_Angeles',
  theme TEXT DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'auto')),
  notification_preferences TEXT DEFAULT '{}',
  company TEXT,
  job_title TEXT,
  mobile_phone_type TEXT CHECK (mobile_phone_type IN ('iphone', 'android')),

  -- Sync tracking
  last_cloud_sync_at DATETIME,

  UNIQUE(oauth_provider, oauth_id)
);

-- ---------------------------------------------------------------------------
-- `transactions` — verbatim from `git show 6c0e67ed5^:electron/database/schema.sql`
-- last_exported_on arrives in 6c0e67ed5 (2025-11-17); submission_status / submission_id in b7b9d1367 (2026-01-22)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Property Information (USER INPUT)
  property_address TEXT NOT NULL,
  property_street TEXT,
  property_city TEXT,
  property_state TEXT,
  property_zip TEXT,
  property_coordinates TEXT,

  -- Transaction Details (AUTO-DETECTED + USER INPUT)
  transaction_type TEXT CHECK (transaction_type IN ('purchase', 'sale')),
  transaction_status TEXT DEFAULT 'completed' CHECK (transaction_status IN ('completed', 'pending')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  closing_date DATE,
  representation_start_date DATE,
  closing_date_verified INTEGER DEFAULT 0,
  representation_start_confidence INTEGER,
  closing_date_confidence INTEGER,

  -- Contact Associations
  buyer_agent_id TEXT,
  seller_agent_id TEXT,
  escrow_officer_id TEXT,
  inspector_id TEXT,
  other_contacts TEXT, -- JSON array of contact IDs

  -- Metadata
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  export_generated_at DATETIME,

  -- Extraction Stats
  communications_scanned INTEGER DEFAULT 0,
  extraction_confidence INTEGER,

  -- Auto-Extracted Data
  first_communication_date DATETIME,
  last_communication_date DATETIME,
  total_communications_count INTEGER DEFAULT 0,
  mutual_acceptance_date DATE,
  earnest_money_amount DECIMAL(10, 2),
  earnest_money_delivered_date DATE,
  listing_price DECIMAL(12, 2),
  sale_price DECIMAL(12, 2),
  other_parties TEXT,
  offer_count INTEGER DEFAULT 0,
  failed_offers_count INTEGER DEFAULT 0,
  key_dates TEXT,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (buyer_agent_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (seller_agent_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (escrow_officer_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (inspector_id) REFERENCES contacts(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- `attachments` — verbatim from `git show 847d6eec4^:electron/database/schema.sql`
-- external_message_id arrives in 847d6eec4 (2026-01-17); email_id in c90a869f8 (2026-01-31)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,

  -- File Info
  filename TEXT NOT NULL,
  mime_type TEXT,
  file_size_bytes INTEGER,
  storage_path TEXT,                     -- Local file path

  -- Extracted Content (for LLMs)
  text_content TEXT,                     -- OCR / extracted text from PDFs

  -- Document Classification
  document_type TEXT,                    -- offer, inspection, disclosure, contract, appraisal, amendment, addendum, other
  document_type_confidence REAL,
  document_type_source TEXT CHECK (document_type_source IN ('pattern', 'llm', 'user')),

  -- Analysis Results (JSON)
  -- Contains extracted fields: dates, amounts, parties, etc.
  analysis_metadata TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- `schema_version` — matches the shape `_ensureSchemaVersionTable` creates.
-- Seeded with no row; the test picks the version so the clip is explicit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  migrated_at TEXT DEFAULT (datetime('now'))
);
