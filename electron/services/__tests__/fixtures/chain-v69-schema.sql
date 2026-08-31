-- ===================================================================
-- GENERATED — DO NOT HAND-EDIT (BACKLOG-2993)
-- ===================================================================
-- Produced by electron/services/__tests__/generateSchemaBaseline.gen.ts.
-- Regeneration steps are in that file's header.
--
-- source commit : 0bd6703bbe957417f7e01a0446d34185d1c7094c
-- generated     : 2026-08-30
-- schema_version: 69
-- producer      : OLD electron/database/schema.sql + the FULL migration
--                 chain (v30..v69) run through the real runner
--                 (_runVersionedMigrations) on an empty database.
-- role          : frozen side of the schema-parity control (C2) AND the
--                 v69 boundary-sweep fixture. IRREPLACEABLE — the chain
--                 this transcribes was deleted by BACKLOG-2993.
-- ===================================================================

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE attachments (
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
CREATE TABLE "audit_logs" (
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
            details TEXT,
            metadata TEXT,
            ip_address TEXT,
            user_agent TEXT,
            success INTEGER DEFAULT 1,
            error_message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            synced_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
          );
CREATE TABLE audit_packages (
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
CREATE TABLE classification_feedback (
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
CREATE TABLE communications (
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

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, match_reason TEXT,

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
CREATE TABLE contact_emails (
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
CREATE TABLE contact_link_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT,
    source_type TEXT CHECK (
      source_type IS NULL OR
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'confirmed', 'rejected')
    ),
    reason TEXT NOT NULL,
    matched_on TEXT,
    identity_assessment TEXT NOT NULL CHECK (
      identity_assessment IN ('same_person', 'possibly_same_person', 'different_people')
    ),
    relationship_assessment TEXT NOT NULL CHECK (
      relationship_assessment IN ('connected', 'possibly_connected', 'no_known_connection')
    ),
    cluster_key TEXT NOT NULL,
    evidence_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    pair_kind TEXT NOT NULL DEFAULT 'record_contact' CHECK (
      pair_kind IN ('record_contact', 'record_record', 'contact_contact')
    ),
    target_contact_id TEXT,
    target_source_type TEXT CHECK (
      target_source_type IS NULL OR
      target_source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    target_source_record_id TEXT,
    subject_side TEXT NOT NULL DEFAULT 'a' CHECK (subject_side IN ('a', 'b')),
    pair_key TEXT GENERATED ALWAYS AS (
      CASE pair_kind
        WHEN 'record_contact' THEN
          'c:' || contact_id || '|r:' || source_type || ':' || source_record_id
        WHEN 'contact_contact' THEN
          'c:' || min(contact_id, target_contact_id) ||
          '|c:' || max(contact_id, target_contact_id)
        WHEN 'record_record' THEN
          min('r:' || source_type || ':' || source_record_id,
              'r:' || target_source_type || ':' || target_source_record_id) ||
          '|' ||
          max('r:' || source_type || ':' || source_record_id,
              'r:' || target_source_type || ':' || target_source_record_id)
      END
    ) STORED,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (target_contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    CHECK (
      (pair_kind = 'record_contact'
        AND contact_id IS NOT NULL
        AND source_type IS NOT NULL AND source_record_id IS NOT NULL
        AND target_contact_id IS NULL
        AND target_source_type IS NULL AND target_source_record_id IS NULL
        AND subject_side = 'a')
      OR (pair_kind = 'record_record'
        AND contact_id IS NULL AND target_contact_id IS NULL
        AND source_type IS NOT NULL AND source_record_id IS NOT NULL
        AND target_source_type IS NOT NULL AND target_source_record_id IS NOT NULL
        AND NOT (source_type = target_source_type
                 AND source_record_id = target_source_record_id))
      OR (pair_kind = 'contact_contact'
        AND contact_id IS NOT NULL AND target_contact_id IS NOT NULL
        AND contact_id <> target_contact_id
        AND source_type IS NULL AND source_record_id IS NULL
        AND target_source_type IS NULL AND target_source_record_id IS NULL)
    ),
    UNIQUE (user_id, contact_id, source_type, source_record_id),
    UNIQUE (user_id, pair_key)
  );
CREATE TABLE contact_link_verdicts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT,
    source_type TEXT CHECK (
      source_type IS NULL OR
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT,
    identity_verdict TEXT NOT NULL CHECK (
      identity_verdict IN ('same_person', 'possibly_same_person', 'different_people')
    ),
    relationship_verdict TEXT CHECK (
      relationship_verdict IN ('connected', 'possibly_connected', 'no_known_connection')
    ),
    reason TEXT,
    matched_on TEXT,
    evidence_json TEXT,
    decided_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_by TEXT NOT NULL DEFAULT 'user',
    pair_kind TEXT NOT NULL DEFAULT 'record_contact' CHECK (
      pair_kind IN ('record_contact', 'record_record', 'contact_contact')
    ),
    target_contact_id TEXT,
    target_source_type TEXT CHECK (
      target_source_type IS NULL OR
      target_source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    target_source_record_id TEXT,
    subject_side TEXT NOT NULL DEFAULT 'a' CHECK (subject_side IN ('a', 'b')),
    pair_key TEXT GENERATED ALWAYS AS (
      CASE pair_kind
        WHEN 'record_contact' THEN
          'c:' || contact_id || '|r:' || source_type || ':' || source_record_id
        WHEN 'contact_contact' THEN
          'c:' || min(contact_id, target_contact_id) ||
          '|c:' || max(contact_id, target_contact_id)
        WHEN 'record_record' THEN
          min('r:' || source_type || ':' || source_record_id,
              'r:' || target_source_type || ':' || target_source_record_id) ||
          '|' ||
          max('r:' || source_type || ':' || source_record_id,
              'r:' || target_source_type || ':' || target_source_record_id)
      END
    ) STORED,
    CHECK (
      (pair_kind = 'record_contact'
        AND contact_id IS NOT NULL
        AND source_type IS NOT NULL AND source_record_id IS NOT NULL
        AND target_contact_id IS NULL
        AND target_source_type IS NULL AND target_source_record_id IS NULL
        AND subject_side = 'a')
      OR (pair_kind = 'record_record'
        AND contact_id IS NULL AND target_contact_id IS NULL
        AND source_type IS NOT NULL AND source_record_id IS NOT NULL
        AND target_source_type IS NOT NULL AND target_source_record_id IS NOT NULL
        AND NOT (source_type = target_source_type
                 AND source_record_id = target_source_record_id))
      OR (pair_kind = 'contact_contact'
        AND contact_id IS NOT NULL AND target_contact_id IS NOT NULL
        AND contact_id <> target_contact_id
        AND source_type IS NULL AND source_record_id IS NULL
        AND target_source_type IS NULL AND target_source_record_id IS NULL)
    )
  );
CREATE TABLE contact_phones (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,

  phone_e164 TEXT NOT NULL,              -- Normalized: +14155550102
  phone_display TEXT,                    -- Display format: (415) 555-0102
  phone_normalized TEXT,                 -- BACKLOG-1727: shared-helper lookup key. BACKLOG-2630: E.164 digits via libphonenumber (was last 10 digits); migration v64 re-keys existing rows
  is_primary INTEGER DEFAULT 0,
  label TEXT,                            -- mobile, home, work, etc.
  source TEXT CHECK (source IN ('import', 'manual', 'inferred')),

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  UNIQUE(contact_id, phone_e164)
);
CREATE TABLE "contact_source_links" (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync',
                      'manual', 'email', 'sms', 'inferred')
    ),
    source_record_id TEXT NOT NULL,
    external_uuid TEXT,
    match_method TEXT NOT NULL CHECK (
      match_method IN ('source_id', 'email', 'phone', 'unique_name', 'manual', 'scored', 'origin')
    ),
    confidence REAL,
    matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    evidence_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE (user_id, source_type, source_record_id)
  );
CREATE TABLE "contacts" (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            company TEXT,
            title TEXT,
            source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'email', 'sms', 'contacts_app', 'inferred', 'android_sync', 'iphone', 'outlook', 'google_contacts')),
            last_inbound_at DATETIME,
            last_outbound_at DATETIME,
            total_messages INTEGER DEFAULT 0,
            tags TEXT,
            is_imported INTEGER DEFAULT 1,
            default_role TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, removed_at DATETIME, removed_reason TEXT,
            FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
          );
CREATE TABLE data_clear_events (
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
CREATE TABLE email_participants (
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
CREATE TABLE email_participants_backfill_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  role TEXT NOT NULL,
  raw_value TEXT,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE email_sync_state (
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
CREATE TABLE email_tombstones (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  message_id_header TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('server_gone', 'user_clear', 'reconcile')),
  deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, account_id, external_id),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE TABLE emails (
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
  -- BACKLOG-2571: sent_at is the SENDER-ASSERTED send time (Gmail `Date:`
  -- header, Outlook `sentDateTime`); received_at is when the server took
  -- delivery. They were the same value on every row until BACKLOG-2571, because
  -- both derived from the provider's receive timestamp. A difference between
  -- them is now meaningful — it is the send↔receive delta.
  --
  -- Rows written BEFORE that fix still hold a receive time in sent_at, and
  -- nothing on disk distinguishes them: the send time was never stored (Outlook's
  -- sentDateTime reached only the content hash; Gmail's `Date:` header was not
  -- read at all), so there is nothing to backfill from. A provider re-sync
  -- rewrites them; no marker column records the difference, by founder decision
  -- 2026-08-09 — the only rows affected were one developer's test data.
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
  -- BACKLOG-2513: retained bulk-mail headers as JSON (List-Unsubscribe,
  -- List-Unsubscribe-Post, Precedence, Auto-Submitted, Authentication-Results).
  -- Negative-filter input for auto-detection (BACKLOG-2500 s4.2). No reader
  -- today, by design: raw facts are stored, classification is deferred.
  --
  -- Kept in sync with migration v62 (ALTER TABLE ... ADD COLUMN), which is the
  -- ONLY source of this column on an existing install. This declaration is a
  -- READABILITY convention (matching validated_at/ingest_source below), NOT a
  -- parity requirement: schema-parity exec's schema.sql on BOTH of its paths,
  -- so the migration alone would satisfy it (cf. v56's tombstone columns, which
  -- are declared on neither table and still converge). It is safe here only
  -- because `emails` is never positionally copied by any migration.
  --
  -- NEVER add a standalone CREATE INDEX on this column to this file: schema.sql
  -- is exec'd BEFORE the migration chain, so an index on a not-yet-added column
  -- throws "no such column" on every real upgrade (BACKLOG-2298/2300).
  bulk_mail_headers TEXT,

  -- Lifecycle provenance (BACKLOG-1801, Phase 2 "Validated Evidence Cache").
  -- Kept byte-for-byte in sync with migration v46 (ALTER TABLE ... ADD COLUMN).
  validated_at TEXT,                   -- when a $search-sourced row was existence-confirmed server-side (NULL = not validated)
  ingest_source TEXT NOT NULL DEFAULT 'legacy' CHECK (ingest_source IN ('legacy', 'filter', 'search_validated', 'manual')),

  -- Derivation provenance (BACKLOG-2857). validated_at/ingest_source above stamp
  -- HOW a row was produced; this stamps WHICH VERSION of the derivation logic
  -- produced it, so a later mapper fix can find and repair its own history
  -- instead of needing a human to remember the fix exists.
  --
  -- An INTEGER, not a boolean: a bit can only say "stale", and once the first
  -- reprocess flips it a SECOND fix cannot tell rows that already received fix #1
  -- from rows still on the original. An integer records exactly which
  -- transformations a row has seen, so two fixes months apart compose and only
  -- the missing steps run. Per ROW, not per account, because that is what makes
  -- a reprocess resumable: kill the app mid-pass and every row's stamp is still
  -- accurate, so the next run continues rather than restarting.
  --
  -- DEFAULT 0 is load-bearing. Every row written before this column existed is BY
  -- DEFINITION at version 0 (the pre-BACKLOG-2855 body_plain derivation), which is
  -- exactly the set the reprocess pass must find. Do NOT backfill it to CURRENT —
  -- that would declare every legacy row already repaired and silently strand the
  -- truncated bodies this exists to fix.
  --
  -- Kept in sync with migration v67 (ALTER TABLE ... ADD COLUMN), which is the
  -- ONLY source of this column on an existing install, matching the v46
  -- validated_at/ingest_source and v62 bulk_mail_headers convention.
  --
  -- NEVER add a standalone CREATE INDEX on this column to this file: schema.sql is
  -- exec'd BEFORE the migration chain, so an index on a not-yet-added column throws
  -- "no such column" on every real upgrade (BACKLOG-2298/2300/2750 — shipped broken
  -- in July, caught only by founder live QA). The partial index serving
  -- `WHERE derived_version < ?` ships INSIDE v67, which covers both paths: fresh
  -- installs seed schema_version at BASELINE_VERSION and replay the chain.
  derived_version INTEGER NOT NULL DEFAULT 0,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE TABLE external_contacts (
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
  sync_session_id TEXT, external_uuid TEXT, source_identity_json TEXT,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  UNIQUE(user_id, source, external_record_id)
);
CREATE TABLE extracted_transaction_data (
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
CREATE TABLE failure_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  operation TEXT NOT NULL,
  error_message TEXT NOT NULL,
  metadata TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ignored_communications (
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

  ignored_at DATETIME DEFAULT CURRENT_TIMESTAMP, match_reason TEXT,

  -- BACKLOG-1768: email_id gains a real FK (was convention-only) so suppression rows
  -- are cleaned up when their email is deleted.
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);
CREATE TABLE llm_settings (
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
  -- BACKLOG-2313: auto-detect defaults OFF. The transaction auto-detect scan is
  -- now gated on BOTH ai_detection entitlement AND this opt-in toggle (see
  -- emailSyncHandlers.isAutoDetectAllowed), so fresh installs must not auto-create
  -- transactions until the user explicitly opts in. Existing rows are unchanged
  -- (no migration); only new rows created via createLLMSettings pick up this default.
  enable_auto_detect INTEGER DEFAULT 0,
  enable_role_extraction INTEGER DEFAULT 1,

  -- Consent (Security Option C)
  llm_data_consent INTEGER DEFAULT 0,
  llm_data_consent_at DATETIME,

  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE TABLE message_import_state (
  user_id TEXT PRIMARY KEY,
  last_import_at DATETIME,
  last_expansion_at DATETIME,
  deepest_import_start DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE TABLE message_thread_names (
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,               -- Matches messages.thread_id ("macos-chat-<chat ROWID>")
  display_name TEXT NOT NULL,            -- Trimmed, non-empty; absence = no row
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id, thread_id),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE TABLE messages (
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

  -- Reactions / Tapbacks (Migration 52, BACKLOG-2280)
  -- Apple raw tapback code: 2000-2005 add, 3000-3005 remove; NULL for normal messages.
  associated_message_type INTEGER,
  -- Normalized guid of the message this reaction targets (matches parent external_id); NULL for normal messages.
  associated_message_guid TEXT,

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
CREATE TABLE oauth_tokens (
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
CREATE TABLE pending_review_communications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,

  -- Exactly one of these is set: email_id for mail, thread_id for text threads
  -- (which is how text links are stored — see createThreadCommunicationReference).
  email_id TEXT,
  thread_id TEXT,

  found_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,

  CHECK (
    (email_id IS NOT NULL AND thread_id IS NULL)
    OR (thread_id IS NOT NULL AND email_id IS NULL)
  )
);
CREATE TABLE phone_last_message (
  phone_normalized TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_message_at DATETIME NOT NULL,
  PRIMARY KEY (phone_normalized, user_id),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE TABLE schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, migrated_at TEXT);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_token TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE TABLE transaction_contacts (
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
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, removed_at DATETIME, removed_reason TEXT,

  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  UNIQUE(transaction_id, contact_id)
);
CREATE TABLE transaction_participants (
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
CREATE TABLE transaction_stage_history (
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
CREATE TABLE transaction_unlocks_cache (
            local_transaction_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            unlocked_at TEXT NOT NULL,
            funding_source TEXT,
            cached_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (local_transaction_id, user_id)
          );
CREATE TABLE transactions (
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

  -- BACKLOG-2791: delta watermark for the Needs-Review sync, which runs on EVERY
  -- transaction open. Holds the time of the last on-open scan; the next one only
  -- examines rows INGESTED since (emails.created_at / messages.created_at, NOT
  -- sent_at — a backfill writes an OLD sent_at with a NEW created_at). Without
  -- it the scan re-examines every record that already lost, on every open, which
  -- is the BACKLOG-2620 non-convergence shape.
  --
  -- Kept in sync with migration v65 (ALTER TABLE ... ADD COLUMN), which is the
  -- ONLY source of this column on an existing install. NEVER add a standalone
  -- CREATE INDEX on it here: schema.sql is exec'd BEFORE the migration chain, so
  -- an index on a not-yet-added column throws on every real upgrade
  -- (BACKLOG-2298/2300). `transactions` is never positionally copied by any
  -- migration, so a trailing declaration is safe.
  last_pending_scan_at DATETIME,

  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE TABLE users_local (
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

INSERT INTO "schema_version" ("id", "version", "updated_at", "migrated_at") VALUES (1, 69, '2026-08-30 00:39:21', '2026-08-30 00:39:21');

CREATE TRIGGER communications_email_thread_required
BEFORE INSERT ON communications
FOR EACH ROW
WHEN NEW.email_id IS NOT NULL
  AND NULLIF(NEW.thread_id, '') IS NULL
  AND NULLIF((SELECT thread_id FROM emails WHERE id = NEW.email_id), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'communications.thread_id required: linked email has a thread_id (BACKLOG-1768)');
END;
CREATE VIEW contact_lookup AS
          SELECT
            c.id as contact_id,
            c.user_id,
            c.display_name,
            ce.email,
            cp.phone_e164 as phone
          FROM contacts c
          LEFT JOIN contact_emails ce ON c.id = ce.contact_id
          LEFT JOIN contact_phones cp ON c.id = cp.contact_id;
CREATE INDEX idx_attachments_document_type ON attachments(document_type);
CREATE INDEX idx_attachments_email_id ON attachments(email_id);
CREATE INDEX idx_attachments_external_message_id ON attachments(external_message_id);
CREATE INDEX idx_attachments_message_id ON attachments(message_id);
CREATE INDEX idx_attachments_sync_session ON attachments(sync_session_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_resource_type ON audit_logs(resource_type);
CREATE INDEX idx_audit_logs_session_id ON audit_logs(session_id);
CREATE INDEX idx_audit_logs_synced ON audit_logs(synced_at);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_packages_transaction ON audit_packages(transaction_id);
CREATE INDEX idx_audit_packages_user ON audit_packages(user_id);
CREATE UNIQUE INDEX idx_comm_email_txn ON communications(email_id, transaction_id) WHERE email_id IS NOT NULL AND transaction_id IS NOT NULL;
CREATE UNIQUE INDEX idx_comm_msg_txn ON communications(message_id, transaction_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_comm_thread_txn ON communications(thread_id, transaction_id) WHERE thread_id IS NOT NULL AND message_id IS NULL AND email_id IS NULL;
CREATE INDEX idx_communications_email_id ON communications(email_id);
CREATE INDEX idx_communications_message_id ON communications(message_id);
CREATE INDEX idx_communications_thread_id ON communications(thread_id);
CREATE INDEX idx_communications_transaction_id ON communications(transaction_id);
CREATE INDEX idx_communications_txn_msg ON communications(transaction_id, message_id);
CREATE INDEX idx_communications_user_id ON communications(user_id);
CREATE INDEX idx_contact_emails_contact_id ON contact_emails(contact_id);
CREATE INDEX idx_contact_emails_email ON contact_emails(email);
CREATE INDEX idx_contact_emails_email_lower ON contact_emails(LOWER(email));
CREATE INDEX idx_contact_link_proposals_pending
    ON contact_link_proposals(user_id, status, cluster_key);
CREATE INDEX idx_contact_link_verdicts_pair
    ON contact_link_verdicts(user_id, source_type, source_record_id, contact_id);
CREATE INDEX idx_contact_phones_contact_id ON contact_phones(contact_id);
CREATE INDEX idx_contact_phones_normalized ON contact_phones(phone_normalized);
CREATE INDEX idx_contact_phones_phone ON contact_phones(phone_e164);
CREATE INDEX idx_contact_source_links_contact
    ON contact_source_links(contact_id);
CREATE INDEX idx_contacts_display_name ON contacts(display_name);
CREATE INDEX idx_contacts_is_imported ON contacts(is_imported);
CREATE INDEX idx_contacts_user_id ON contacts(user_id);
CREATE INDEX idx_contacts_user_imported ON contacts(user_id, is_imported);
CREATE INDEX idx_data_clear_events_pending ON data_clear_events(cloud_synced_at) WHERE cloud_synced_at IS NULL;
CREATE INDEX idx_email_participants_address_role
  ON email_participants(email_address, role);
CREATE INDEX idx_email_participants_email_address
  ON email_participants(email_address);
CREATE INDEX idx_email_participants_email_id
  ON email_participants(email_id);
CREATE INDEX idx_email_participants_lower_address
  ON email_participants(LOWER(email_address));
CREATE INDEX idx_email_tombstones_msgid ON email_tombstones(account_id, message_id_header) WHERE message_id_header IS NOT NULL;
CREATE UNIQUE INDEX idx_emails_account_external ON emails(account_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX idx_emails_account_message_id_header ON emails(account_id, message_id_header) WHERE message_id_header IS NOT NULL;
CREATE INDEX idx_emails_derived_version_stale
             ON emails(derived_version) WHERE derived_version < 1;
CREATE INDEX idx_emails_external_id ON emails(external_id);
CREATE INDEX idx_emails_sender ON emails(sender);
CREATE INDEX idx_emails_sent_at ON emails(sent_at);
CREATE INDEX idx_emails_thread_id ON emails(thread_id);
CREATE INDEX idx_emails_user_id ON emails(user_id);
CREATE INDEX idx_emails_user_sent ON emails(user_id, sent_at);
CREATE INDEX idx_external_contacts_last_msg ON external_contacts(user_id, last_message_at DESC);
CREATE INDEX idx_external_contacts_source ON external_contacts(user_id, source);
CREATE INDEX idx_external_contacts_sync_session ON external_contacts(user_id, sync_session_id);
CREATE INDEX idx_external_contacts_user ON external_contacts(user_id);
CREATE INDEX idx_extracted_data_field ON extracted_transaction_data(field_name);
CREATE INDEX idx_extracted_data_transaction ON extracted_transaction_data(transaction_id);
CREATE INDEX idx_failure_log_acknowledged ON failure_log(acknowledged);
CREATE INDEX idx_failure_log_timestamp ON failure_log(timestamp);
CREATE INDEX idx_feedback_message ON classification_feedback(message_id);
CREATE INDEX idx_feedback_type ON classification_feedback(feedback_type);
CREATE INDEX idx_feedback_user ON classification_feedback(user_id);
CREATE INDEX idx_ignored_comms_email_id ON ignored_communications(email_id, transaction_id) WHERE email_id IS NOT NULL;
CREATE INDEX idx_ignored_comms_thread_id ON ignored_communications(thread_id, transaction_id) WHERE thread_id IS NOT NULL;
CREATE INDEX idx_ignored_comms_transaction ON ignored_communications(transaction_id);
CREATE INDEX idx_ignored_comms_user_email ON ignored_communications(user_id, email_sender, email_subject, email_sent_at);
CREATE INDEX idx_llm_settings_user ON llm_settings(user_id);
CREATE INDEX idx_message_thread_names_thread
  ON message_thread_names(thread_id);
CREATE INDEX idx_messages_assoc_guid ON messages(associated_message_guid) WHERE associated_message_type IS NOT NULL;
CREATE INDEX idx_messages_channel ON messages(channel);
CREATE INDEX idx_messages_content_hash ON messages(content_hash);
CREATE INDEX idx_messages_duplicate_of ON messages(duplicate_of);
CREATE INDEX idx_messages_external_id ON messages(external_id);
CREATE INDEX idx_messages_is_transaction_related ON messages(is_transaction_related);
CREATE INDEX idx_messages_message_id_header ON messages(message_id_header);
CREATE INDEX idx_messages_participants_flat ON messages(participants_flat);
CREATE INDEX idx_messages_sent_at ON messages(sent_at);
CREATE INDEX idx_messages_sync_session ON messages(user_id, sync_session_id);
CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_messages_transaction_id ON messages(transaction_id);
CREATE UNIQUE INDEX idx_messages_user_external_id ON messages(user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_user_sent ON messages(user_id, sent_at);
CREATE INDEX idx_oauth_tokens_user_provider ON oauth_tokens(user_id, provider, purpose);
CREATE UNIQUE INDEX idx_pending_review_txn_email
             ON pending_review_communications(transaction_id, email_id)
           WHERE email_id IS NOT NULL;
CREATE UNIQUE INDEX idx_pending_review_txn_thread
             ON pending_review_communications(transaction_id, thread_id)
           WHERE thread_id IS NOT NULL;
CREATE INDEX idx_phone_last_msg_user ON phone_last_message(user_id);
CREATE INDEX idx_sessions_token ON sessions(session_token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_stage_history_changed_at ON transaction_stage_history(changed_at);
CREATE INDEX idx_stage_history_transaction ON transaction_stage_history(transaction_id);
CREATE INDEX idx_transaction_contacts_category ON transaction_contacts(role_category);
CREATE INDEX idx_transaction_contacts_contact ON transaction_contacts(contact_id);
CREATE INDEX idx_transaction_contacts_primary ON transaction_contacts(is_primary);
CREATE INDEX idx_transaction_contacts_role ON transaction_contacts(role);
CREATE INDEX idx_transaction_contacts_specific_role ON transaction_contacts(specific_role);
CREATE INDEX idx_transaction_contacts_transaction ON transaction_contacts(transaction_id);
CREATE INDEX idx_transaction_participants_contact ON transaction_participants(contact_id);
CREATE INDEX idx_transaction_participants_role ON transaction_participants(role);
CREATE INDEX idx_transaction_participants_transaction ON transaction_participants(transaction_id);
CREATE INDEX idx_transaction_unlocks_cache_user
            ON transaction_unlocks_cache(user_id);
CREATE INDEX idx_transactions_export_status ON transactions(export_status);
CREATE INDEX idx_transactions_last_exported_on ON transactions(last_exported_on);
CREATE INDEX idx_transactions_property_address ON transactions(property_address);
CREATE INDEX idx_transactions_stage ON transactions(stage);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_submission_id ON transactions(submission_id);
CREATE INDEX idx_transactions_submission_status ON transactions(submission_status);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_users_local_email ON users_local(email);
CREATE INDEX idx_users_local_license_type ON users_local(license_type);
CREATE INDEX idx_users_local_organization ON users_local(organization_id);
CREATE TRIGGER prevent_audit_delete
          BEFORE DELETE ON audit_logs
          BEGIN
            SELECT RAISE(ABORT, 'Audit logs cannot be deleted');
          END;
CREATE TRIGGER prevent_audit_update
          BEFORE UPDATE ON audit_logs
          BEGIN
            SELECT RAISE(ABORT, 'Audit logs cannot be modified');
          END;
CREATE VIEW transaction_summary AS
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
CREATE TRIGGER update_contacts_timestamp
          AFTER UPDATE ON contacts
          BEGIN
            UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
          END;
CREATE TRIGGER update_llm_settings_timestamp
AFTER UPDATE ON llm_settings
BEGIN
  UPDATE llm_settings SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
CREATE TRIGGER update_oauth_tokens_timestamp
AFTER UPDATE ON oauth_tokens
BEGIN
  UPDATE oauth_tokens SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
CREATE TRIGGER update_transaction_contacts_timestamp
AFTER UPDATE ON transaction_contacts
BEGIN
  UPDATE transaction_contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
CREATE TRIGGER update_transaction_participants_timestamp
AFTER UPDATE ON transaction_participants
BEGIN
  UPDATE transaction_participants SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
CREATE TRIGGER update_transactions_timestamp
AFTER UPDATE ON transactions
BEGIN
  UPDATE transactions SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
CREATE TRIGGER update_users_local_timestamp
AFTER UPDATE ON users_local
BEGIN
  UPDATE users_local SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

COMMIT;
