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
 * THE TRAP, retired by BACKLOG-2669 but recorded because it is the reason to be
 * careful with this row. `contactSourceLinkSql.CONTACT_SOURCE_RECORDS_SQL` used
 * to enable an email/phone content fallback for a contact with NO crosswalk
 * rows. Giving every contact an origin row without teaching that query the
 * difference would have switched the fallback off universally — every contact
 * getting its addresses by content-matching against `external_contacts` would
 * have silently stopped. That query excluded `origin` explicitly for that
 * reason; its content branches are now deleted, so it reads linked records only
 * and the trap has nothing left to spring on. Any query that ever asks "does
 * this contact have a crosswalk row?" as a proxy for "is it linked to a source
 * record?" inherits the trap. See ORIGIN_MATCH_METHOD.
 */

/**
 * The `match_method` that marks a row as ORIGIN rather than record-backed.
 *
 * Read by `contactSourceLinker.resolveSourceRecord` (an origin row is not a
 * claim on a source record, so it cannot conflict with one) and by
 * `contactProvenance.unlinkContactSource` (to refuse the unlink). It was also
 * read by `CONTACT_SOURCE_RECORDS_SQL` until BACKLOG-2669 deleted the content
 * fallback that needed it. Exported as a constant so its readers and the
 * migration cannot drift on the spelling.
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
 * The pair-shape vocabulary shared by `contact_link_proposals` (the questions)
 * and `contact_link_verdicts` (the answers).
 *
 * ===========================================================================
 * THREE SHAPES, BECAUSE SQLITE CANNOT ALTER A CONSTRAINT IN PLACE
 * ===========================================================================
 * A row in either table names TWO ENDPOINTS. Each endpoint is either a SAVED
 * CONTACT or an EXTERNAL RECORD, which gives three shapes:
 *
 *   record_contact   a record and a saved contact — the ONLY shape these tables
 *                    could express before v69, and the only shape anything
 *                    writes today. Endpoint A is `contact_id`; endpoint B is
 *                    (`source_type`, `source_record_id`).
 *   record_record    two external records, NO CONTACT ON EITHER SIDE. Endpoint A
 *                    is (`source_type`, `source_record_id`), endpoint B is
 *                    (`target_source_type`, `target_source_record_id`); both
 *                    contact columns are NULL. (BACKLOG-2665.)
 *   contact_contact  two saved contacts, NO SOURCE RECORD ON EITHER SIDE.
 *                    Endpoint A is `contact_id`, endpoint B is
 *                    `target_contact_id`; all four source columns are NULL.
 *                    (BACKLOG-2616 / 2369.)
 *
 * THE TWO NEW SHAPES HAVE NO WRITER, DELIBERATELY. Founder decision 2026-08-27,
 * "yeah i agree schema first split": the SHAPE ships now, the matcher that fills
 * it waits on a measurement nobody has taken (how many candidate pairs have BOTH
 * sides unimported). A test may insert such a row directly to prove the shape
 * holds; PRODUCTION CODE MUST NOT CREATE ONE until D3/2616 are authorised.
 *
 * WHY BOTH NEW SHAPES LAND IN ONE REBUILD, AND WHY NOW — this is a
 * REVERSIBILITY argument, not a value argument. SQLite cannot ALTER a CHECK or
 * a NOT NULL, so any change here is a full table rebuild. v69 is already
 * performing that rebuild; adding the shapes while the tables are open is nearly
 * free. Discovering later that they are needed costs another rebuild and another
 * migration on every user's database.
 *
 * NO SENTINEL CONTACT ROW. A record-to-record pair genuinely has NULL on both
 * contact columns. Pointing them at a placeholder contact would trade a schema
 * problem for a data problem that every reader of `contacts` inherits.
 */
export const CONTACT_LINK_PAIR_KINDS = [
  "record_contact",
  "record_record",
  "contact_contact",
] as const;

export type ContactLinkPairKind = (typeof CONTACT_LINK_PAIR_KINDS)[number];

