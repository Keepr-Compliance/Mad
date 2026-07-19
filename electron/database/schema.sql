-- ============================================
-- MAD - LOCAL SQLite DATABASE SCHEMA
-- ============================================
-- Version: 2.0 (LLM + Agent Ready)
-- Purpose: Store user data, transactions, messages locally
-- Privacy: All sensitive data encrypted, local-first approach
-- Sync: Users table synced from Supabase cloud
--
-- Design Principles:
-- 1. Local-first: All sensitive data stays on device
-- 2. LLM-ready: Structured for tool-based AI analysis
-- 3. Agent-ready: Stage fields + history for future agents
-- 4. MCP-ready: ID-based resources for clean tool interfaces
-- ============================================

-- ============================================
-- USERS TABLE (Local Copy)
-- ============================================
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

  -- License (BACKLOG-426, synced from cloud)
  license_type TEXT DEFAULT 'individual' CHECK (license_type IN ('individual', 'team', 'enterprise')),
  ai_detection_enabled INTEGER DEFAULT 0,
  organization_id TEXT,

  -- Email onboarding (Migration 1)
  email_onboarding_completed_at DATETIME,

  -- Sync tracking
  last_cloud_sync_at DATETIME,

  UNIQUE(oauth_provider, oauth_id)
);

-- ============================================
-- OAUTH TOKENS TABLE (Local, Encrypted)
-- ============================================
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  purpose TEXT NOT NULL CHECK (purpose IN ('authentication', 'mailbox')),

  -- Token Data (encrypted using Electron safeStorage)
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at DATETIME,
  scopes_granted TEXT,

  -- Mailbox Specific
  connected_email_address TEXT,
  mailbox_connected INTEGER DEFAULT 0,
  permissions_granted_at DATETIME,

  -- Token Health
  token_last_refreshed_at DATETIME,
  token_refresh_failed_count INTEGER DEFAULT 0,
  last_sync_at DATETIME,
  last_sync_error TEXT,

  -- Status
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  UNIQUE(user_id, provider, purpose)
);

-- ============================================
-- SESSIONS TABLE (Local)
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_token TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

-- ============================================
-- CONTACTS TABLE (Core entity)
-- ============================================
-- Contacts are looked up at query time via contact_emails/contact_phones
-- This allows retroactive matching when users add missing info
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Display Info
  display_name TEXT NOT NULL,
  company TEXT,
  title TEXT,

  -- Source of this contact
  -- BACKLOG-1900 (P0.1): distinct per-origin sources (iphone, outlook, google_contacts,
  -- android_sync) so the Source filter can show friendly per-origin labels. Migration v48
  -- widens this CHECK for existing installs. NOTE: 'messages'/'is_message_derived' are
  -- SELECT-time synthetic labels in contactDbService.ts, NOT column values — kept OUT.
  source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'email', 'sms', 'contacts_app', 'inferred', 'android_sync', 'iphone', 'outlook', 'google_contacts')),

  -- Engagement Metrics (for CRM/Relationship Agent)
  last_inbound_at DATETIME,              -- Last time they messaged us
  last_outbound_at DATETIME,             -- Last time we messaged them
  total_messages INTEGER DEFAULT 0,      -- Total message count
  tags TEXT,                             -- JSON array: ["VIP", "past_client", "lead"]

  -- Import tracking
  is_imported INTEGER DEFAULT 1,         -- 1 = imported contact, 0 = manually created

  -- Auto-role (BACKLOG-1355)
  default_role TEXT,                     -- Most-recently-assigned role for auto-fill

  -- Metadata
  metadata TEXT,                         -- JSON for additional notes/data
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

-- ============================================
-- CONTACT EMAILS (Child table for multi-email support)
-- ============================================
-- Allows contacts to have multiple emails
-- Enables retroactive matching when users add new emails
CREATE TABLE IF NOT EXISTS contact_emails (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,

  email TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0,
  label TEXT,                            -- work, personal, etc.
  source TEXT CHECK (source IN ('import', 'manual', 'inferred')),

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  UNIQUE(contact_id, email)
);

-- ============================================
-- CONTACT PHONES (Child table for multi-phone support)
-- ============================================
-- Allows contacts to have multiple phone numbers
-- Uses E.164 format for consistent matching
CREATE TABLE IF NOT EXISTS contact_phones (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,

  phone_e164 TEXT NOT NULL,              -- Normalized: +14155550000
  phone_display TEXT,                    -- Display format: (415) 555-0000
  phone_normalized TEXT,                 -- BACKLOG-1727: shared-helper lookup key (last 10 digits)
  is_primary INTEGER DEFAULT 0,
  label TEXT,                            -- mobile, home, work, etc.
  source TEXT CHECK (source IN ('import', 'manual', 'inferred')),

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  UNIQUE(contact_id, phone_e164)
);

