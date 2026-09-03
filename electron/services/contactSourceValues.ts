/**
 * When do a source record's emails and phones move ONTO a contact, and when do
 * they come back OFF? (BACKLOG-2427 + BACKLOG-2423 — WORK GROUP B)
 *
 * ===========================================================================
 * WHY BOTH DIRECTIONS LIVE IN ONE MODULE
 * ===========================================================================
 * Before this, only the arrival existed. `backfillImportedContactsFromExternal`
 * copied every linked source record's addresses onto the contact; nothing
 * anywhere reversed it. A copy rule without a removal rule only ever
 * accumulates, and the accumulation is not cosmetic:
 *
 *   Founder QA, 2026-08-02. Casey Lane, a party to transaction 571 Dale St N,
 *   assembled from a macOS card and an Outlook record. The founder pressed
 *   "Not this person" on the Outlook one. The link was deleted and a
 *   `different_people` verdict recorded — and `casey@bluespaces.com`, an
 *   address that exists ONLY in that Outlook record, stayed on the contact.
 *   `getContactEmailsForTransaction` reads `contact_emails`, so the audit for
 *   that transaction went on searching for the correspondence of a person the
 *   user had explicitly said was somebody else.
 *
 * The one action offered for fixing a wrong merge left the wrong data in place.
 * Keeping arrival and departure in the same file is the cheapest way to stop
 * that asymmetry reappearing.
 *
 * ===========================================================================
 * "ONLY WHAT CAME FROM THAT SOURCE, AND FROM NOWHERE ELSE"
 * ===========================================================================
 * A value is removed only when all three hold:
 *
 *   1. the unlinked record carries it;
 *   2. NO still-linked source record carries it — a person listed in both the
 *      macOS card and the Outlook record keeps their address when one of the
 *      two is rejected;
 *   3. the row's `source` is `'import'`.
 *
 * (3) is what protects a value the user typed. `contact_emails.source` /
 * `contact_phones.source` already distinguish `'import' | 'manual' |
 * 'inferred'`, and the backfill only ever writes `'import'` — so the question
 * "did a human put this here?" is already answered in the schema and needs no
 * new column. `'manual'`, `'inferred'` and NULL (rows predating the column,
 * provenance genuinely unknown) are all left alone. A source rejection is not
 * permission to delete what the user typed.
 *
 * ===========================================================================
 * WHY THE REMAINING VALUES ARE NOT READ VIA `CONTACT_SOURCE_RECORDS_SQL`
 * ===========================================================================
 * THIS IS THE SUBTLE ONE, AND GETTING IT WRONG PRODUCES A REMOVAL THAT SILENTLY
 * DOES NOTHING.
 *
 * That query's priority-2/3 branches were guarded by
 * `NOT EXISTS (SELECT 1 FROM contact_source_links x WHERE x.contact_id = @contactId)`
 * — they switched ON precisely when the contact had no crosswalk rows left. So
 * unlinking a contact's LAST source would make the content fallback re-match
 * the very record just unlinked (by the email or phone we are about to remove),
 * every value would look "still contributed by a remaining source", and nothing
 * would be removed. The one case where the whole rejection matters most.
 *
 * BACKLOG-2669 deleted those branches, so that specific hazard is gone and the
 * two queries would now agree. This module keeps its own read anyway: the
 * removal path must be legible on its own terms — "what do the links that
 * REMAIN contribute" — and it must not silently acquire whatever a future
 * priority added to the shared query would return. Unifying them would be a
 * separate change with its own argument, not a tidy-up.
 *
 * Remaining values are therefore read straight from
 * `contact_source_links JOIN external_contacts` — crosswalk rows only, no
 * content fallback, no name matching.
 *
 * ===========================================================================
 * FROZEN AUDITS: REFUSE THE REMOVAL, KEEP THE UNLINK, SAY SO
 * ===========================================================================
 * Removing an address from a contact on an EXPORTED transaction changes what a
 * re-export would search — silently altering the inputs of a document already
 * handed to someone. Founder decision, 2026-08-02: refuse and explain.
 *
 * Refused means refused THE REMOVAL, not the whole action. The link still goes,
 * the verdict is still recorded, and the caller is told the addresses were kept
 * and why. Blocking the unlink itself would leave the user unable to correct a
 * wrong merge on exactly the transactions where a wrong merge costs the most,
 * and the released record still becomes reachable again because the picker now
 * consults the verdict rather than the leftover phone number.
 */

import { dbAll, dbRun } from "./db/core/dbConnection";
import { unsafeSql } from "./db/core/sqlText";
import {
  backfillContactEmailsSync,
  backfillContactPhonesSync,
} from "./db/contactDbService";
import { isContactOnFrozenTransaction } from "./contactSourceLinker";
import type { ExternalContactSource } from "./db/externalContactDbService";
import { toLookupKey } from "../utils/phoneNormalization";
import logService from "./logService";