/**
 * `pair_key` — the canonical UNORDERED pair, COMPUTED BY THE DATABASE.
 *
 * ===========================================================================
 * A GENERATED COLUMN, NOT A CONVENTION — AND THAT IS THE POINT
 * ===========================================================================
 * Founder ruling, BACKLOG-2616, 13 Aug: shown that one pair could generate two
 * questions with opposite incumbents, he said "yes we need to stop that". So
 * there is ONE ROW PER UNORDERED PAIR.
 *
 * A conventional key enforced at the call sites is only as good as the last
 * caller's memory. `GENERATED ALWAYS AS ... STORED` removes the caller from the
 * loop: the key cannot be forged, mis-ordered, or forgotten, because no INSERT
 * ever supplies it. Each endpoint renders to a token — `c:<contact id>` for a
 * contact, `r:<source type>:<source record id>` for a record — and the two
 * tokens are SORTED before joining, so A|B and B|A are the same key and the
 * second direction is refused by `UNIQUE (user_id, pair_key)`.
 *
 * For `record_contact` the sort is a no-op: 'c' sorts before 'r', so the contact
 * token is always first. That shape has no ordering ambiguity to begin with —
 * a record can only ever be the source columns and a contact only `contact_id`.
 *
 * `min()`/`max()` are the two-argument scalar forms and are deterministic, which
 * is what SQLite requires of a generated-column expression.
 *
 * CONSEQUENCE FOR THE REBUILD: a generated column CANNOT BE WRITTEN, so
 * `pair_key` is absent from both COLUMNS lists and from both sides of the
 * rebuild's `INSERT ... SELECT`. Naming it there is an immediate error, not a
 * silent wrong answer.
 */
const PAIR_KEY_GENERATED_COLUMN = `
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
    ) STORED`;

/**
 * The kind-conditional shape CHECK, shared by both tables.
 *
 * `contact_id`, `source_type` and `source_record_id` lose their column-level
 * `NOT NULL` — they have to, because a record-to-record pair has no contact and
 * a contact-to-contact pair has no record. They REGAIN it per shape here, so a
 * `record_contact` row is constrained EXACTLY as it was before v69 and the
 * existing shape cannot regress.
 *
 * `subject_side` is pinned to 'a' for `record_contact` because the subject of
 * that question is the contact — the incumbent the duplicate was found FOR.
 * It is left FREE for the two new shapes: D3 decides the incumbent at emission
 * and records it here, and a CHECK forbidding a value now would force exactly
 * the third rebuild this slice exists to avoid.
 */
const PAIR_SHAPE_CHECK = `
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
    )`;

