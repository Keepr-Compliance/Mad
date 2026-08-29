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

import fs from "fs";
import path from "path";

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
    -- BACKLOG-2630 D2 piece 2: named by contactRecencySql's
    -- IMPORTED_CONTACT_LAST_COMMUNICATION_SQL, which the evidence gatherer execs
    -- verbatim rather than re-deriving. Transcribed from schema.sql.
    last_inbound_at DATETIME,
    last_outbound_at DATETIME,
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
    -- BACKLOG-2471 PR C: the compare screen's Transactions row calls the SHIPPED
    -- reader getTransactionsByContact rather than writing a second query. That
    -- reader also walks a transaction's other_contacts JSON, so a hand-rolled
    -- junction join would silently show FEWER transactions than the contact card
    -- two clicks away. These three columns are named in its SELECT
    -- (contactDbService.ts:1436-1441) and are copied from schema.sql. Their
    -- absence surfaced as an immediate "no such column", exactly as the note at
    -- the top of this file predicts, rather than as a silent wrong answer.
    closing_deadline DATETIME,
    transaction_type TEXT,
    status TEXT,
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
    -- BACKLOG-2471 PR C, same reason as the transactions columns above: named by
    -- getTransactionsByContact's junction query (contactDbService.ts:1509-1516),
    -- copied from schema.sql:722-723.
    role_category TEXT,
    specific_role TEXT,
    -- Migration v56 tombstone columns. Reads of this junction now add
    -- "AND tc.removed_at IS NULL" so a role that has been removed stops
    -- counting as current (BACKLOG-2365/2366). Fixture rows leave them NULL =
    -- active, so no assertion in these suites changes.
    removed_at DATETIME,
    removed_reason TEXT,
    UNIQUE(transaction_id, contact_id)
  );

`;


/**
 * `users_local`, TAKEN FROM `electron/database/schema.sql` AT IMPORT TIME —
 * BACKLOG-2668.
 *
 * ===========================================================================
 * WHY THIS ONE IS EXTRACTED AND THE OTHERS ARE HAND-WRITTEN
 * ===========================================================================
 * It is not a stricter standard applied for its own sake. It is the direct
 * consequence of a defect this helper CAUSED.
 *
 * The first cut of the BACKLOG-2668 gate queried `FROM users`. There is no
 * `users` table — the local table is `users_local` and has been since the
 * schema was written. In production the query threw, the gate's `catch`
 * swallowed it, and every user resolved to "off": the right answer for the
 * wrong reason, with a warning on every sync pass. IT SURVIVED A FULLY GREEN
 * SUITE BECAUSE THIS FIXTURE INVENTED A TABLE CALLED `users`.
 *
 * The surrounding tables above can be hand-written because every column they
 * carry is NAMED in a query under test, so a missing one is an immediate "no
 * such column". That protection does not extend to the TABLE NAME: a fixture
 * that invents a table makes the query reading it green forever.
 *
 * So this block is sliced out of the real schema. A table name that does not
 * exist in production now cannot pass, because there is nothing to slice.
 *
 * The slice is deliberately narrow rather than `exec`ing all of `schema.sql` —
 * the full schema declares its own `contacts`, which would collide with the
 * simplified shape above that these suites are built on.
 */
function extractUsersLocalDdl(): string {
  const schemaPath = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");

  const start = schema.indexOf("CREATE TABLE IF NOT EXISTS users_local (");
  if (start === -1) {
    throw new Error(
      "contactIdentitySchema: `users_local` is not in electron/database/schema.sql. " +
        "If the table was renamed, every reader of it is reading a table that no " +
        "longer exists — fix the readers, do not re-inline the DDL here.",
    );
  }

  const end = schema.indexOf("\n);", start);
  if (end === -1) {
    throw new Error("contactIdentitySchema: could not find the end of the `users_local` block.");
  }
  const ddl = schema.slice(start, end + 3);

  // The one column BACKLOG-2668's gate reads. Asserted loudly rather than left
  // to a downstream "no such column", because the whole point of extracting is
  // that the fixture cannot quietly disagree with production.
  if (!ddl.includes("ai_detection_enabled")) {
    throw new Error(
      "contactIdentitySchema: the extracted `users_local` DDL has no " +
        "`ai_detection_enabled` column — the slice is wrong or the column moved.",
    );
  }
  return ddl;
}

/**
 * The real `users_local`, for suites that need one.
 *
 * NOT-NULL columns it carries (`email`, `oauth_provider` with its
 * `CHECK IN ('google','microsoft')`, `oauth_id`) must be filled by the seeder.
 * That is the point: those constraints are production's, and a fixture that did
 * not satisfy them would describe a row production cannot hold.
 */
export const USERS_LOCAL_TABLE_SQL = extractUsersLocalDdl();

/**
 * Everything the contact-identity suites need, with the three identity tables
 * taken verbatim from the migration's own constants.
 */
export const CONTACT_IDENTITY_SCHEMA = [
  SURROUNDING_TABLES,
  USERS_LOCAL_TABLE_SQL,
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
  CONTACT_LINK_PROPOSALS_TABLE_SQL,
  CONTACT_LINK_PROPOSALS_INDEX_SQL,
  CONTACT_LINK_VERDICTS_TABLE_SQL,
  CONTACT_LINK_VERDICTS_INDEX_SQL,
].join("\n");