/** A source record's raw contribution, as stored on the shadow row. */
interface SourceValues {
  emails: string[];
  phones: string[];
}

/** Comparison keys — how two spellings of one value are recognised as one. */
interface ValueKeys {
  emails: Set<string>;
  phones: Set<string>;
}

export interface RemoveUnlinkedValuesResult {
  removedEmails: number;
  removedPhones: number;
  /**
   * Set when values that WOULD have been removed were deliberately kept.
   * `frozen_transaction` is the only reason today. `undefined` means nothing
   * was withheld — either everything removable was removed, or there was
   * nothing to remove.
   */
  retainedReason?: "frozen_transaction";
}

export interface ApplyLinkedValuesResult {
  emailsAdded: number;
  phonesAdded: number;
}

/** `[]` for NULL/blank/corrupt JSON — never throws into a link or an unlink. */
function parseValueArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "")
      : [];
  } catch {
    return [];
  }
}

const emailKey = (email: string): string => email.trim().toLowerCase();

/**
 * The phone comparison key: last 10 digits, via the shared helper.
 *
 * The same key `contact_phones.phone_normalized` is built from and the same one
 * `backfillContactPhonesSync` dedupes on, so "already present" and "safe to
 * remove" cannot disagree about whether two spellings of a number are the same
 * number.
 */
const phoneKey = (phone: string): string => toLookupKey(phone);

/** Every source record this contact is linked to, optionally excluding one. */
function linkedSourceValues(
  userId: string,
  contactId: string,
  exclude?: { sourceType: ExternalContactSource; sourceRecordId: string },
): SourceValues {
  const rows = dbAll<{
    source: string;
    external_record_id: string;
    emails_json: string | null;
    phones_json: string | null;
  }>(
    unsafeSql(`SELECT ec.source, ec.external_record_id, ec.emails_json, ec.phones_json
       FROM contact_source_links csl
       JOIN external_contacts ec
         ON ec.user_id = csl.user_id
        AND ec.source = csl.source_type
        AND ec.external_record_id = csl.source_record_id
      WHERE csl.user_id = ? AND csl.contact_id = ?
      ORDER BY ec.source, ec.external_record_id`),
    [userId, contactId],
  );

  const emails: string[] = [];
  const phones: string[] = [];
  for (const row of rows) {
    if (
      exclude &&
      row.source === exclude.sourceType &&
      row.external_record_id === exclude.sourceRecordId
    ) {
      continue;
    }
    emails.push(...parseValueArray(row.emails_json));
    phones.push(...parseValueArray(row.phones_json));
  }
  return { emails, phones };
}

function toKeys(values: SourceValues): ValueKeys {
  return {
    emails: new Set(values.emails.map(emailKey).filter(Boolean)),
    phones: new Set(values.phones.map(phoneKey).filter(Boolean)),
  };
}

/** One source record's stored emails/phones, or null when it is gone. */
function sourceRecordValues(
  userId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): SourceValues | null {
  const rows = dbAll<{ emails_json: string | null; phones_json: string | null }>(
    unsafeSql(`SELECT emails_json, phones_json FROM external_contacts
      WHERE user_id = ? AND source = ? AND external_record_id = ?`),
    [userId, sourceType, sourceRecordId],
  );
  if (rows.length === 0) return null;

  const emails: string[] = [];
  const phones: string[] = [];
  for (const row of rows) {
    emails.push(...parseValueArray(row.emails_json));
    phones.push(...parseValueArray(row.phones_json));
  }
  return { emails, phones };
}

/**
 * Copy every crosswalk-linked source record's emails and phones onto a contact.
 *
 * BACKLOG-2423. The session-gated `backfillImportedContactsFromExternal` still
 * exists and still sweeps everything once per user per session; this is the
 * TARGETED equivalent that runs the moment a link is created, so a source
 * linked after that sweep contributes immediately instead of at the next app
 * start. Until now a transaction created in that window swept an incomplete
 * address set and nothing re-swept when the addresses later arrived.
 *
 * Additive and idempotent — `INSERT OR IGNORE` against
 * `UNIQUE(contact_id, email)` / `UNIQUE(contact_id, phone_e164)`, so calling it
 * on every link creation costs nothing once converged.
 *
 * NEVER THROWS. A link that was correctly recorded must not be reported as
 * failed because the copy that follows it hit a problem; the session backfill
 * is still there as the safety net.
 */