-- ============================================
-- MESSAGES TABLE (Emails, SMS, iMessage)
-- ============================================
-- Primary communication storage - what LLMs analyze
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Channel/Source Info
  channel_account_id TEXT,               -- Which mailbox/phone sent/received this
  external_id TEXT,                      -- Provider ID (Gmail, Outlook, iMessage)

  -- Type & Direction
  channel TEXT CHECK (channel IN ('email', 'sms', 'imessage')),
  direction TEXT CHECK (direction IN ('inbound', 'outbound')),

  -- Content
  subject TEXT,                          -- Email subject (null for SMS)
  body_html TEXT,                        -- Original HTML (email only)
  body_text TEXT,                        -- Normalized plain text - what LLMs see

  -- Participants (JSON for flexibility)
  -- Format: {"from": "email/phone", "to": [...], "cc": [...], "bcc": [...]}
  participants TEXT,
  participants_flat TEXT,                -- Denormalized: "from, to1, to2, cc1" for search

  -- Threading
  thread_id TEXT,                        -- Email thread ID or SMS conversation ID

  -- Timestamps
  sent_at DATETIME,
  received_at DATETIME,

  -- Attachments (count, actual files in attachments table)
  has_attachments INTEGER DEFAULT 0,

  -- Classification Results (LLM/Pattern outputs)
  is_transaction_related INTEGER,        -- 1 = yes, 0 = no, NULL = not classified
  classification_confidence REAL,        -- 0.0 - 1.0
  classification_method TEXT CHECK (classification_method IN ('pattern', 'llm', 'user')),
  classified_at DATETIME,

  -- False Positive Tracking
  is_false_positive INTEGER DEFAULT 0,
  false_positive_reason TEXT CHECK (false_positive_reason IN ('signature', 'promotional', 'unrelated', 'other')),

  -- Stage Hint (for future timeline features)
  -- Values: intro, showing, offer, inspections, escrow, closing, post_closing
  stage_hint TEXT,
  stage_hint_source TEXT CHECK (stage_hint_source IN ('pattern', 'llm', 'user')),
  stage_hint_confidence REAL,

  -- Transaction Link
  transaction_id TEXT,
  transaction_link_confidence REAL,      -- How sure we are about this link
  transaction_link_source TEXT CHECK (transaction_link_source IN ('pattern', 'llm', 'user')),

  -- Deduplication (TASK-905)
  message_id_header TEXT,                -- RFC 5322 Message-ID header for cross-provider dedup
  content_hash TEXT,                     -- SHA-256 hash of normalized content for fallback dedup
  duplicate_of TEXT,                     -- ID of original message if this is a duplicate

  -- Message Type (Migration 28, TASK-1799)
  message_type TEXT CHECK (message_type IS NULL OR message_type IN ('text', 'voice_message', 'location', 'attachment_only', 'system', 'unknown')),

  -- LLM Analysis (Migration 11)
  llm_analysis TEXT,                     -- Full LLM analysis response stored as JSON string

  -- Metadata (provider-specific data)
  metadata TEXT,                         -- JSON: labels, flags, etc.

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Sync session tracking (TASK-2110: ACID rollback on cancelled sync)
  sync_session_id TEXT,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

-- ============================================
-- ATTACHMENTS TABLE (Files attached to messages and emails)
-- ============================================
-- Separate table enables document classification and OCR
-- TASK-1775: Added email_id for Gmail/Outlook email attachments
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT,                       -- FK to messages (iMessage attachments) - nullable for email attachments
  email_id TEXT,                         -- TASK-1775: FK to emails (Gmail/Outlook attachments)
  external_message_id TEXT,              -- TASK-1110: macOS message GUID for stable linking

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

  -- Sync session tracking (TASK-2110: ACID rollback on cancelled sync)
  sync_session_id TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
  -- Note: CHECK (message_id IS NOT NULL OR email_id IS NOT NULL) enforced by service layer
  -- because SQLite CREATE TABLE IF NOT EXISTS won't update existing tables
  CHECK (message_id IS NOT NULL OR email_id IS NOT NULL)
);

-- ============================================
-- EMAILS TABLE (BACKLOG-506)
-- ============================================
-- Stores email content separately from the communications junction table.
-- communications.email_id links to this table for email content.
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Source identification
  external_id TEXT,                    -- Gmail/Outlook message ID
  source TEXT CHECK (source IN ('gmail', 'outlook')),
  account_id TEXT,                     -- Which email account

  -- Direction
  direction TEXT CHECK (direction IN ('inbound', 'outbound')),

  -- Content
  subject TEXT,
  body_plain TEXT,                     -- Plain text version
  body_html TEXT,                      -- HTML version

  -- Participants
  sender TEXT,                         -- From address
  recipients TEXT,                     -- To addresses (comma-separated)
  cc TEXT,
  bcc TEXT,

  -- Threading
  thread_id TEXT,                      -- Email thread/conversation ID
  in_reply_to TEXT,                    -- Message-ID of parent
  references_header TEXT,              -- References header for threading

  -- Timestamps
  sent_at DATETIME,
  received_at DATETIME,

  -- Attachments
  has_attachments INTEGER DEFAULT 0,
  attachment_count INTEGER DEFAULT 0,

  -- Deduplication
  message_id_header TEXT,              -- RFC 5322 Message-ID
  content_hash TEXT,                   -- SHA-256 for dedup

  -- Metadata
  labels TEXT,                         -- JSON: Gmail labels, Outlook categories
  classification TEXT,                 -- BACKLOG-1722: nullable JSON landing zone for future AI classifier output (no consumer today)

  -- Lifecycle provenance (BACKLOG-1801, Phase 2 "Validated Evidence Cache").
  -- Kept byte-for-byte in sync with migration v46 (ALTER TABLE ... ADD COLUMN).
  validated_at TEXT,                   -- when a $search-sourced row was existence-confirmed server-side (NULL = not validated)
  ingest_source TEXT NOT NULL DEFAULT 'legacy' CHECK (ingest_source IN ('legacy', 'filter', 'search_validated', 'manual')),

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