/**
 * `contact_link_proposals` — the review queue. DERIVED state: recomputed by
 * every linking pass, and losing it costs one sync.
 *
 * ===========================================================================
 * THE DUPLICATE-QUESTION GUARD, AND HOW v69 PRESERVES IT FOR ALL THREE SHAPES
 * ===========================================================================
 * The pair UNIQUE is load-bearing and is the ONLY thing stopping an UNANSWERED
 * question being appended again on every sync — measured, not assumed: removing
 * it fails exactly one test, and the queue grows without bound.
 *
 * TWO uniques now stand, and each earns its place:
 *
 *  1. `UNIQUE (user_id, contact_id, source_type, source_record_id)` — THE
 *     ORIGINAL, KEPT VERBATIM. It is what makes "record <-> contact still works
 *     exactly as before" provable rather than argued: the text is still here.
 *     For the two new shapes its columns are NULL, and SQLite treats NULLs as
 *     DISTINCT, so it neither constrains nor rejects them.
 *  2. `UNIQUE (user_id, pair_key)` — the uniform guard, covering all three
 *     shapes, and the one that makes the unordered-pair ruling structural.
 *
 * STATED HONESTLY: while (2) stands, deleting (1) reds nothing, because
 * `pair_key` already collapses the same triple to the same string. (1) is
 * retained as defence-in-depth for the incident its own history records. The
 * mutation that discriminates the guard is therefore against (2).
 *
 * BOTH ARE TABLE-LEVEL CONSTRAINTS, NOT SEPARATE `CREATE INDEX` STATEMENTS, and
 * that is deliberate. v59 execs these constants verbatim on a fresh install
 * while a rebuild creates its indexes INSIDE the marker guard — so a standalone
 * index added by v69 would be present on upgraded databases and silently absent
 * on fresh ones. Riding inside `CREATE TABLE` makes both routes converge with
 * no extra step.
 *
 * ITS `source_type` CHECK STAYS AT THE FIVE EXTERNAL VALUES, deliberately
 * (BACKLOG-2473). A proposal asks "is this contact the same person as this
 * EXTERNAL RECORD?". There is no external record behind an origin row and no
 * question to ask about one, so `manual`/`email`/`sms`/`inferred` must never
 * reach this table — and the narrow CHECK is what enforces that rather than
 * leaving it to convention. `databaseService.migration-v61.test.ts` asserts the
 * refusal in both directions. v69 keeps the vocabulary narrow and only adds
 * `IS NULL OR` so the new shapes can leave the columns empty; the same narrow
 * list governs `target_source_type`.
 *
 * `cluster_key` IS UNCHANGED, AND IT IS NOT TRANSITIVE CLOSURE. The rule
 * (BACKLOG-2369 G2, 13 Aug) is ONE QUESTION LISTING ALL CANDIDATES; ANSWERING
 * YES CLEARS THE REST. Confirming {A,B} must NOT fuse C and D — chaining
 * pairwise matches transitively is how a cluster ends up spanning several real
 * people, and the reason Keepr does not have that failure mode is precisely
 * that this key groups a question's candidates rather than closing over
 * confirmed pairs. See BACKLOG-2941.
 */
const CONTACT_LINK_PROPOSALS_TEMPLATE = `
  CREATE TABLE IF NOT EXISTS {{TABLE}} (
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
    subject_side TEXT NOT NULL DEFAULT 'a' CHECK (subject_side IN ('a', 'b')),${PAIR_KEY_GENERATED_COLUMN},
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (target_contact_id) REFERENCES contacts(id) ON DELETE CASCADE,${PAIR_SHAPE_CHECK},
    UNIQUE (user_id, contact_id, source_type, source_record_id),
    UNIQUE (user_id, pair_key)
  );
`;

export const CONTACT_LINK_PROPOSALS_TABLE_SQL = CONTACT_LINK_PROPOSALS_TEMPLATE.replace(
  "{{TABLE}}",
  "contact_link_proposals",
);

/** The rebuild's scratch table. Same columns, by construction. */
export function contactLinkProposalsRebuildTableSql(tempName: string): string {
  return CONTACT_LINK_PROPOSALS_TEMPLATE.replace("{{TABLE}}", tempName);
}

/**
 * EVERY WRITABLE column of `contact_link_proposals`, in declaration order.
 *
 * THIS LIST IS THE REBUILD'S SAFETY. `INSERT INTO ... SELECT` names these on
 * both sides so the copy is BY NAME, never positional. A positional copy is what
 * corrupted `audit_logs` in v33 and `contacts` in v36, and it cannot be caught by
 * a row count — the rows are all there, holding each other's values.
 *
 * `pair_key` IS ABSENT ON PURPOSE: it is a generated column and cannot be
 * written. The four v69 columns below it are listed because a REBUILD ON AN
 * ALREADY-MIGRATED DATABASE must carry them across; on a v68 database they do
 * not exist, which is why the migration selects the pre-v69 subset explicitly
 * rather than reusing this list on the read side.
 */
export const CONTACT_LINK_PROPOSALS_COLUMNS = [
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
  "pair_kind",
  "target_contact_id",
  "target_source_type",
  "target_source_record_id",
  "subject_side",
] as const;

/**
 * The columns a PRE-v69 `contact_link_proposals` has — the exact set the v69
 * rebuild copies from a v68 database.
 *
 * Every one of these rows is a `record_contact` pair, so `pair_kind`,
 * `subject_side` and `pair_key` are supplied by their DEFAULT and by the
 * generated expression. ZERO ROWS CHANGE MEANING.
 */
