/**
 * Contact-identity DDL — ONE definition, used by the migration AND the tests
 * (BACKLOG-2410)
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * It was created in response to an SR finding, and the finding is worth keeping
 * attached to the code rather than only in a review comment.
 *
 * The first version of this work shipped the v59 DDL in `databaseService.ts` and
 * a HAND-WRITTEN SECOND COPY of it in `__tests__/helpers/contactIdentitySchema.ts`.
 * Every service-level suite — review queue, provenance, name auto-link, linker —
 * built its in-memory database from the test copy. Nothing compared the two.
 *
 * That is a silent drift channel, and it was not theoretical: dropping the
 * proposals `UNIQUE` from the REAL migration left `contactLinkReview.test.ts`
 * fully green (27/27), because the suites were never running the real DDL. A
 * CHECK vocabulary, a constraint or a column could change in the migration while
 * every test stayed green and production behaved differently.
 *
 * ===========================================================================
 * THE RULE THIS FILE ENFORCES
 * ===========================================================================
 * These constants are the ONLY place the three contact-identity tables are
 * declared. `databaseService` migration v59 execs them; the test helper execs
 * the same strings; `databaseService.migration-v59.test.ts` additionally asserts
 * that a database built by the real migration and one built by the helper have
 * byte-identical `sqlite_master.sql` for all three tables and their indexes — so
 * if anyone ever re-inlines DDL on either side, that test goes red.
 *
 * DO NOT transcribe these statements anywhere else. Import them.
 *
 * ===========================================================================
 * WHY IT LIVES IN `db/` AND NOT IN THE TEST FOLDER
 * ===========================================================================
 * Production is the owner. A test helper that owns the schema and a migration
 * that copies it is the same duplication with the arrow reversed — it would
 * still be two definitions, and the wrong one would be authoritative.
 *
 * `contactSourceLinkSql.ts` already establishes SQL-constants-beside-the-service
 * as the convention here.
 */

/**
 * `contact_source_links` at its v59 shape.
 *
 * v57 (BACKLOG-2401) created this table with a five-value `match_method` CHECK.
 * v59 rebuilds it to admit `unique_name` — SQLite cannot ALTER a CHECK — so this
 * constant is the POST-rebuild shape and is what both a fresh chain replay and a
 * v57->v59 upgrade must converge on.
 *
 * The `{{TABLE}}` placeholder exists solely for the rebuild, which has to create
 * the new table under a temporary name before renaming it over the old one.
 * Everywhere else it is substituted with the real name. It is a placeholder
 * rather than string concatenation so the column list cannot drift between the
 * two uses — which is the entire point of this file.
 */
const CONTACT_SOURCE_LINKS_TEMPLATE = `
  CREATE TABLE IF NOT EXISTS {{TABLE}} (
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
`;

export const CONTACT_SOURCE_LINKS_TABLE_SQL = CONTACT_SOURCE_LINKS_TEMPLATE.replace(
  "{{TABLE}}",
  "contact_source_links",
);

/** The rebuild's scratch table. Same columns, by construction. */
export function contactSourceLinksRebuildTableSql(tempName: string): string {
  return CONTACT_SOURCE_LINKS_TEMPLATE.replace("{{TABLE}}", tempName);
}

/**
 * EVERY column of `contact_source_links`, in declaration order.
 *
 * THIS LIST IS THE REBUILD'S SAFETY. `INSERT INTO ... SELECT` names these on
 * both sides so the copy is BY NAME, never positional. A positional copy is what
 * corrupted `audit_logs` in v33 and `contacts` in v36, and it cannot be caught by
 * a row count — the rows are all there, holding each other's values.
 *
 * `databaseService.migration-v59.test.ts` seeds a v57 table with two columns
 * DECLARED IN A DIFFERENT ORDER and asserts the copy still lands field for
 * field. Under `SELECT *` that test fails with a CHECK violation.
 */
export const CONTACT_SOURCE_LINKS_COLUMNS = [
  "id",
  "user_id",
  "contact_id",
  "source_type",
  "source_record_id",
  "external_uuid",
  "match_method",
  "confidence",
  "matched_at",
  "evidence_ref",
  "created_at",
  "updated_at",
] as const;

/**
 * Contact -> its source records. The UNIQUE constraint's auto-index already
 * serves the reverse direction, which is the hot resolution path.
 */
export const CONTACT_SOURCE_LINKS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_source_links_contact
    ON contact_source_links(contact_id);
`;

/**
 * `contact_link_proposals` — the review queue. DERIVED state: recomputed by
 * every linking pass, and losing it costs one sync.
 *
 * The pair UNIQUE is load-bearing and is the ONLY thing stopping an UNANSWERED
 * question being appended again on every sync — measured, not assumed: removing
 * it fails exactly one test, and the queue grows without bound.
 */
export const CONTACT_LINK_PROPOSALS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS contact_link_proposals (
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
`;

export const CONTACT_LINK_PROPOSALS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_link_proposals_pending
    ON contact_link_proposals(user_id, status, cluster_key);
`;

/**
 * `contact_link_verdicts` — the answers. NOT derived, and unrecoverable: there
 * is no second source of ground truth anywhere in this system, and nothing can
 * regenerate a person's opinion.
 *
 * NO FOREIGN KEY TO `contacts`, DELIBERATELY. Proposals cascade because a
 * question about a deleted contact is noise. A VERDICT about that contact is
 * evidence, and "these two are different people" stays true after the contact
 * row is tombstoned. An ON DELETE CASCADE here would quietly delete the labelled
 * set as a side effect of ordinary contact cleanup.
 *
 * No UNIQUE on the pair either — a user may answer the same pair twice, and both
 * answers are history. The LATEST one is the constraint, resolved at read time.
 */
export const CONTACT_LINK_VERDICTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS contact_link_verdicts (
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
`;

export const CONTACT_LINK_VERDICTS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_link_verdicts_pair
    ON contact_link_verdicts(user_id, source_type, source_record_id, contact_id);
`;

/**
 * The three tables and their indexes, in dependency order.
 *
 * Used by the test helper to build an in-memory database, and by the parity
 * assertion to prove the migration produces exactly this.
 */
export const CONTACT_IDENTITY_TABLES = [
  "contact_source_links",
  "contact_link_proposals",
  "contact_link_verdicts",
] as const;
