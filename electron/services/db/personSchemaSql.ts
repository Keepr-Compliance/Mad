/**
 * The person layer — DDL for the row that sits ABOVE contacts (BACKLOG-2609)
 *
 * ===========================================================================
 * WHAT THIS SOLVES, IN ONE SENTENCE
 * ===========================================================================
 * `contact_source_links` is `UNIQUE (user_id, source_type, source_record_id)`
 * (`contactIdentitySchemaSql.ts:129`) — one source record belongs to exactly one
 * contact — and `contactManualLink.ts:328` refuses to repoint a record another
 * contact has claimed. So a user who imports the same person twice is stuck
 * permanently, with no mechanism and no message. The crosswalk is an EDGE BELOW
 * contacts; "these two contacts are one person" needs a NODE ABOVE them. That
 * node is `persons`.
 *
 * ===========================================================================
 * THIS SCHEMA IS INERT AND MUST STAY THAT WAY UNTIL 2610/2611/2612/2616
 * ===========================================================================
 * NOTHING reads `persons` or `contacts.person_id` yet. Migration v63 creates the
 * table, adds the column and gives every existing contact its own person; no
 * query, projection, export or renderer is rewired. That is deliberate — this
 * item ships substrate so the four items above land against a schema that is
 * already on every disk.
 *
 * ===========================================================================
 * IT IS A FIRST-CLASS RECORD, NOT A GROUPING KEY (founder, 12 Aug)
 * ===========================================================================
 * *"I think we need to retain the person with its details even if the linked
 * contact is deleted."* — `pm_comments` on BACKLOG-2609.
 *
 * "Retain the person WITH ITS DETAILS" is why this table has display columns of
 * its own rather than being a bare id. If the person were merely a grouping key,
 * deleting the last contact under it would leave nothing to retain.
 *
 * Three consequences are built into the DDL below:
 *
 *  1. **Its own display columns**, named to mirror `contacts` field for field
 *     (`display_name` / `company` / `title`) so BACKLOG-2611's merge can copy
 *     without a translation layer. `title` is this schema's role field.
 *  2. **Deleting a contact CANNOT reach the person.** The foreign key sits on
 *     `contacts.person_id` pointing AT `persons`, so a contact delete is
 *     structurally incapable of removing a person row. This deliberately does
 *     NOT copy `contact_source_links`, which is `ON DELETE CASCADE` on
 *     `contact_id` (`contactIdentitySchemaSql.ts:128`) — a cascade there would
 *     destroy exactly what the founder asked to retain.
 *  3. **Restore rejoins the SAME person.** Contacts are tombstoned, not deleted
 *     (`contacts.removed_at`, migration v56), so the row keeps its `person_id`
 *     across a delete/restore round trip and cannot silently un-merge. The v63
 *     backfill therefore covers tombstoned contacts too — skipping them is what
 *     would break restore.
 *
 * ===========================================================================
 * WHY THE DISPLAY COLUMNS ARE LEFT NULL BY THE BACKFILL
 * ===========================================================================
 * The founder's own framing on BACKLOG-2611: the person is *"seeded once at
 * merge and owned by the user thereafter"*. Copying every contact's name into
 * its person row NOW would create a second copy of that name with no writer
 * keeping it current — this migration rewires nothing, so the copy would begin
 * drifting the moment anyone edits a contact. That is the one-fact-two-answers
 * defect this codebase has already paid for once in provenance
 * (`contactIdentitySchemaSql.ts:56-62`).
 *
 * So a person born of the backfill carries NULL display fields, meaning "nothing
 * has been decided about this person yet". BACKLOG-2611 writes real values at
 * merge time, from contact **A** — the contact the duplicate was found FOR — per
 * the founder's field-by-field spec on 2611.
 *
 * ===========================================================================
 * WHY THERE IS NO INDEX, AND WHY NONE OF THIS IS IN schema.sql
 * ===========================================================================
 * NO INDEX on `contacts(person_id)`: nothing reads it, so an index would open no
 * access path while costing a B-tree entry on every contact write. Ship the index
 * with the query that needs it (BACKLOG-2610). The v62 header states the same
 * rule and the reason it is not a style preference: a standalone `CREATE INDEX`
 * in `schema.sql` on a column the migration chain has not yet added throws
 * "no such column" on EVERY real upgrade while passing every CI check, because
 * `schema.sql` is exec'd BEFORE the chain (BACKLOG-2298/2300 — shipped broken in
 * July, caught only by founder live QA).
 *
 * NOT DECLARED IN schema.sql AT ALL, and for `contacts` that is mandatory rather
 * than stylistic: `schema.sql:130-135` records that fresh installs seed
 * `schema_version = 32` and therefore RUN migration v36, whose positional copy
 * supplies 15 values to a 15-column table. A 16th column declared there is a
 * PREPARE-time error that breaks every new install. Contacts columns are added
 * ONLY as a guarded ALTER in a new migration.
 */

