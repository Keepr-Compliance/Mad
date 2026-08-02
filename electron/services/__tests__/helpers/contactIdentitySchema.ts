/**
 * The production table shapes the contact-identity feature set touches
 * (BACKLOG-2401 crosswalk + BACKLOG-2410 review queue, verdicts and provenance).
 *
 * Kept in ONE place so the crosswalk suite, the review-queue suite, the name
 * rule and the provenance suite all run against the same DDL. Four hand-copied
 * schemas drift, and a suite testing a shape the migration does not produce is a
 * suite that passes for the wrong reason — a failure mode this workstream has
 * already hit six times.
 *
 * These statements are transcribed from `databaseService.MIGRATIONS` v57/v58.
 * `contact_source_links.match_method` carries the v58 CHECK including
 * `unique_name`; if you change the migration and not this, the name rule's link
 * write will pass here and throw in production.
 */

export const CONTACT_IDENTITY_SCHEMA = `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    source TEXT DEFAULT 'manual',
    is_imported INTEGER DEFAULT 1,
    removed_at DATETIME,
    removed_reason TEXT
  );

  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,
    UNIQUE(contact_id, email)
  );

  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    phone_normalized TEXT,
    is_primary INTEGER DEFAULT 0,
    UNIQUE(contact_id, phone_e164)
  );

  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    phones_json TEXT,
    phones_normalized_json TEXT,
    emails_json TEXT,
    company TEXT,
    external_record_id TEXT,
    source TEXT DEFAULT 'macos',
    synced_at DATETIME,
    external_uuid TEXT,
    UNIQUE(user_id, source, external_record_id)
  );

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    property_address TEXT,
    first_exported_at DATETIME,
    buyer_agent_id TEXT,
    seller_agent_id TEXT,
    escrow_officer_id TEXT,
    inspector_id TEXT,
    other_contacts TEXT
  );

  CREATE TABLE transaction_contacts (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    role TEXT,
    UNIQUE(transaction_id, contact_id)
  );

  CREATE TABLE contact_source_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT NOT NULL,
    external_uuid TEXT,
    match_method TEXT NOT NULL CHECK (
      match_method IN ('source_id', 'email', 'phone', 'unique_name', 'manual', 'scored')
    ),
    confidence REAL,
    matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    evidence_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE (user_id, source_type, source_record_id)
  );
  CREATE INDEX idx_contact_source_links_contact ON contact_source_links(contact_id);

  CREATE TABLE contact_link_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT NOT NULL,
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
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE (user_id, contact_id, source_type, source_record_id)
  );
  CREATE INDEX idx_contact_link_proposals_pending
    ON contact_link_proposals(user_id, status, cluster_key);

  CREATE TABLE contact_link_verdicts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT NOT NULL,
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
    decided_by TEXT NOT NULL DEFAULT 'user'
  );
  CREATE INDEX idx_contact_link_verdicts_pair
    ON contact_link_verdicts(user_id, source_type, source_record_id, contact_id);
`;
