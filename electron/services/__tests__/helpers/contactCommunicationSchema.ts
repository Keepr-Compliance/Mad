/**
 * The three communication tables the compare screen reads (BACKLOG-2471 PR C).
 *
 * ===========================================================================
 * TRANSCRIBED FROM THE PRODUCER, NOT WRITTEN FROM MEMORY
 * ===========================================================================
 * Copied from `electron/database/schema.sql` — `messages` at :233, `emails` at
 * :361, `email_participants` at :464 — carrying the columns these queries name
 * plus every CHECK that can REJECT a row. Same rule, and the same reason, as
 * `contactIdentitySchema.ts`: a fixture that accepts what production refuses is
 * a fixture that can only prove things about itself.
 *
 * The CHECKs matter here specifically. `messages.channel IN ('email','sms',
 * 'imessage')` is what the compare reader filters on; a fixture without it would
 * happily store `channel = 'text'`, the filter would drop the row, and the test
 * would report "no communication" for a reason that cannot happen in the app.
 *
 * `email_participants.role` is likewise real: the reader matches on
 * `email_address` regardless of role, and the CHECK is what proves a fixture
 * row is one the parser could actually have produced.
 *
 * Columns deliberately omitted are the classification, LLM, attachment and sync
 * columns — none is read by this feature, and reproducing them would make this
 * a second copy of the database rather than a fixture.
 */

export const CONTACT_COMMUNICATION_SCHEMA = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    channel_account_id TEXT,
    external_id TEXT,
    channel TEXT CHECK (channel IN ('email', 'sms', 'imessage')),
    direction TEXT CHECK (direction IN ('inbound', 'outbound')),
    subject TEXT,
    body_html TEXT,
    body_text TEXT,
    participants TEXT,
    participants_flat TEXT,
    thread_id TEXT,
    sent_at DATETIME,
    received_at DATETIME,
    has_attachments INTEGER DEFAULT 0,
    transaction_id TEXT,
    duplicate_of TEXT,
    message_type TEXT CHECK (message_type IS NULL OR message_type IN ('text', 'voice_message', 'location', 'attachment_only', 'system', 'unknown')),
    associated_message_type INTEGER,
    associated_message_guid TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    external_id TEXT,
    source TEXT CHECK (source IN ('gmail', 'outlook')),
    account_id TEXT,
    direction TEXT CHECK (direction IN ('inbound', 'outbound')),
    subject TEXT,
    body_plain TEXT,
    body_html TEXT,
    sender TEXT,
    recipients TEXT,
    cc TEXT,
    bcc TEXT,
    thread_id TEXT,
    sent_at DATETIME,
    received_at DATETIME,
    has_attachments INTEGER DEFAULT 0,
    attachment_count INTEGER DEFAULT 0
  );

  CREATE TABLE email_participants (
    email_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'bcc')),
    position INTEGER NOT NULL,
    participant_hash TEXT NOT NULL,
    email_address TEXT NOT NULL,
    display_name TEXT,
    resolved_contact_id TEXT,
    PRIMARY KEY (email_id, role, position),
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_email_participants_email_address
    ON email_participants(email_address);
`;
