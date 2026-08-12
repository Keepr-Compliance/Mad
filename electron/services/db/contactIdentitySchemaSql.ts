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
 * THE TWO KINDS OF LINK, AND WHY THE DIFFERENCE IS LOAD-BEARING (BACKLOG-2473)
 * ===========================================================================
 * After v61 a crosswalk row is one of two things, and conflating them breaks
 * address resolution for every contact in the database:
 *
 *   RECORD-BACKED — `match_method` is anything but `origin`. The row claims a
 *     specific row in `external_contacts`: this contact IS that macOS card /
 *     that Outlook record. It has a real `source_record_id` and it JOINs.
 *
 *   ORIGIN — `match_method = 'origin'`. The row states WHERE THE CONTACT CAME
 *     FROM and nothing more: typed in by hand, or inferred from an email or
 *     text thread. There is no external record to point at, so it never JOINs
 *     and never contributes an address.
 *
 * Origin rows exist so that "where did this contact come from" has exactly ONE
 * answer for every contact, instead of being read from the crosswalk for
 * imported contacts and from the `contacts.source` scalar for everyone else.
 *
 * THE TRAP. `contactSourceLinkSql.CONTACT_SOURCE_RECORDS_SQL` enables its
 * email/phone content fallback only for a contact with NO crosswalk rows. Give
 * every contact an origin row without teaching that query the difference and
 * the fallback switches off universally — every contact that today gets its
 * addresses by content-matching against `external_contacts` silently stops.
 * That query therefore excludes `origin` explicitly. See ORIGIN_MATCH_METHOD.
 */

/**
 * The `match_method` that marks a row as ORIGIN rather than record-backed.
 *
 * Read by `CONTACT_SOURCE_RECORDS_SQL` (to keep the content fallback alive) and
 * by `contactProvenance.unlinkContactSource` (to refuse the unlink). Exported as
 * a constant so those two and the migration cannot drift on the spelling.
 */
export const ORIGIN_MATCH_METHOD = "origin";

/**
 * `source_type` values that can ONLY ever appear on an origin row, because no
 * `external_contacts` record is ever written with them. `macos` is deliberately
 * absent: a `contacts_app` contact's origin IS the macOS address book, so its
 * origin row is `macos` and is distinguished from a real macOS card by
 * `match_method`, not by source type.
 */
export const ORIGIN_ONLY_SOURCE_TYPES = ["manual", "email", "sms", "inferred"] as const;

