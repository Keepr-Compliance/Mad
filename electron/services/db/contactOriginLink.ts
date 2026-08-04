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
import { dbRun } from "./core/dbConnection";
import { ORIGIN_MATCH_METHOD } from "./contactIdentitySchemaSql";
import logService from "../logService";

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

    const sourceType = originSourceTypeFor(contactSource);
    if (!sourceType) {
      // An unmapped source has no truthful origin to record. Logged rather than
      // guessed at, because a wrong provenance row is worse than a missing one
      // and this is the table meant to be authoritative about provenance.
      logService.warn(
        `[Contacts] no origin link written: '${contactSource}' is not a known contact source`,
        "Contacts",
      );
      return false;
    }

    const result = dbRun(
      `INSERT OR IGNORE INTO contact_source_links
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
  } catch (error) {
    logService.warn(
      `[Contacts] could not record where a new contact came from: ${error}`,
      "Contacts",
    );
    return false;
  }
}