export const CONTACT_LINK_PROPOSALS_PRE_V69_COLUMNS = [
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
 * `contact_link_verdicts` — the answers. NOT derived, and unrecoverable: there
 * is no second source of ground truth anywhere in this system, and nothing can
 * regenerate a person's opinion.
 *
 * THIS IS THE DURABLE TABLE, AND v69 REBUILDS IT TOO. Widening the questions
 * alone would ship a question that can be asked and never answered durably:
 * `recordVerdict` would be refused by the CHECK for either new shape, and
 * "a no holds until NEW EVIDENCE arrives" is unimplementable for a pair that
 * cannot be stored. A rebuild of this table must not lose or mangle a verdict —
 * hence the by-name copy and the identity assertions in the v69 suite.
 *
 * NO FOREIGN KEY TO `contacts`, DELIBERATELY, AND THAT SURVIVES THE REBUILD.
 * Proposals cascade because a question about a deleted contact is noise. A
 * VERDICT about that contact is evidence, and "these two are different people"
 * stays true after the contact row is tombstoned. An ON DELETE CASCADE here
 * would quietly delete the labelled set as a side effect of ordinary contact
 * cleanup. `target_contact_id` gets no FK here for the same reason.
 *
 * NO UNIQUE ON THE PAIR EITHER — not the original quadruple, and NOT
 * `pair_key`. A user may answer the same pair twice, and both answers are
 * history. The LATEST one is the constraint, resolved at read time by
 * `decided_at DESC, rowid DESC`.
 *
 * THE REBUILD REASSIGNS ROWIDS, AND THAT TIEBREAK RIDES ON `rowid`. Two
 * verdicts sharing a `decided_at` must still resolve to the same winner after
 * v69 as before it; the copy is ordered by `rowid` so relative order is
 * preserved, and the v69 suite asserts exactly that rather than trusting it.
 *
 * `source_type` STAYS AT THE FIVE EXTERNAL VALUES for the same reason the
 * proposals table does (BACKLOG-2473): a verdict is an answer about an external
 * record. `unlinkContactSource` writes one, which is precisely why that function
 * must REFUSE an origin link — see the guard there.
 */
const CONTACT_LINK_VERDICTS_TEMPLATE = `
  CREATE TABLE IF NOT EXISTS {{TABLE}} (
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
    subject_side TEXT NOT NULL DEFAULT 'a' CHECK (subject_side IN ('a', 'b')),${PAIR_KEY_GENERATED_COLUMN},${PAIR_SHAPE_CHECK}
  );
`;

export const CONTACT_LINK_VERDICTS_TABLE_SQL = CONTACT_LINK_VERDICTS_TEMPLATE.replace(
  "{{TABLE}}",
  "contact_link_verdicts",
);

/** The rebuild's scratch table. Same columns, by construction. */
export function contactLinkVerdictsRebuildTableSql(tempName: string): string {
  return CONTACT_LINK_VERDICTS_TEMPLATE.replace("{{TABLE}}", tempName);
}

/** EVERY WRITABLE column of `contact_link_verdicts`. `pair_key` is generated. */
export const CONTACT_LINK_VERDICTS_COLUMNS = [
  "id",
  "user_id",
  "contact_id",
  "source_type",
  "source_record_id",
  "identity_verdict",
  "relationship_verdict",
  "reason",
  "matched_on",
  "evidence_json",
  "decided_at",
  "decided_by",
  "pair_kind",
  "target_contact_id",
  "target_source_type",
  "target_source_record_id",
  "subject_side",
] as const;

/** The columns a PRE-v69 `contact_link_verdicts` has. */
export const CONTACT_LINK_VERDICTS_PRE_V69_COLUMNS = [
  "id",
  "user_id",
  "contact_id",
  "source_type",
  "source_record_id",
  "identity_verdict",
  "relationship_verdict",
  "reason",
  "matched_on",
  "evidence_json",
  "decided_at",
  "decided_by",
] as const;

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