-- Emails indexes (BACKLOG-506: Performance requirement)
CREATE INDEX IF NOT EXISTS idx_emails_user_id ON emails(user_id);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at);
CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender);
CREATE INDEX IF NOT EXISTS idx_emails_external_id ON emails(external_id);
-- BACKLOG-1801 (Phase 2 T1): per-account identity re-scope. The user-scoped
-- idx_emails_user_external (UNIQUE user_id,external_id) and idx_emails_message_id_header
-- (NON-unique user_id,message_id_header, from v44) are REPLACED by per-account
-- UNIQUE partial indexes below. account_id (= oauth_tokens.id) is now backfilled,
-- so uniqueness is enforced within an account — the correct scope for multi-account
-- (the same Message-ID / provider id fetched into two accounts must not collide).
-- Kept byte-for-byte in sync with migration v46.
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_account_external ON emails(account_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_account_message_id_header ON emails(account_id, message_id_header) WHERE message_id_header IS NOT NULL;
-- BACKLOG-1771 (DB hardening S4): composite for per-user chronological reads
-- (`WHERE user_id = ? ORDER BY sent_at`). Kept byte-for-byte in sync with
-- migration v45.
CREATE INDEX IF NOT EXISTS idx_emails_user_sent ON emails(user_id, sent_at);

-- ============================================
-- EMAIL_PARTICIPANTS JUNCTION TABLE (BACKLOG-1722)
-- ============================================
-- One row per (email, role, position). Replaces denormalized scans against
-- emails.sender/recipients/cc/bcc with indexed exact-match lookups.
--
-- role: 'from' | 'to' | 'cc' | 'bcc'
-- position: 0-based ordinal within (email_id, role) — preserves header order
-- email_address: ALWAYS lowercased+trimmed (see normalizeEmailAddress)
-- display_name: original verbatim display (case preserved)
-- resolved_contact_id: nullable, NO FK constraint — populated by a later sprint
CREATE TABLE IF NOT EXISTS email_participants (
  email_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'bcc')),
  position INTEGER NOT NULL,
  participant_hash TEXT NOT NULL,      -- BACKLOG-1722: deterministic SHA-256 of email_id|role|position|email_address; stable cross-row dedup key + future embedding key
  email_address TEXT NOT NULL,
  display_name TEXT,
  resolved_contact_id TEXT,
  PRIMARY KEY (email_id, role, position),
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_participants_email_address
  ON email_participants(email_address);
CREATE INDEX IF NOT EXISTS idx_email_participants_address_role
  ON email_participants(email_address, role);
CREATE INDEX IF NOT EXISTS idx_email_participants_email_id
  ON email_participants(email_id);

-- Backfill error table — populated by migration v41 for rows whose denormalized
-- headers cannot be parsed. Used by support to triage edge cases.
CREATE TABLE IF NOT EXISTS email_participants_backfill_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  role TEXT NOT NULL,
  raw_value TEXT,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- EMAIL LIFECYCLE TABLES (BACKLOG-1801, Phase 2 "Validated Evidence Cache")
-- ============================================
-- Full design: BACKLOG-1767 §2. These three tables are the socket the Phase-2
-- reconciliation + data-clear + (next-sprint) delta engine plug into. CREATE
-- bodies are kept byte-for-byte in sync with migration v46 (schema-parity CI).

-- email_tombstones: records emails hard-deleted from the local cache so a later
-- fetch cannot resurrect a ghost. Keyed per account. reason distinguishes the
-- three deletion paths (server 404 during reconcile vs user Clear vs sweep).
-- account_id + external_id are NOT NULL: a tombstone is meaningless without both,
-- and nullable PK columns would let SQLite store duplicate logical keys.
CREATE TABLE IF NOT EXISTS email_tombstones (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  message_id_header TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('server_gone', 'user_clear', 'reconcile')),
  deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, account_id, external_id),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_tombstones_msgid ON email_tombstones(account_id, message_id_header) WHERE message_id_header IS NOT NULL;

-- email_sync_state: per-account sync bookkeeping. account_id = oauth_tokens.id
-- with NO foreign key (disposition B3: token rows are recreated on re-auth, so a
-- FK would cascade-delete sync state on every reconnect); NOT NULL is enforced at
-- the DB level and the app layer keys on it. cursor/newest/oldest/failure_count
-- are the exact columns the next-sprint Graph-delta / Gmail-history engine needs,
-- so it slots in without schema churn. phase=cleared blocks auto-refetch.
CREATE TABLE IF NOT EXISTS email_sync_state (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  phase TEXT NOT NULL DEFAULT 'active' CHECK (phase IN ('active', 'cleared', 'invalid')),
  cursor TEXT,
  newest_cached_at DATETIME,
  oldest_cached_at DATETIME,
  last_reconciled_at DATETIME,
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, account_id),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

-- data_clear_events: durable outbox for Clear-Data audit records. The row is
-- committed in the SAME transaction as (and BEFORE) the deletes it describes;
-- cloud_synced_at IS NULL means the cloud push is still pending (flushed on
-- start + reconnect). This table is SPARED by Clear All (the audit trail must
-- survive the very action it records).
CREATE TABLE IF NOT EXISTS data_clear_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('emails', 'messages', 'contacts', 'all')),
  account_id TEXT,
  counts_json TEXT,
  app_version TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  cloud_synced_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_data_clear_events_pending ON data_clear_events(cloud_synced_at) WHERE cloud_synced_at IS NULL;

