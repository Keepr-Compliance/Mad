/**
 * In-memory schema for the contact-identity suites (BACKLOG-2401 crosswalk +
 * BACKLOG-2410 review queue, verdicts and provenance).
 *
 * ===========================================================================
 * THE THREE IDENTITY TABLES ARE NOT DECLARED HERE — THEY ARE IMPORTED
 * ===========================================================================
 * This file used to hand-write the v59 DDL a second time, and every service
 * suite ran against that copy rather than against the migration. The two could
 * drift silently, and did: dropping the proposals `UNIQUE` from the real
 * migration left `contactLinkReview.test.ts` fully green at 27/27, because the
 * suites were never executing the real statement. Found in SR review of #2183.
 *
 * `contact_source_links`, `contact_link_proposals` and `contact_link_verdicts`
 * now come from `db/contactIdentitySchemaSql.ts` — the same constants migration
 * v59 execs. `databaseService.migration-v59.test.ts` additionally asserts that a
 * database built by the real migration and one built by this helper have
 * identical `sqlite_master.sql` for all three tables and their indexes, so
 * re-inlining DDL on either side goes red.
 *
 * ===========================================================================
 * THE SURROUNDING TABLES ARE STILL SIMPLIFIED, DELIBERATELY
 * ===========================================================================
 * `contacts`, `contact_emails`, `contact_phones`, `external_contacts`,
 * `transactions` and `transaction_contacts` below are MINIMAL shapes carrying
 * only the columns these suites read. They are owned by `schema.sql` and by
 * migrations far older than this work, and reproducing them in full would make
 * this helper a second copy of the whole database.
 *
 * That is a smaller risk than the one above, and it is not zero: a column added
 * to `contacts` that this feature later reads would need adding here too. It is
 * bounded by every column being NAMED in the queries under test — a missing one
 * is an immediate "no such column", not a silent wrong answer.
 */

import {
  CONTACT_LINK_PROPOSALS_INDEX_SQL,
  CONTACT_LINK_PROPOSALS_TABLE_SQL,
  CONTACT_LINK_VERDICTS_INDEX_SQL,
  CONTACT_LINK_VERDICTS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
  CONTACT_SOURCE_LINKS_TABLE_SQL,
} from "../../db/contactIdentitySchemaSql";

/** Minimal shapes for the tables this feature reads but does not own. */
const SURROUNDING_TABLES = `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    -- BACKLOG-2427: written by the real createContact, which the typed-value
    -- provenance suite drives end to end instead of stubbing.
    title TEXT,
    -- BACKLOG-2473: the CHECK here is REAL, copied from the v48 constraint in
    -- electron/database/schema.sql, and it is not decoration.
    --
    -- Without it this fixture accepts ANY string, so every suite built on it is
    -- blind to a write production would REJECT. That is precisely what let the
    -- 'messages' inconsistency stay invisible: the validSources allow-list in
    -- contactHandlers admits 'messages', the real CHECK never has, and a
    -- contacts:create carrying it fails outright — while the tests passed,
    -- because the fixture stored it happily.
    --
    -- Kept in step with schema.sql by
    -- src/utils/__tests__/contactFilterModel.vocabularyCoverage.test.ts, which
    -- reads that file and asserts the same vocabulary.
    source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'email', 'sms', 'contacts_app', 'inferred', 'android_sync', 'iphone', 'outlook', 'google_contacts')),
    is_imported INTEGER DEFAULT 1,
    removed_at DATETIME,
    removed_reason TEXT
  );

  -- BACKLOG-2427: 'source' added to both tables to match
  -- electron/database/schema.sql. It is not decoration — it is the column that
  -- decides whether an unlink may take a value back, because it distinguishes a
  -- value the BACKFILL copied ('import') from one the USER TYPED ('manual').
  -- A fixture without it cannot express the guarantee that rejecting a source
  -- never deletes what the user typed. Existing inserts omit it and get NULL,
  -- which reads as unknown provenance and is therefore never removed.
  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,
    source TEXT CHECK (source IN ('import', 'manual', 'inferred')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contact_id, email)
  );

  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    phone_display TEXT,
    phone_normalized TEXT,
    is_primary INTEGER DEFAULT 0,
    source TEXT CHECK (source IN ('import', 'manual', 'inferred')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
`;

/**
 * Everything the contact-identity suites need, with the three identity tables
 * taken verbatim from the migration's own constants.
 */
export const CONTACT_IDENTITY_SCHEMA = [
  SURROUNDING_TABLES,
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
  CONTACT_LINK_PROPOSALS_TABLE_SQL,
  CONTACT_LINK_PROPOSALS_INDEX_SQL,
  CONTACT_LINK_VERDICTS_TABLE_SQL,
  CONTACT_LINK_VERDICTS_INDEX_SQL,
].join("\n");
