/**
 * ONE ANSWER TO "WHERE DID THIS CONTACT COME FROM" (BACKLOG-2473)
 *
 * ===========================================================================
 * THE DEFECT THIS CLOSES
 * ===========================================================================
 * BACKLOG-2472 changed the source filter to read the `contact_source_links`
 * crosswalk instead of the `contacts.source` scalar. It could not finish the
 * job, because two populations could never have a crosswalk row:
 *
 *   MANUAL contacts — typed into the Add Contact form. There is no address-book
 *     record to point at.
 *   MESSAGE-DERIVED contacts — inferred from an email or text thread. Same.
 *
 * So one fact was answered two different ways depending on which contact you
 * asked about, and 2472 had to keep a fallback to the scalar. That is the exact
 * shape of the defect it set out to fix: one fact stored twice, one copy
 * updated, the screen shows the stale one.
 *
 * An ORIGIN ROW is the missing answer, written at the moment a contact is
 * created so that every contact has one from the instant it exists.
 *
 * ===========================================================================
 * GOING FORWARD ONLY — THERE IS DELIBERATELY NO BACKFILL
 * ===========================================================================
 * Founder decision, 2026-08-04: the one user with pre-crosswalk contacts will
 * reinstall onto a fresh instance, and the QA profile is reset routinely. There
 * is no population of old link-less contacts to rescue, so a migration pass over
 * them would be pure risk — a table-wide write, inside a migration transaction,
 * for zero rows.
 *
 * If that ever stops being true, the missing piece is a single pass inserting an
 * origin row for every contact with no link, using the map below. It is NOT
 * written here on purpose: dead migration code reads as live migration code.
 *
 * ===========================================================================
 * AN ORIGIN ROW IS NOT A CLAIM ABOUT AN EXTERNAL RECORD
 * ===========================================================================
 * THIS IS THE SUBTLE PART, AND GETTING IT WRONG BREAKS ADDRESS RESOLUTION.
 *
 * `contactSourceLinkSql.CONTACT_SOURCE_RECORDS_SQL` resolves a contact to its
 * external records three ways, and its priority-2 (email) and priority-3 (phone)
 * CONTENT FALLBACKS are gated on the contact having no crosswalk rows at all.
 * Give a contact an origin row without teaching that query the difference and
 * the gate closes for it — a hand-typed contact whose address also appears in an
 * address-book record would silently stop picking up that record's other
 * addresses, with no error anywhere.
 *
 * Origin rows are therefore stamped `match_method = 'origin'`, and that query
 * excludes them from its gate. The rule in one line:
 *
 *   an origin row says WHERE A CONTACT CAME FROM;
 *   it never says WHICH EXTERNAL RECORD a contact IS.
 *
 * Everything that resolves a contact to real source data JOINs
 * `external_contacts` on `(source, external_record_id)`, and an origin row's
 * synthetic `source_record_id` matches nothing — so those callers need no change
 * and contribute nothing from an origin row. Verified by enumerating every
 * production reader of `contact_source_links`; only that one query used a
 * presence gate.
 *
 * ===========================================================================
 * WHY `source_record_id` IS SYNTHETIC AND STILL NOT NULL
 * ===========================================================================
 * The column is `NOT NULL` and carries `UNIQUE (user_id, source_type,
 * source_record_id)`.
 *
 * A constant sentinel (`'manual'`) would therefore collapse EVERY manual contact
 * in an account into a single crosswalk row — the second one silently loses to
 * the UNIQUE. Keying on the contact's own id makes the value unique by
 * construction, one origin row per contact, self-describing in a database dump,
 * and it needs neither a nullability change nor a new foreign key. The row is
 * already tied to the contact by `contact_id` with ON DELETE CASCADE, so it
 * cannot outlive the contact it describes.
 */