-- ============================================
-- TRANSACTIONS TABLE (Real estate deals)
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Property Information
  property_address TEXT NOT NULL,        -- Full canonical address
  property_street TEXT,
  property_city TEXT,
  property_state TEXT,
  property_zip TEXT,
  property_coordinates TEXT,             -- JSON: {"lat": ..., "lng": ...}

  -- Transaction Type & Status
  transaction_type TEXT CHECK (transaction_type IN ('purchase', 'sale', 'other')),
  status TEXT DEFAULT 'active' CHECK (status IN ('pending', 'active', 'closed', 'rejected')),

  -- Key Dates
  started_at DATETIME,                   -- Representation start / first contact
  closed_at DATETIME,                    -- Closing date
  last_activity_at DATETIME,             -- Last message/update
  representation_start_date DATE,        -- Migration 2: Representation start date
  closing_date_verified INTEGER DEFAULT 0, -- Migration 2: Whether closing date was verified

  -- Date Confidence (Migration 2)
  representation_start_confidence INTEGER,
  closing_date_confidence INTEGER,

  -- Confidence (how sure we are this is a real transaction cluster)
  confidence_score REAL,

  -- Stage (for future timeline/agent features)
  -- Values: intro, showing, offer, inspections, escrow, closing, post_closing
  stage TEXT,
  stage_source TEXT CHECK (stage_source IN ('pattern', 'llm', 'user', 'import')),
  stage_confidence REAL,
  stage_updated_at DATETIME,

  -- Financial Data (auto-extracted or user-entered)
  listing_price REAL,
  sale_price REAL,
  earnest_money_amount REAL,

  -- Key Dates (auto-extracted)
  mutual_acceptance_date DATE,
  inspection_deadline DATE,
  financing_deadline DATE,
  closing_deadline DATE,

  -- Stats
  message_count INTEGER DEFAULT 0,
  attachment_count INTEGER DEFAULT 0,
  text_thread_count INTEGER DEFAULT 0,    -- BACKLOG-396: Stored thread count for consistent display

  -- Export Tracking
  export_status TEXT DEFAULT 'not_exported' CHECK (export_status IN ('not_exported', 'exported', 're_export_needed')),
  export_format TEXT CHECK (export_format IN ('pdf', 'csv', 'json', 'txt_eml', 'excel', 'folder')),
  export_count INTEGER DEFAULT 0,
  last_exported_at DATETIME,             -- Declared but NOT written by the export path; prefer last_exported_on
  last_exported_on DATETIME,             -- The column the export handlers actually write + list SELECT returns; use this for "last exported" (BACKLOG-2109)
  first_exported_at DATETIME,            -- BACKLOG-2013: freeze boundary — set once on first successful export; write-once (only when NULL); cleared by admin unfreeze

  -- AI Detection Fields (Migration 11)
  detection_source TEXT DEFAULT 'manual' CHECK (detection_source IN ('manual', 'auto', 'hybrid')),
  detection_status TEXT DEFAULT 'confirmed' CHECK (detection_status IN ('pending', 'confirmed', 'rejected')),
  detection_confidence REAL,
  detection_method TEXT,
  suggested_contacts TEXT,               -- JSON array of suggested contact assignments
  reviewed_at DATETIME,
  rejection_reason TEXT,

  -- Agent/Contact References (Migration 2)
  buyer_agent_id TEXT,
  seller_agent_id TEXT,
  escrow_officer_id TEXT,
  inspector_id TEXT,
  other_contacts TEXT,                   -- JSON array of additional contact IDs

  -- B2B Submission Tracking (BACKLOG-390)
  submission_status TEXT DEFAULT 'not_submitted' CHECK (submission_status IN ('not_submitted', 'submitted', 'under_review', 'needs_changes', 'resubmitted', 'approved', 'rejected')),
  submission_id TEXT,                    -- UUID reference to transaction_submissions in Supabase cloud
  submitted_at DATETIME,
  last_review_notes TEXT,

  -- Email Auto-Link Settings (BACKLOG-1364)
  skip_address_filter INTEGER DEFAULT 0, -- 1 = link ALL emails from contacts, 0 = filter by property address

  -- Metadata
  metadata TEXT,                         -- JSON for additional data
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

-- ============================================
-- TRANSACTION PARTICIPANTS (Contacts linked to transactions)
-- ============================================
-- Links contacts to transactions with roles
CREATE TABLE IF NOT EXISTS transaction_participants (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,

  -- Role (standardized enum for consistency)
  role TEXT CHECK (role IN (
    'buyer', 'seller',
    'buyer_agent', 'listing_agent',
    'lender', 'loan_officer',
    'escrow_officer', 'title_officer',
    'inspector', 'appraiser',
    'attorney', 'tc',
    'other', 'unknown'
  )),

  -- Confidence & Source
  confidence REAL,                       -- 0.0 - 1.0
  role_source TEXT CHECK (role_source IN ('pattern', 'llm', 'user')),

  is_primary INTEGER DEFAULT 0,          -- Primary contact for this role
  notes TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  UNIQUE(transaction_id, contact_id)
);

-- ============================================
-- TRANSACTION CONTACTS (Junction table for contacts in transactions)
-- ============================================
-- Links contacts to transactions with detailed role information
CREATE TABLE IF NOT EXISTS transaction_contacts (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,

  -- Role information
  role TEXT,
  role_category TEXT,
  specific_role TEXT,
  is_primary INTEGER DEFAULT 0,
  notes TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  UNIQUE(transaction_id, contact_id)
);