/**
 * `contact_source_links` at its v61 shape.
 *
 * v57 (BACKLOG-2401) created this table with a five-value `match_method` CHECK.
 * v59 rebuilt it to admit `unique_name`. v61 (BACKLOG-2473) rebuilds it again to
 * admit the origin vocabulary — SQLite cannot ALTER a CHECK — so this constant is
 * the POST-v61 shape and is what a fresh chain replay, a v57->v61 upgrade and a
 * v59->v61 upgrade must all converge on.
 *
 * The `source_type` vocabulary is NOT invented: it is exactly what the
 * `contacts.source` CHECK admits (`databaseService.ts` v48 / `schema.sql`),
 * mapped through `contactOriginLink.ORIGIN_SOURCE_TYPE_BY_CONTACT_SOURCE`.
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
`;

export const CONTACT_SOURCE_LINKS_TABLE_SQL = CONTACT_SOURCE_LINKS_TEMPLATE.replace(
  "{{TABLE}}",
  "contact_source_links",
);

/**
 * The rebuild's scratch table. Same columns, by construction.
 *
 * ===========================================================================
 * BOTH v59 AND v61 CALL THIS, AND IT ALWAYS DESCRIBES THE *CURRENT* SHAPE
 * ===========================================================================
 * NOT A BUG, BUT IT LOOKS LIKE ONE FROM TWO DIFFERENT DIRECTIONS, SO:
 *
 * There is one template, so an OLDER migration's rebuild produces the NEWEST
 * shape. Replay the chain from scratch today and v59's rebuild already emits the
 * v61 vocabulary; v61 then finds `'origin'` present and correctly no-ops.
 *
 * Every route still converges on ONE final shape — which is exactly what the
 * `sqlite_master.sql` parity assertions in the v59 and v61 tests enforce — so
 * fresh installs, a v57 upgrade and a v60 upgrade all end up identical. That
 * convergence is the property worth having, and freezing a historical copy of
 * this DDL per migration would trade it for the duplication this whole file
 * exists to eliminate.
 *
 * THE CONSEQUENCE THAT MATTERS FOR TESTS. A chain replayed with current code is
 * NOT the database a shipped install has: a real v60 install ran v59 against the
 * code as it was then, so its crosswalk still carries the narrow five-value
 * CHECK. A test that wants the genuine pre-migration state must reconstruct it
 * from the historical DDL rather than assume the chain produces it — see
 * `databaseService.onDiskUpgrade.test.ts`, "v61 widens the crosswalk vocabulary
 * on a REAL old database". BACKLOG-2298 is the incident where exactly this gap
 * between "what the fixture builds" and "what the user has" hid a migration
 * defect from every CI suite.
 */
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
 *
 * ITS `source_type` CHECK STAYS AT THE FIVE EXTERNAL VALUES, deliberately
 * (BACKLOG-2473). A proposal about a SOURCE RECORD asks "is this contact the same
 * person as this EXTERNAL RECORD?". There is no external record behind an origin
 * row and no question to ask about one, so `manual`/`email`/`sms`/`inferred` must
 * never reach this table — and the narrow CHECK is what enforces that rather than
 * leaving it to convention. `databaseService.migration-v61.test.ts` asserts the
 * refusal in both directions.
 *
 * ===========================================================================
 * v64 (BACKLOG-2609) — THE SUBJECT OF A QUESTION IS NO LONGER ALWAYS A RECORD
 * ===========================================================================
 * Until v64 every proposal's subject was a source record BY CHECK AND BY NOT
 * NULL. That made "are these two saved contacts one person?" — the question
 * BACKLOG-2616 is built on — literally unrepresentable, and SQLite cannot ALTER
 * a CHECK, so admitting it is a table rebuild.
 *
 * ONE WIDENING, FOUR CONSUMERS. `subject_kind` is polymorphic rather than
 * bespoke because four filed items need the same shape and paying for it once is
 * the whole point: BACKLOG-2675 (your own record changed — apply?),
 * BACKLOG-2616 (are these two contacts one person?), BACKLOG-2674 (six identical
 * records — merge?) and BACKLOG-2630 (any band-triggered question).
 * `contact_source_links` was rebuilt THREE times (v57 → v59 → v61) for exactly
 * this reason; this is the fourth rebuild avoided rather than the fourth
 * incurred.
 *
 * THE THREE KINDS:
 *
 *   `source_record`      the pre-v64 question, and the DEFAULT. Subject is a row
 *                        in `external_contacts`: `source_type` + `source_record_id`
 *                        are required, `target_contact_id` must be NULL.
 *   `contact`            subject is another SAVED CONTACT. `target_contact_id` is
 *                        required; the two source columns must be NULL.
 *   `own_record_change`  the user's own record changed — apply? Source-backed
 *                        like `source_record`, and deliberately defined NARROWLY
 *                        NOW: a CHECK loosened later is the fourth rebuild this
 *                        table exists to avoid.
 *
 * DIRECTION IS STORED, AND BACKLOG-2611 CANNOT WORK WITHOUT IT. The founder's
 * merge rule (12 Aug, `pm_comments` on BACKLOG-2611) is asymmetric: single-valued
 * fields — name, company, role — take **A**, the contact the duplicate was found
 * FOR; multi-valued fields are the union. So the pair is ORDERED, not a set:
 *
 *     contact_id        = A, the incumbent, the subject of the question
 *     target_contact_id = B, the record found to be A's duplicate
 *
 * *"a stored proposal that only names a pair, without saying which side was the
 * subject, cannot be executed by this rule later."* `CHECK (target_contact_id <>
 * contact_id)` forbids the degenerate self-pair.
 *
 * WHY `subject_kind` IS IN THE UNIQUE TUPLE. So an `own_record_change` question
 * and a `source_record` question about the same (contact, record) pair can both
 * exist — they are different questions. Every pre-v64 row and every INSERT that
 * omits the column defaults to `'source_record'`, so existing dedup behaviour is
 * bit-for-bit what it was.
 *
 * WHY THE CONTACT KIND NEEDS A SEPARATE INDEX — the trap that would have made
 * this widening silently useless: SQLite treats NULLs as DISTINCT in a UNIQUE
 * constraint. A `contact`-kind row has both source columns NULL, so the table
 * UNIQUE above cannot dedup it, and the same unanswered "are these two one
 * person?" would be appended on EVERY sync — precisely the unbounded growth the
 * UNIQUE was added to prevent. `CONTACT_LINK_PROPOSALS_CONTACT_PAIR_INDEX_SQL`
 * closes that hole with a partial unique index.
 *
 * WHY A PARTIAL INDEX IS SAFE HERE, verified rather than assumed: the sole
 * production writer is `contactLinkReviewDbService.proposeLink` and it uses
 * `INSERT OR IGNORE`, which honours any unique index. There is NO `ON CONFLICT`
 * clause against this table anywhere in the repo — enumerated with `git grep -a`,
 * which reads binary files, so a NUL-poisoned source could not have hidden one
 * (the `contactManualLink.ts` failure mode, BACKLOG-2637).
 *
 * THAT ENUMERATION IS LOAD-BEARING TWICE, not once:
 *
 *   1. A bare `ON CONFLICT (user_id, contact_id, target_contact_id)` fails at
 *      PREPARE time against a partial index — "ON CONFLICT clause does not match
 *      any PRIMARY KEY or UNIQUE constraint".
 *   2. The LEGACY tuple `ON CONFLICT (user_id, contact_id, source_type,
 *      source_record_id)` now fails the same way, because v64 inserted
 *      `subject_kind` into the UNIQUE. So the enumeration is also the only thing
 *      that makes the tuple change itself safe.
 *
 * THE SAFETY ARGUMENT IS SCOPED TO TODAY'S WRITERS, NOT ALL FUTURE ONES, and the
 * distinction matters because the obvious reading is wrong: a partial index CAN
 * be targeted, by repeating its predicate. `ON CONFLICT (user_id, contact_id,
 * target_contact_id) WHERE subject_kind = 'contact' DO ...` is ACCEPTED. A future
 * writer wanting upsert semantics on the contact kind has that door open; it just
 * has to name the WHERE.
 *
 * The `{{TABLE}}` placeholder exists solely for the rebuild, which creates the
 * new table under a temporary name before renaming it over the old one — the same
 * mechanism, and the same reason, as `CONTACT_SOURCE_LINKS_TEMPLATE` above.
 */
const CONTACT_LINK_PROPOSALS_TEMPLATE = `
  CREATE TABLE IF NOT EXISTS {{TABLE}} (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL DEFAULT 'source_record' CHECK (
      subject_kind IN ('source_record', 'contact', 'own_record_change')
    ),
    source_type TEXT CHECK (
      source_type IS NULL OR
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT,
    target_contact_id TEXT,
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
    FOREIGN KEY (target_contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    CHECK (
      (subject_kind IN ('source_record', 'own_record_change')
        AND source_type IS NOT NULL
        AND source_record_id IS NOT NULL
        AND target_contact_id IS NULL)
      OR
      (subject_kind = 'contact'
        AND source_type IS NULL
        AND source_record_id IS NULL
        AND target_contact_id IS NOT NULL)
    ),
    CHECK (target_contact_id IS NULL OR target_contact_id <> contact_id),
    UNIQUE (user_id, contact_id, subject_kind, source_type, source_record_id)
  );
`;

export const CONTACT_LINK_PROPOSALS_TABLE_SQL = CONTACT_LINK_PROPOSALS_TEMPLATE.replace(
  "{{TABLE}}",
  "contact_link_proposals",
);

/**
 * The v64 rebuild's scratch table. Same columns, by construction.
 *
 * Like `contactSourceLinksRebuildTableSql`, this always describes the CURRENT
 * shape, so replaying the chain from scratch has v59 already emit the v64 table
 * and v64 correctly no-op. Every route converges on one final shape; the
 * `sqlite_master.sql` parity assertions are what enforce that.
 */
export function contactLinkProposalsRebuildTableSql(tempName: string): string {
  return CONTACT_LINK_PROPOSALS_TEMPLATE.replace("{{TABLE}}", tempName);
}

/**
 * The columns a PRE-v64 `contact_link_proposals` has, in declaration order.
 *
 * THIS IS THE REBUILD'S SAFETY, and it is the OLD list on purpose: the table
 * being copied FROM does not have `subject_kind` or `target_contact_id`, so the
 * copy must name only what exists on both sides. `INSERT INTO ... SELECT` lists
 * these explicitly on both sides so the copy is BY NAME, never positional — a
 * positional `SELECT *` is what corrupted `audit_logs` in v33 and `contacts` in
 * v36, and no row count can detect it because every row is present, holding its
 * neighbour's value.
 */
export const CONTACT_LINK_PROPOSALS_LEGACY_COLUMNS = [
  "id",
  "user_id",
  "contact_id",
  "source_type",
  "source_record_id",
  "status",
  "reason",
  "matched_on",
  "identity_assessment",
  "relationship_assessment",
  "cluster_key",
  "evidence_json",
  "created_at",
  "resolved_at",
] as const;

export const CONTACT_LINK_PROPOSALS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_link_proposals_pending
    ON contact_link_proposals(user_id, status, cluster_key);
`;

/**
 * Dedup for `contact`-kind proposals, which the table UNIQUE cannot reach.
 *
 * See the NULL-distinctness note in the table's docblock: without this index the
 * same unanswered contact-to-contact question is appended on every pass. It is
 * PARTIAL so it constrains only the kind whose columns it names, leaving the
 * source-backed kinds entirely to the table UNIQUE.
 *
 * Created by migration v64 UNCONDITIONALLY (it is `IF NOT EXISTS`), outside the
 * rebuild guard — on a fresh chain replay v59 already emits the v64 table shape,
 * so v64's rebuild correctly no-ops and this index would otherwise never be
 * created on a new install.
 */
export const CONTACT_LINK_PROPOSALS_CONTACT_PAIR_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_link_proposals_contact_pair
    ON contact_link_proposals(user_id, contact_id, target_contact_id)
    WHERE subject_kind = 'contact';
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
 *
 * `source_type` STAYS AT THE FIVE EXTERNAL VALUES for the same reason the
 * proposals table does (BACKLOG-2473): a verdict is an answer about an external
 * record. `unlinkContactSource` writes one, which is precisely why that function
 * must REFUSE an origin link — see the guard there.
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