import { randomUUID } from "crypto";
import { dbAll, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import { ORIGIN_MATCH_METHOD } from "./contactIdentitySchemaSql";
import logService from "../logService";
import { placeholderList } from "./core/sqlFragments";

/**
 * One external address-book record a contact is being created FROM.
 *
 * Structurally the same triple `contactHandlers.SourceIdentity` carries; declared
 * here so the DB layer does not have to import from a handler.
 */
export interface ContactOriginSourceIdentity {
  readonly sourceType: string;
  readonly sourceRecordId: string;
  readonly externalUuid?: string | null;
}

/**
 * ===========================================================================
 * WHERE A CONTACT CAME FROM — A REQUIRED ARGUMENT, NOT A FOLLOW-UP CALL
 * ===========================================================================
 * BACKLOG-2496. Creating a contact and recording its origin used to be two
 * separate calls, and NOTHING FORCED THE SECOND TO HAPPEN. A caller that
 * omitted it produced a contact with no origin: no error, no warning, and no
 * way to tell afterwards that anything was missing.
 *
 * That is not hypothetical. It is the shape of BOTH defects found on
 * 2026-08-05 — BACKLOG-2510 (the Clients & Contacts import called the general
 * create and wrote no crosswalk row) and BACKLOG-2525 (which then read the
 * absent row as "this address-book entry is unclaimed" and made a duplicate).
 * Both were a caller quietly not doing what its siblings did.
 *
 * An audit that adds the missing call to each of today's callers fixes today
 * and breaks again the moment someone adds a fifth. So the origin is a
 * REQUIRED PARAMETER of contact creation: a new path that omits it does not
 * compile, and one that supplies it gets the row written in the SAME
 * TRANSACTION as the contact.
 *
 * WHY A PARAMETER RATHER THAN A FIELD ON `NewContact`. `NewContact` is shared
 * with readers and updaters, and an OPTIONAL field is not a requirement — a new
 * caller omitting it would still compile, which is precisely the hole. It is
 * also the lesson of BACKLOG-2528: `Contact.name` was annotated
 * "@deprecated Read-only. Use display_name for all writes" and the broken call
 * was still type-correct, because A COMMENT IS NOT A GUARD. A required
 * positional parameter is checked by the compiler.
 */
export type ContactOrigin =
  /**
   * There is no external record behind this contact — it was typed in by hand,
   * inferred from a message thread, or promoted by a sync that has no record id
   * to point at. Its origin row is synthetic, keyed on the contact's own id.
   */
  | { readonly kind: "derived" }
  /**
   * The contact is being created FROM specific external address-book records.
   *
   * A picker row can stand for several records once collapsed (BACKLOG-2458),
   * so this is a LIST rather than one pair. Every one gets a record-backed
   * crosswalk row, and the synthetic origin row is written alongside them —
   * they answer different questions ("came from your Mac address book" /
   * "IS this specific card") and both are true.
   */
  | {
      readonly kind: "sourceRecords";
      readonly identities: ReadonlyArray<ContactOriginSourceIdentity>;
    };

/**
 * `contacts.source` -> the `source_type` its origin row carries.
 *
 * DERIVED, NOT INVENTED. The keys are exactly the vocabulary the `contacts.source`
 * CHECK admits (`databaseService.ts` migration v48 and `electron/database/schema.sql`):
 *
 *   manual, email, sms, contacts_app, inferred, android_sync, iphone, outlook,
 *   google_contacts
 *
 * The four address-book/provider values map to themselves — they are already in
 * the crosswalk vocabulary. `contacts_app` maps to `macos` because the desktop
 * Contacts app IS the macOS source, and the crosswalk has always spelled it
 * `macos`; introducing a second spelling for one address book is how a filter
 * comes to miss half its rows. The remaining four (`manual`, `email`, `sms`,
 * `inferred`) are the values v61 adds to the crosswalk CHECK.
 *
 * NOTE — `messages` is absent on purpose. The TypeScript `ContactSource` union
 * and the `validSources` allow-list in `contactHandlers.ts` both admit it, but
 * the DB CHECK never has, so it cannot be a value on disk. Adding it here would
 * be inventing vocabulary. (That the two disagree at all is a real inconsistency,
 * reported separately.)
 */
export const ORIGIN_SOURCE_TYPE_BY_CONTACT_SOURCE: Readonly<Record<string, string>> =
  Object.freeze({
    manual: "manual",
    email: "email",
    sms: "sms",
    inferred: "inferred",
    contacts_app: "macos",
    macos: "macos",
    iphone: "iphone",
    outlook: "outlook",
    google_contacts: "google_contacts",
    android_sync: "android_sync",
  });

/**
 * The origin `source_type` for a `contacts.source` value, or `null` when the
 * value is one this map does not know.
 *
 * `null` MATTERS. It is returned rather than defaulted to `'manual'` because a
 * default would be a lie about provenance written into the one table that is
 * meant to be authoritative about provenance. The caller skips instead — a
 * contact without an origin row is a gap, which is recoverable; a contact with
 * a WRONG origin row is a false statement nothing will ever correct.
 */
export function originSourceTypeFor(
  contactSource: string | null | undefined,
): string | null {
  if (!contactSource) return null;
  return ORIGIN_SOURCE_TYPE_BY_CONTACT_SOURCE[contactSource.trim().toLowerCase()] ?? null;
}

/** The synthetic record id for a contact's origin row. Unique by construction. */
export function originRecordId(contactId: string): string {
  return `origin:${contactId}`;
}

/**
 * Which of `sourceRecordIds` are ALREADY claimed by a contact, for one source.
 *
 * ===========================================================================
 * BACKLOG-2987 — "HAVE WE ALREADY IMPORTED THIS RECORD" IS NOT A PERSON QUESTION
 * ===========================================================================
 * `localSyncService.promoteToMainContacts` decided whether an Android contact
 * was already in the main table by PHONE NUMBER ALONE. A contact whose only
 * identifier is an email never entered that loop at all, so it was created on
 * every single sync, forever — 26 of the founder's 389 contacts, the SAME 26 on
 * three consecutive runs, verified by comparing the created-contact log lines
 * across runs (0 differing entries between run 2, run 3 and run 4).
 *
 * The obvious-looking fix — also match on email — is the wrong instrument. It
 * is a new PERSON-IDENTITY rule, the BACKLOG-2416 shape applied to a create
 * path: two people who share an office address would collapse into one contact,
 * and identity rules are founder-decided, not chosen inside a duplicate fix.
 *
 * This asks a different and strictly answerable question: *is this exact
 * external record already claimed by a contact we created?* The create path in
 * `promoteToMainContacts` has claimed its record since BACKLOG-2556 — the
 * crosswalk row is written inside the same transaction as the contact — so the
 * claim is a fact about our own bookkeeping, carries no risk of merging two
 * people, and needs no ruling.
 *
 * ONE QUERY FOR THE WHOLE BATCH. A full Android sync promotes against ~400
 * records; a per-record probe would be 400 round trips inside a request handler.
 *
 * CHUNKED, and the limit is MEASURED rather than quoted. The number usually
 * cited for SQLite host parameters is 999; on the driver this app actually ships
 * (`better-sqlite3-multiple-ciphers`, SQLite 3.53.2) an `IN (...)` accepts 32,766
 * and fails at 32,767 with "too many SQL variables" — checked directly, because
 * a chunk size chosen from a remembered number is how you get a limit that is
 * either useless or wrong. 400 is well under both the modern cap and the older
 * 999, so this holds if the driver is ever downgraded, and it bounds the
 * expression tree too (a plain `?+?+…` hits a separate depth limit far sooner).
 *
 * @returns the subset of `sourceRecordIds` that already have a crosswalk row.
 *   An empty input, a missing user or a missing source type returns an empty
 *   set — never a throw, because a probe that fails should degrade to "nothing
 *   is claimed" (today's behaviour) rather than break a sync.
 */
export function findClaimedSourceRecordIds(
  userId: string,
  sourceType: string,
  sourceRecordIds: readonly string[],
): Set<string> {
  const claimed = new Set<string>();
  if (!userId || !sourceType || sourceRecordIds.length === 0) return claimed;

  // Well under SQLite's 999-parameter default, with room for the two leading
  // binds. Chunking rather than a temp table keeps this a pure read with no
  // schema footprint.
  const CHUNK = 400;

  try {
    for (let i = 0; i < sourceRecordIds.length; i += CHUNK) {
      const chunk = sourceRecordIds.slice(i, i + CHUNK);
      const placeholders = placeholderList(chunk.length, sql`,`);
      const rows = dbAll<{ source_record_id: string }>(
        sql`SELECT source_record_id FROM contact_source_links
          WHERE user_id = ? AND source_type = ?
            AND source_record_id IN (${placeholders})`,
        [userId, sourceType, ...chunk],
      );
      for (const row of rows) claimed.add(row.source_record_id);
    }
  } catch (error) {
    logService.warn(
      `[Contacts] could not read existing source claims: ${error}`,
      "Contacts",
    );
    return new Set<string>();
  }

  return claimed;
}

/**
 * Write a contact's origin row. Called once, immediately after the contact is
 * created, so no contact ever exists without a statement of where it came from.
 *
 * ---------------------------------------------------------------------------
 * IT MUST NEVER THROW
 * ---------------------------------------------------------------------------
 * A contact the user just typed in has been created and saved by the time this
 * runs. Failing the whole IPC call because a provenance row could not be written
 * would lose their work to fix a bookkeeping problem — the contact is still
 * usable without the row, and the only thing degraded is which filter leaf finds
 * it. So every failure path returns `false` and logs.
 *
 * `INSERT OR IGNORE` makes it idempotent: a retried create, or a contact that
 * already picked up a record-backed link, writes nothing rather than colliding
 * with `UNIQUE (user_id, source_type, source_record_id)`.
 *
 * Returns whether a row was written — used by the tests to tell "wrote nothing
 * because it already existed" from "wrote nothing because the source was
 * unmapped", which are different bugs.
 */
export function recordContactOrigin(
  userId: string,
  contactId: string,
  contactSource: string | null | undefined,
): boolean {
  try {
    if (!userId || !contactId) return false;
    return insertOriginRow(userId, contactId, contactSource);
  } catch (error) {
    logService.warn(
      `[Contacts] could not record where a new contact came from: ${error}`,
      "Contacts",
    );
    return false;
  }
}

/**
 * The single origin-row INSERT, shared by the lenient wrapper above and the
 * strict create path below so there is ONE statement, not two that can drift.
 *
 * Throws on an unmapped source. The lenient wrapper catches; the create path
 * deliberately does not.
 */
function insertOriginRow(
  userId: string,
  contactId: string,
  contactSource: string | null | undefined,
): boolean {
  const sourceType = originSourceTypeFor(contactSource);
  if (!sourceType) {
    // An unmapped source has no truthful origin to record. Never guessed at,
    // because a wrong provenance row is worse than a missing one and this is
    // the table meant to be authoritative about provenance.
    throw new Error(
      `no origin link written: '${contactSource}' is not a known contact source`,
    );
  }

  const result = dbRun(
    sql`INSERT OR IGNORE INTO contact_source_links
       (id, user_id, contact_id, source_type, source_record_id, external_uuid,
        match_method, confidence, evidence_ref)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
    [
      randomUUID(),
      userId,
      contactId,
      sourceType,
      originRecordId(contactId),
      ORIGIN_MATCH_METHOD,
    ],
  );
  return result.changes > 0;
}

/**
 * ===========================================================================
 * WRITE A NEW CONTACT'S ORIGIN — STRICT, AND INSIDE THE CREATE TRANSACTION
 * ===========================================================================
 * BACKLOG-2496. Called by `createContact` / `createContactsBatch` from INSIDE
 * the transaction that inserts the contact, so the contact row and the row
 * saying where it came from either both land or neither does.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE THROWS WHERE `recordContactOrigin` SWALLOWS
 * ---------------------------------------------------------------------------
 * THE DIFFERENCE IS WHETHER THE CONTACT IS ALREADY SAVED, AND IT INVERTS THE
 * ARGUMENT.
 *
 * `recordContactOrigin` runs AFTER a contact has been committed, so failing the
 * IPC call there would lose work the user had already done to fix a bookkeeping
 * problem — the contact is usable without the row. Swallowing is right.
 *
 * Here the contact is NOT yet saved. Swallowing would commit a contact with no
 * origin, which is the exact state this item exists to make unreachable, and it
 * would do so silently — indistinguishable afterwards from a path that never
 * wrote one. Throwing rolls the whole create back, so the user sees a create
 * that failed rather than one that half-succeeded in a way nothing reports.
 *
 * In practice the throw is unreachable via the mapped path: `contacts.source`
 * carries a CHECK admitting exactly the nine values this map covers, so a
 * source it cannot map would have failed the contact INSERT a statement
 * earlier. It is a guard against a future widening of that CHECK that forgets
 * this map, not a live branch.
 */
export function writeContactOriginInTransaction(
  userId: string,
  contactId: string,
  contactSource: string | null | undefined,
  origin: ContactOrigin,
): void {
  if (!userId) throw new Error("cannot record a contact origin without a user id");
  if (!contactId) throw new Error("cannot record a contact origin without a contact id");

  // The synthetic row is written for EVERY contact, whatever its origin — it is
  // the floor guarantee that makes "a contact with no origin" unreachable, and
  // it survives the external record being deleted later.
  insertOriginRow(userId, contactId, contactSource);

  if (origin.kind === "derived") return;

  for (const identity of origin.identities) {
    if (!identity.sourceType || !identity.sourceRecordId) {
      throw new Error(
        "a source-record origin needs both a sourceType and a sourceRecordId",
      );
    }
    dbRun(
      sql`INSERT OR IGNORE INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, external_uuid,
          match_method, confidence, evidence_ref)
       VALUES (?, ?, ?, ?, ?, ?, 'source_id', NULL, NULL)`,
      [
        randomUUID(),
        userId,
        contactId,
        identity.sourceType,
        identity.sourceRecordId,
        identity.externalUuid ?? null,
      ],
    );
  }
}