-- ============================================
-- AUDIT LOGS TABLE (Compliance tracking)
-- ============================================
-- Tracks all user actions for compliance/SOC 2
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL CHECK (action IN (
    'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'SESSION_REFRESH',
    'TRANSACTION_CREATE', 'TRANSACTION_UPDATE', 'TRANSACTION_DELETE',
    'TRANSACTION_SUBMIT',
    'CONTACT_CREATE', 'CONTACT_UPDATE', 'CONTACT_DELETE',
    'DATA_ACCESS', 'DATA_EXPORT', 'DATA_DELETE',
    'EXPORT_START', 'EXPORT_COMPLETE', 'EXPORT_FAIL',
    'MAILBOX_CONNECT', 'MAILBOX_DISCONNECT',
    'SETTINGS_CHANGE', 'SETTINGS_UPDATE', 'TERMS_ACCEPT'
  )),
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,                           -- JSON for additional context
  metadata TEXT,                          -- JSON for additional metadata (used by AuditService)
  ip_address TEXT,
  user_agent TEXT,
  success INTEGER DEFAULT 1,              -- Whether the action succeeded (1=true, 0=false)
  error_message TEXT,                     -- Error message if action failed
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  synced_at DATETIME,                     -- When synced to cloud (if applicable)

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

-- ============================================
-- AUDIT PACKAGES (Generated compliance bundles)
-- ============================================
-- Represents a complete audit export for a transaction
CREATE TABLE IF NOT EXISTS audit_packages (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  -- Package Info
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  format TEXT CHECK (format IN ('pdf', 'zip', 'json', 'excel')),
  storage_path TEXT,                     -- Local file path to package

  -- Content Summary
  message_count INTEGER,
  attachment_count INTEGER,
  date_range_start DATETIME,
  date_range_end DATETIME,

  -- LLM-Generated Summary
  summary TEXT,

  -- Quality Score
  completeness_score REAL,               -- 0.0 - 1.0, how complete is this audit

  -- Version tracking (for regeneration)
  version INTEGER DEFAULT 1,

  -- Metadata
  metadata TEXT,

  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

-- ============================================
-- TRANSACTION STAGE HISTORY (Timeline tracking)
-- ============================================
-- Tracks stage changes over time for timeline reconstruction
-- (Future use - agents can analyze progression)
CREATE TABLE IF NOT EXISTS transaction_stage_history (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,

  stage TEXT NOT NULL,
  source TEXT CHECK (source IN ('pattern', 'llm', 'user')),
  confidence REAL,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Optional: what triggered this change
  trigger_message_id TEXT,

  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

-- ============================================
-- CLASSIFICATION FEEDBACK (Training data collection)
-- ============================================
-- Tracks user corrections for future model improvement
CREATE TABLE IF NOT EXISTS classification_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- What was corrected
  message_id TEXT,
  attachment_id TEXT,
  transaction_id TEXT,
  contact_id TEXT,

  -- Feedback Type
  feedback_type TEXT CHECK (feedback_type IN (
    'message_relevance',                 -- Was this email transaction-related?
    'transaction_link',                  -- Which transaction does this belong to?
    'document_type',                     -- What type of document is this?
    'contact_role',                      -- What role does this contact have?
    'stage_hint'                         -- What stage is this message from?
  )),

  -- Values (stored as text for flexibility)
  original_value TEXT,
  corrected_value TEXT,
  reason TEXT,                           -- Why the correction was made

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE SET NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

-- ============================================
-- LLM SETTINGS TABLE (User LLM configuration)
-- ============================================
-- Stores API keys (encrypted), usage tracking, and feature flags
CREATE TABLE IF NOT EXISTS llm_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,

  -- Provider Config
  openai_api_key_encrypted TEXT,         -- Encrypted OpenAI API key
  anthropic_api_key_encrypted TEXT,      -- Encrypted Anthropic API key
  preferred_provider TEXT DEFAULT 'openai' CHECK (preferred_provider IN ('openai', 'anthropic')),
  openai_model TEXT DEFAULT 'gpt-4o-mini',
  anthropic_model TEXT DEFAULT 'claude-3-haiku-20240307',

  -- Usage Tracking
  tokens_used_this_month INTEGER DEFAULT 0,
  budget_limit_tokens INTEGER,
  budget_reset_date DATE,

  -- Platform Allowance
  platform_allowance_tokens INTEGER DEFAULT 0,
  platform_allowance_used INTEGER DEFAULT 0,
  use_platform_allowance INTEGER DEFAULT 0,

  -- Feature Flags
  enable_auto_detect INTEGER DEFAULT 1,
  enable_role_extraction INTEGER DEFAULT 1,

  -- Consent (Security Option C)
  llm_data_consent INTEGER DEFAULT 0,
  llm_data_consent_at DATETIME,

  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

-- ============================================
-- EXTRACTED TRANSACTION DATA (Field-level audit trail)
-- ============================================
-- Tracks what was extracted from which message
CREATE TABLE IF NOT EXISTS extracted_transaction_data (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,

  -- Extracted Field
  field_name TEXT NOT NULL,              -- closing_date, sale_price, etc.
  field_value TEXT,

  -- Source
  source_message_id TEXT,
  extraction_method TEXT CHECK (extraction_method IN ('pattern', 'llm', 'user')),
  confidence_score REAL,

  -- Verification
  manually_verified INTEGER DEFAULT 0,
  verified_at DATETIME,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

-- ============================================
-- INDEXES (Performance Optimization)
-- ============================================

-- Users & Auth
CREATE INDEX IF NOT EXISTS idx_users_local_email ON users_local(email);
CREATE INDEX IF NOT EXISTS idx_users_local_license_type ON users_local(license_type);
CREATE INDEX IF NOT EXISTS idx_users_local_organization ON users_local(organization_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_provider ON oauth_tokens(user_id, provider, purpose);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Contacts
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name);
CREATE INDEX IF NOT EXISTS idx_contacts_is_imported ON contacts(is_imported);
CREATE INDEX IF NOT EXISTS idx_contacts_user_imported ON contacts(user_id, is_imported);
CREATE INDEX IF NOT EXISTS idx_contact_emails_contact_id ON contact_emails(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_emails_email ON contact_emails(email);
CREATE INDEX IF NOT EXISTS idx_contact_phones_contact_id ON contact_phones(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_phones_phone ON contact_phones(phone_e164);
-- BACKLOG-1727: idx_contact_phones_normalized is created by migration v40 only.
-- Do not declare it here — schema.sql runs BEFORE migrations during startup,
-- and on upgrade the phone_normalized column does not exist yet at this point.

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_transaction_id ON messages(transaction_id);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_external_id ON messages(external_id);
-- CRITICAL: Unique constraint to make INSERT OR IGNORE work for deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_external_id ON messages(user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_is_transaction_related ON messages(is_transaction_related);
CREATE INDEX IF NOT EXISTS idx_messages_user_sent ON messages(user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_participants_flat ON messages(participants_flat);
-- Deduplication indexes (TASK-905)
CREATE INDEX IF NOT EXISTS idx_messages_message_id_header ON messages(message_id_header);
CREATE INDEX IF NOT EXISTS idx_messages_content_hash ON messages(content_hash);
CREATE INDEX IF NOT EXISTS idx_messages_duplicate_of ON messages(duplicate_of);
-- Sync session index (TASK-2110). Folded from migration v32 for fresh-install
-- parity (BACKLOG-1774, S6) — the sync_session_id column is declared above.
CREATE INDEX IF NOT EXISTS idx_messages_sync_session ON messages(user_id, sync_session_id);

-- Attachments
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);  -- TASK-1775
CREATE INDEX IF NOT EXISTS idx_attachments_external_message_id ON attachments(external_message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_document_type ON attachments(document_type);
-- Sync session index (TASK-2110). Folded from migration v32 for fresh-install
-- parity (BACKLOG-1774, S6) — the sync_session_id column is declared above.
CREATE INDEX IF NOT EXISTS idx_attachments_sync_session ON attachments(sync_session_id);

-- Transactions
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_property_address ON transactions(property_address);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_stage ON transactions(stage);
CREATE INDEX IF NOT EXISTS idx_transactions_export_status ON transactions(export_status);
CREATE INDEX IF NOT EXISTS idx_transactions_last_exported_on ON transactions(last_exported_on);
CREATE INDEX IF NOT EXISTS idx_transactions_submission_status ON transactions(submission_status);
CREATE INDEX IF NOT EXISTS idx_transactions_submission_id ON transactions(submission_id);

-- Transaction Participants
CREATE INDEX IF NOT EXISTS idx_transaction_participants_transaction ON transaction_participants(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_participants_contact ON transaction_participants(contact_id);
CREATE INDEX IF NOT EXISTS idx_transaction_participants_role ON transaction_participants(role);

-- Transaction Contacts
CREATE INDEX IF NOT EXISTS idx_transaction_contacts_transaction ON transaction_contacts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_contacts_contact ON transaction_contacts(contact_id);
CREATE INDEX IF NOT EXISTS idx_transaction_contacts_role ON transaction_contacts(role);
CREATE INDEX IF NOT EXISTS idx_transaction_contacts_specific_role ON transaction_contacts(specific_role);
CREATE INDEX IF NOT EXISTS idx_transaction_contacts_category ON transaction_contacts(role_category);
CREATE INDEX IF NOT EXISTS idx_transaction_contacts_primary ON transaction_contacts(is_primary);

-- Audit Logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_synced ON audit_logs(synced_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_session_id ON audit_logs(session_id);

-- Audit Packages
CREATE INDEX IF NOT EXISTS idx_audit_packages_transaction ON audit_packages(transaction_id);
CREATE INDEX IF NOT EXISTS idx_audit_packages_user ON audit_packages(user_id);

-- Stage History
CREATE INDEX IF NOT EXISTS idx_stage_history_transaction ON transaction_stage_history(transaction_id);
CREATE INDEX IF NOT EXISTS idx_stage_history_changed_at ON transaction_stage_history(changed_at);

-- Classification Feedback
CREATE INDEX IF NOT EXISTS idx_feedback_user ON classification_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_message ON classification_feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON classification_feedback(feedback_type);

-- Extracted Data
CREATE INDEX IF NOT EXISTS idx_extracted_data_transaction ON extracted_transaction_data(transaction_id);
CREATE INDEX IF NOT EXISTS idx_extracted_data_field ON extracted_transaction_data(field_name);

-- LLM Settings
CREATE INDEX IF NOT EXISTS idx_llm_settings_user ON llm_settings(user_id);

-- ============================================
-- TRIGGERS (Auto-update timestamps)
-- ============================================

CREATE TRIGGER IF NOT EXISTS update_users_local_timestamp
AFTER UPDATE ON users_local
BEGIN
  UPDATE users_local SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_oauth_tokens_timestamp
AFTER UPDATE ON oauth_tokens
BEGIN
  UPDATE oauth_tokens SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_contacts_timestamp
AFTER UPDATE ON contacts
BEGIN
  UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_transactions_timestamp
AFTER UPDATE ON transactions
BEGIN
  UPDATE transactions SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_transaction_participants_timestamp
AFTER UPDATE ON transaction_participants
BEGIN
  UPDATE transaction_participants SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_transaction_contacts_timestamp
AFTER UPDATE ON transaction_contacts
BEGIN
  UPDATE transaction_contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- LLM Settings timestamp
CREATE TRIGGER IF NOT EXISTS update_llm_settings_timestamp
AFTER UPDATE ON llm_settings
BEGIN
  UPDATE llm_settings SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Audit logs are append-only (no updates/deletes allowed)
CREATE TRIGGER IF NOT EXISTS prevent_audit_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit logs cannot be modified');
END;

CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit logs cannot be deleted');
END;

-- ============================================
-- COMMUNICATIONS TABLE (BACKLOG-506: Pure Junction Table)
-- ============================================
-- Links messages/emails to transactions. NO content columns.
-- Content lives in messages table (texts) or emails table (emails).
--
-- Architecture:
-- - messages (texts/SMS/iMessage) -> communications -> transactions
-- - emails (Gmail/Outlook)        -> communications -> transactions
--
-- Content link invariant (BACKLOG-1768, enforced below):
--   * exactly one of message_id / email_id (never both), OR
--   * thread_id alone (SMS thread batch link).
-- Email rows must also carry the linked email's thread_id — enforced by the
-- communications_email_thread_required trigger (a CHECK cannot subquery emails).
-- NOTE: the CREATE TABLE body below is kept byte-for-byte in sync with migration
-- v43 (databaseService.ts) so fresh-install and migrated DBs match (BACKLOG-1770).
CREATE TABLE IF NOT EXISTS communications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT,                     -- Nullable: may link content before transaction exists

  -- Link to content (exactly one of message_id / email_id; or thread_id alone)
  message_id TEXT,                         -- FK to messages (for texts)
  email_id TEXT,                           -- FK to emails (for emails)
  thread_id TEXT,                          -- For batch-linking all texts in a thread

  -- Link metadata
  link_source TEXT CHECK (link_source IN ('auto', 'manual', 'scan')),
  link_confidence REAL,
  linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys (BACKLOG-1768: transaction_id CASCADE — link rows die with their transaction)
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,

  -- BACKLOG-1768: reject both-set (message AND email) and neither-set (links to nothing)
  CHECK (
    (message_id IS NOT NULL AND email_id IS NULL)
    OR (email_id IS NOT NULL AND message_id IS NULL)
    OR (message_id IS NULL AND email_id IS NULL AND thread_id IS NOT NULL)
  )
);

-- Communications indexes
CREATE INDEX IF NOT EXISTS idx_communications_user_id ON communications(user_id);
CREATE INDEX IF NOT EXISTS idx_communications_transaction_id ON communications(transaction_id);
CREATE INDEX IF NOT EXISTS idx_communications_message_id ON communications(message_id);
CREATE INDEX IF NOT EXISTS idx_communications_email_id ON communications(email_id);
CREATE INDEX IF NOT EXISTS idx_communications_thread_id ON communications(thread_id);
CREATE INDEX IF NOT EXISTS idx_communications_txn_msg ON communications(transaction_id, message_id);

-- Unique constraints to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_msg_txn ON communications(message_id, transaction_id)
  WHERE message_id IS NOT NULL;
-- BACKLOG-1768: require transaction_id too so the same email cannot be linked to the
-- same transaction twice (NULL transaction_id rows are pre-link and excluded).
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_email_txn ON communications(email_id, transaction_id)
  WHERE email_id IS NOT NULL AND transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_thread_txn ON communications(thread_id, transaction_id)
  WHERE thread_id IS NOT NULL AND message_id IS NULL AND email_id IS NULL;

-- BACKLOG-1768: a communications row that links an email MUST carry that email's
-- thread_id so unlink expands to every thread sibling. A CHECK cannot subquery the
-- emails table, so the invariant is enforced by a BEFORE INSERT trigger. Legacy
-- emails whose own thread_id is NULL/'' are exempt (the row may keep a NULL thread_id).
-- Kept byte-for-byte in sync with migration v43 (databaseService.ts).
CREATE TRIGGER IF NOT EXISTS communications_email_thread_required
BEFORE INSERT ON communications
FOR EACH ROW
WHEN NEW.email_id IS NOT NULL
  AND NULLIF(NEW.thread_id, '') IS NULL
  AND NULLIF((SELECT thread_id FROM emails WHERE id = NEW.email_id), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'communications.thread_id required: linked email has a thread_id (BACKLOG-1768)');
END;

-- ============================================
-- IGNORED COMMUNICATIONS TABLE
-- ============================================
-- Stores communications that have been explicitly ignored/hidden from transactions.
-- This prevents them from being re-added during future email scans.
-- NOTE: the CREATE TABLE body below is kept byte-for-byte in sync with migration
-- v43 (databaseService.ts) for fresh-install / migrated parity (BACKLOG-1770).
CREATE TABLE IF NOT EXISTS ignored_communications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,

  -- Denormalized display/match cache (BACKLOG-1768): NOT authoritative — retained to
  -- match incoming emails during scans. email_id below is the real reference.
  email_subject TEXT,
  email_sender TEXT,
  email_sent_at TEXT,
  email_thread_id TEXT,

  -- BACKLOG-1560: Direct ID references for reliable suppression during auto-link
  email_id TEXT,                          -- FK to emails table (for email suppression)
  thread_id TEXT,                         -- Thread ID (for text message thread suppression)

  -- Original communication reference (if available)
  original_communication_id TEXT,

  -- Reason for ignoring (optional user note)
  reason TEXT,

  ignored_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- BACKLOG-1768: email_id gains a real FK (was convention-only) so suppression rows
  -- are cleaned up when their email is deleted.
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- Index for quick lookups during email scanning
CREATE INDEX IF NOT EXISTS idx_ignored_comms_user_email
  ON ignored_communications(user_id, email_sender, email_subject, email_sent_at);

CREATE INDEX IF NOT EXISTS idx_ignored_comms_transaction
  ON ignored_communications(transaction_id);

-- BACKLOG-1560: Indexes for auto-link suppression lookups
-- These indexes are created by migration 37 (which also adds the columns).
-- They cannot be in schema.sql because existing databases don't have these
-- columns yet when schema.sql runs (before versioned migrations).

-- ============================================
-- PHONE LAST MESSAGE TABLE (BACKLOG-567, Migration 24)
-- ============================================
-- Lookup table for fast contact sorting by last message date
-- Enables O(1) lookup instead of O(n) LIKE scans
CREATE TABLE IF NOT EXISTS phone_last_message (
  phone_normalized TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_message_at DATETIME NOT NULL,
  PRIMARY KEY (phone_normalized, user_id),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_phone_last_msg_user ON phone_last_message(user_id);

-- ============================================
-- EXTERNAL CONTACTS TABLE (BACKLOG-569, SPRINT-068, Migrations 25+27)
-- ============================================
-- Caches contacts from external sources (macOS Contacts, iPhone sync, etc.)
-- with pre-computed last_message_at for instant sorted loading
CREATE TABLE IF NOT EXISTS external_contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT,
  phones_json TEXT,
  phones_normalized_json TEXT,           -- BACKLOG-1727: JSON array of lookup keys parallel to phones_json
  emails_json TEXT,
  company TEXT,
  last_message_at DATETIME,
  external_record_id TEXT,
  source TEXT DEFAULT 'macos',
  synced_at DATETIME,
  -- Sync session tracking (TASK-2110: ACID rollback on cancelled sync)
  sync_session_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  UNIQUE(user_id, source, external_record_id)
);

CREATE INDEX IF NOT EXISTS idx_external_contacts_user ON external_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_external_contacts_last_msg ON external_contacts(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_contacts_source ON external_contacts(user_id, source);
-- Sync session index (TASK-2110). Folded from migration v32 for fresh-install
-- parity (BACKLOG-1774, S6) — the sync_session_id column is declared above.
CREATE INDEX IF NOT EXISTS idx_external_contacts_sync_session ON external_contacts(user_id, sync_session_id);

-- ============================================
-- FAILURE LOG (offline diagnostics)
-- ============================================
-- Folded from migration v31 for fresh-install parity (BACKLOG-1774, S6). Fresh
-- installs start at schema.sql's declared version (v32) and skip migrations
-- 30-32, so without this block they never received the failure_log table + its
-- indexes that upgraded installs have. Kept byte-for-byte in sync with migration
-- v31 and databaseService._ensureFailureLogTable().
CREATE TABLE IF NOT EXISTS failure_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  operation TEXT NOT NULL,
  error_message TEXT NOT NULL,
  metadata TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_failure_log_timestamp ON failure_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_failure_log_acknowledged ON failure_log(acknowledged);

-- ============================================
-- VIEWS (Convenient queries for common operations)
-- ============================================

-- Contact lookup view (flattens emails/phones for easy querying)
CREATE VIEW IF NOT EXISTS contact_lookup AS
SELECT
  c.id as contact_id,
  c.user_id,
  c.display_name,
  ce.email,
  cp.phone_e164 as phone
FROM contacts c
LEFT JOIN contact_emails ce ON c.id = ce.contact_id
LEFT JOIN contact_phones cp ON c.id = cp.contact_id;

-- Transaction summary view
CREATE VIEW IF NOT EXISTS transaction_summary AS
SELECT
  t.id,
  t.user_id,
  t.property_address,
  t.transaction_type,
  t.status,
  t.stage,
  t.started_at,
  t.closed_at,
  t.message_count,
  t.attachment_count,
  t.confidence_score,
  (SELECT COUNT(*) FROM transaction_contacts tc WHERE tc.transaction_id = t.id) as participant_count,
  (SELECT COUNT(*) FROM audit_packages ap WHERE ap.transaction_id = t.id) as audit_count
FROM transactions t;

-- ============================================
-- SCHEMA VERSION TABLE (Migration tracking)
-- ============================================
-- Tracks which schema version is currently applied.
-- Used by databaseService to determine which migrations to run.
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Initialize schema version if not exists
-- Version 32: Consolidated schema (includes sync_session_id columns from TASK-2110)
INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 32);