export function applyLinkedSourceValues(
  userId: string,
  contactId: string,
): ApplyLinkedValuesResult {
  try {
    const values = linkedSourceValues(userId, contactId);
    if (values.emails.length === 0 && values.phones.length === 0) {
      return { emailsAdded: 0, phonesAdded: 0 };
    }

    const emailsAdded = backfillContactEmailsSync(contactId, values.emails);
    const phonesAdded = backfillContactPhonesSync(contactId, values.phones);

    if (emailsAdded > 0 || phonesAdded > 0) {
      // No display name and no address in the log line — this ends up in
      // support tickets.
      logService.info(
        `[Contacts] a newly linked source contributed +${emailsAdded} email(s), ` +
          `+${phonesAdded} phone(s) to a contact`,
        "Contacts",
      );
    }
    return { emailsAdded, phonesAdded };
  } catch (error) {
    logService.warn(
      `[Contacts] could not apply a linked source's values: ${error}`,
      "Contacts",
    );
    return { emailsAdded: 0, phonesAdded: 0 };
  }
}

/**
 * Take back what one source record contributed — and nothing else.
 *
 * CALL ORDER MATTERS: the caller must have ALREADY deleted the crosswalk row,
 * so "what the remaining links contribute" is read from the links that actually
 * remain. `sourceType`/`sourceRecordId` identify the record that was just
 * released; it is read directly from `external_contacts` (it still exists — an
 * unlink never deletes the source record).
 *
 * Returns counts rather than throwing. An unlink that succeeded must not be
 * reported as failed because the cleanup after it did not.
 */
export function removeUnlinkedSourceValues(
  userId: string,
  contactId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): RemoveUnlinkedValuesResult {
  try {
    const released = sourceRecordValues(userId, sourceType, sourceRecordId);
    if (!released) {
      // The source record is gone from the shadow table, so there is nothing to
      // say which values it contributed. Removing on a guess would delete
      // addresses that may have come from anywhere.
      return { removedEmails: 0, removedPhones: 0 };
    }

    const releasedKeys = toKeys(released);
    if (releasedKeys.emails.size === 0 && releasedKeys.phones.size === 0) {
      return { removedEmails: 0, removedPhones: 0 };
    }

    // Crosswalk rows only — see the module header for why the shared
    // CONTACT_SOURCE_RECORDS_SQL cannot be used here.
    const remainingKeys = toKeys(linkedSourceValues(userId, contactId));

    const emailsToRemove = [...releasedKeys.emails].filter(
      (key) => !remainingKeys.emails.has(key),
    );
    const phonesToRemove = [...releasedKeys.phones].filter(
      (key) => !remainingKeys.phones.has(key),
    );

    if (emailsToRemove.length === 0 && phonesToRemove.length === 0) {
      return { removedEmails: 0, removedPhones: 0 };
    }

    // Ask ONLY when there is something to withhold, so an unlink on a contact
    // that shares everything with a surviving source is not reported as
    // "refused" when nothing was going to be removed anyway.
    if (isContactOnFrozenTransaction(contactId)) {
      logService.info(
        `[Contacts] a ${sourceType} source was unlinked from a contact on an EXPORTED ` +
          `transaction; its ${emailsToRemove.length} email(s) and ${phonesToRemove.length} ` +
          `phone(s) were KEPT so the exported audit's search set is unchanged`,
        "Contacts",
      );
      return {
        removedEmails: 0,
        removedPhones: 0,
        retainedReason: "frozen_transaction",
      };
    }

    let removedEmails = 0;
    for (const key of emailsToRemove) {
      // `source = 'import'` is the guard that spares a value the user typed.
      // LOWER(TRIM(...)) mirrors how the backfill stored it and how
      // `getContactEmailsForTransaction` reads it back.
      removedEmails += dbRun(
        unsafeSql(`DELETE FROM contact_emails
          WHERE contact_id = ? AND LOWER(TRIM(email)) = ? AND source = 'import'`),
        [contactId, key],
      ).changes;
    }

    let removedPhones = 0;
    for (const key of phonesToRemove) {
      // Matched on the normalized key, not the stored spelling: the row may
      // hold "+14085550101" while the source record says "(408) 555-0101".
      // COALESCE covers rows written before `phone_normalized` was populated.
      removedPhones += dbRun(
        unsafeSql(`DELETE FROM contact_phones
          WHERE contact_id = ?
            AND COALESCE(NULLIF(phone_normalized, ''), phone_e164) = ?
            AND source = 'import'`),
        [contactId, key],
      ).changes;
    }

    if (removedEmails > 0 || removedPhones > 0) {
      logService.info(
        `[Contacts] unlinking a ${sourceType} source took back ${removedEmails} email(s) ` +
          `and ${removedPhones} phone(s) that no remaining source contributes`,
        "Contacts",
      );
    }

    return { removedEmails, removedPhones };
  } catch (error) {
    logService.warn(
      `[Contacts] could not take back an unlinked source's values: ${error}`,
      "Contacts",
    );
    return { removedEmails: 0, removedPhones: 0 };
  }
}