/**
 * `persons` at its v63 shape.
 *
 * `removed_at` matches the tombstone `contacts` and `transaction_contacts`
 * already carry (migration v56, BACKLOG-2364) — the shape this codebase uses for
 * "gone but still referenced". `removed_reason` is deliberately NOT mirrored:
 * nothing writes a person tombstone yet, and adding a column later is an additive
 * ALTER, not a table rebuild, so there is no future cost to leaving it out.
 *
 * `user_id` carries the same `ON DELETE CASCADE` to `users_local` that `contacts`
 * does — a person belongs to exactly one local user and cannot outlive them.
 */
export const PERSONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS persons (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT,
    company TEXT,
    title TEXT,
    removed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );
`;

/** Every column of `persons`, in declaration order. */
export const PERSONS_COLUMNS = [
  "id",
  "user_id",
  "display_name",
  "company",
  "title",
  "removed_at",
  "created_at",
  "updated_at",
] as const;

/** The column v63 adds to `contacts`. */
export const CONTACTS_PERSON_ID_COLUMN = "person_id";

/**
 * The guarded ALTER that hangs `contacts` off `persons`.
 *
 * `ON DELETE SET NULL` is the direction that CAN fire: deleting a person
 * un-merges its contacts rather than blocking the delete or (far worse) taking
 * the contacts with it. The direction that must never fire — contact delete
 * reaching the person — is impossible by construction, because the foreign key
 * lives on this side.
 *
 * NULLABLE, and it stays nullable. This migration is inert, so `createContact`
 * is NOT rewired and every contact created after the upgrade gets NULL. The
 * "every contact has its own person" guarantee is a statement about the moment
 * the backfill runs, not an invariant the schema enforces — asserting otherwise
 * would be asserting something no writer maintains.
 *
 * SQLite permits `ADD COLUMN` with a foreign-key clause only when the default is
 * NULL (https://sqlite.org/lang_altertable.html), which is exactly the shape
 * here.
 */
export const CONTACTS_ADD_PERSON_ID_SQL =
  "ALTER TABLE contacts ADD COLUMN person_id TEXT REFERENCES persons(id) ON DELETE SET NULL";

/**
 * The trigger the v63 backfill has to step around, by name.
 *
 * `update_contacts_timestamp` (`schema.sql:1135-1139`, and migration v30/v48
 * recreate it) is an AFTER UPDATE trigger that stamps
 * `updated_at = CURRENT_TIMESTAMP` on every updated contact row.
 *
 * THIS IS THE TRAP IN THIS MIGRATION. The backfill has to write `person_id` onto
 * every contact, and a plain UPDATE would fire that trigger for every row —
 * rewriting the whole table's `updated_at` to the instant of the upgrade. That is
 * not an internal detail: it is a user-visible field, and flattening it destroys
 * whatever ordering it carried. A migration billed as inert would have silently
 * rewritten a column on every contact the user owns.
 *
 * There is no way to suppress a SQLite trigger for one statement, so v63 drops it
 * (recreating it from its own `sqlite_master.sql`, byte-identically) around the
 * backfill. DDL is transactional in SQLite and each migration runs inside one
 * transaction (`databaseService.ts:3584-3590`), so a throw mid-backfill rolls the
 * DROP back with everything else — the trigger cannot be left missing.
 */
export const CONTACTS_TIMESTAMP_TRIGGER = "update_contacts_timestamp";
