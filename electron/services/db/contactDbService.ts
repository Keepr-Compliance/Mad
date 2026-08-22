/**
 * Contact Database Service
 * Handles all contact-related database operations
 */

import crypto from "crypto";
import type { Contact, NewContact, ContactFilters, Message, Communication, ContactMessageThread } from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbAll, dbRun, dbTransaction } from "./core/dbConnection";
import logService from "../logService";
import {
  validateFields,
  type ColumnOf,
  type FieldExpression,
} from "../../utils/sqlFieldWhitelist";
import { toLookupKey, toE164, looksLikePhoneQuery, legacyDigitKey } from "../../utils/phoneNormalization";
import { contactInfoSourceFor } from "../../utils/contactValueProvenance";
import type { ContactInfoSource, ContactUpdateFields } from "../../types/models";
import { CONTACT_UPDATE_FIELD_TO_COLUMN } from "../../types/models";
import { LOCAL_REACTION_EXCLUSION, reactionExclusion } from "./reactionExclusion";
import { isReactionRow } from "../../utils/reactionUtils";
// BACKLOG-1933: pure phone-matching helpers only (no transaction-scoped finders).
import { normalizePhone, phonesMatch } from "../messageMatchingService";
import { getContactNames } from "../contactsService";
import { queryContacts, isPoolReady } from "../../workers/contactWorkerPool";
import { ContactSchema, validateResponse } from "../../schemas";
import { IMPORTED_CONTACT_LAST_COMMUNICATION_SQL } from "./contactRecencySql";
import {
  IMPORTED_CONTACT_ADDRESSES_SQL,
  IMPORTED_CONTACTS_SELECT_SQL,
} from "./contactProjectionSql";
import {
  ACTIVE_CONTACTS_CLAUSE_C,
  ACTIVE_CONTACTS_CLAUSE_UNALIASED,
} from "./contactTombstoneSql";
import {
  attachLiveSources,
  attachReviewState,
  getLiveSourcesForContact,
} from "./contactSourceSets";
import {
  writeContactOriginInTransaction,
  type ContactOrigin,
} from "./contactOriginLink";

// Contact with activity metadata
interface ContactWithActivity extends Contact {
  last_communication_at?: string | null;
  communication_count?: number;
  address_mention_count?: number;
}

// Transaction with roles for contact
// BACKLOG-1930: `roles` is a typed string[] at the data boundary (deduped,
// NOT pre-joined). The renderer owns display formatting (the ", " join). This
// removes the pre-joined-string antipattern that caused BACKLOG-1898's
// `t.roles?.join is not a function` runtime error.
interface TransactionWithRoles {
  id: string;
  property_address: string;
  closing_deadline?: string | null;
  transaction_type?: string | null;
  status: string;
  roles: string[];
}

// BACKLOG-1933: ContactMessageThread is defined in ../../types/models (a pure
// type module) so main / preload / renderer can share it. Re-exported below.

// Message-derived contact (extracted from messages table participants JSON)
interface MessageDerivedContact {
  id: string;
  display_name: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string;
  is_imported: number;
  is_message_derived: number;
  last_communication_at: string | null;
  communication_count: number; // BACKLOG-311: Pre-computed to avoid N+1 queries
}

/**
 * The lowercased display names of saved contacts whose NAME IS ALL THEY ARE —
 * the only contacts allowed to suppress a message-derived person of the same
 * name (BACKLOG-2618).
 *
 * ONE definition, exported, because there are TWO surfaces that merge
 * message-derived people into a saved-contact list — `getMessageDerivedContacts`
 * (the contacts list and the activity sort) and `searchContactsForSelection`
 * (the transaction picker) — and they had already disagreed: the first
 * suppressed on name and the second did not suppress at all, so removing Dana
 * hid her from one and left her twin visible in the other. Two copies of a rule
 * is how they drifted; this is the fix for the drift as well as for the rule.
 *
 * The two terms, and neither folds into the other:
 *
 *   `removed_at IS NOT NULL` — BACKLOG-2365. The user acted on this person.
 *     A removed contact must keep counting as KNOWN or the removal visibly
 *     undoes itself, whether or not the contact came from an address book.
 *
 *   no `contact_source_links` row — the contact has no address-book record
 *     behind it, so its display name is the whole of its identity: it was typed
 *     by hand, or it was created by importing this very message-derived row.
 *     A contact that DOES have a crosswalk row is an independent address-book
 *     person, and a shared name with a text sender is a guess, not knowledge.
 *
 * `is_imported = 1 OR removed_at IS NOT NULL` is kept as the outer predicate so
 * the question stays "do we already know about this person?" rather than
 * "should this person be shown?" — the inversion BACKLOG-2365 exists to record.
 */
export function namesThatAreTheirOwnIdentity(userId: string): Set<string> {
  const KNOWN_CONTACT = "(c.is_imported = 1 OR c.removed_at IS NOT NULL)";
  try {
    const rows = dbAll<{ name: string }>(
      `SELECT LOWER(display_name) as name
         FROM contacts c
        WHERE c.user_id = ?
          AND ${KNOWN_CONTACT}
          AND (
            c.removed_at IS NOT NULL
            OR NOT EXISTS (
              SELECT 1 FROM contact_source_links l
               WHERE l.contact_id = c.id AND l.user_id = c.user_id
            )
          )`,
      [userId],
    );
    return new Set(rows.map((r) => r.name).filter(Boolean));
  } catch (error) {
    /**
     * DEGRADES TOWARDS THE PRE-BACKLOG-2618 BEHAVIOUR, NEVER FAILS.
     *
     * This introduced a `contact_source_links` dependency into
     * `contacts:get-all`, which had none before — and that path renders the
     * whole contacts list. A database below migration v57 has no such table, so
     * an unguarded read would turn "a same-named person is hidden" into "the
     * contacts list throws".
     *
     * THE DIRECTION IS CHOSEN, not defaulted. Falling back to the broader
     * predicate keeps every saved contact suppressing its same-named twin,
     * which is the behaviour that shipped: the quiet failure (a distinct
     * same-named person stays hidden) rather than the loud one (a removed
     * contact reappears one line below the list she was just deleted from,
     * BACKLOG-2365). A warn rather than a breadcrumb is deliberate and
     * proportionate — unlike the picker's crosswalk read, whose failure
     * duplicates the entire list, this one is invisible either way.
     */
    logService.warn(
      `[Contacts] crosswalk unavailable for message-derived suppression; falling back to name-only matching: ${error}`,
      "ContactDbService",
    );
    const rows = dbAll<{ name: string }>(
      `SELECT LOWER(display_name) as name FROM contacts c
        WHERE c.user_id = ? AND ${KNOWN_CONTACT}`,
      [userId],
    );
    return new Set(rows.map((r) => r.name).filter(Boolean));
  }
}

/**
 * Get unique contacts derived from message participants (senders/recipients)
 * These are contacts who have sent/received messages but may not be explicitly imported.
 * Uses json_extract to parse the participants JSON field.
 */
export function getMessageDerivedContacts(userId: string): MessageDerivedContact[] {
  /**
   * =========================================================================
   * BACKLOG-2618 — TWO OF THE THREE FILTERS HERE COULD NEVER FIRE. DELETED.
   * =========================================================================
   * There were three, and reading them left the impression that a
   * message-derived person was matched against a saved contact on email, then
   * phone, then name. Two of the three were structurally incapable of firing:
   *
   *   email — the WHERE below excludes any `from` value containing `@`, so the
   *           projected `email` column is ALWAYS NULL and `contact.email &&`
   *           short-circuits on every row.
   *   phone — the same WHERE excludes `+%` and `[0-9]*`, so the projected
   *           `phone` column holds a DISPLAY NAME. It was compared against
   *           `LOWER(phone_e164)` values, which a display name cannot equal.
   *
   * DELETED RATHER THAN REPAIRED, deliberately. There is nothing to repair
   * them WITH: this projection's only input is `participants.from`, and the
   * rows it keeps are precisely the ones where that value is not an address.
   * A filter that cannot fire is worse than no filter, because it reads as
   * coverage — anyone auditing this function saw three identifiers being
   * checked and one was being checked. A control asserts the WHERE guarantee
   * directly, so this claim is measured rather than read off the source.
   *
   * =========================================================================
   * WHAT SURVIVES, AND WHAT IT NOW ASKS
   * =========================================================================
   * The name filter was the only live one, and it hid a message-derived person
   * whenever ANY saved contact carried the same display name. That is the rule
   * BACKLOG-2316 believed it had removed — 2316 removed it from the PICKER and
   * it was still here, feeding `contacts:get-all` and the activity-sorted list.
   *
   * THE HARM. Michael Chen the lender is a saved contact. A different Michael
   * Chen, a buyer's agent, texts the user. The second Michael never appeared in
   * Clients & Contacts, was never importable, and there was no disclosure and
   * no undo.
   *
   * So the question is narrowed from "does a saved contact share this name?"
   * to "does a saved contact exist whose ONLY identity IS this name?":
   *
   *   removed_at IS NOT NULL   — the user acted on this person (below), or
   *   no crosswalk row         — this contact has no address-book record behind
   *                              it, so its name is all it is.
   *
   * A contact WITH a `contact_source_links` row came from an address book: it
   * is an independent record whose name coincidence with a text sender is
   * exactly the Michael Chen guess, and it no longer suppresses.
   *
   * WHY NOT DELETE THE NAME FILTER OUTRIGHT — measured, not assumed. Importing
   * a message-derived row (`Contacts.tsx` → `contacts.import`) mints a contact
   * with a fresh uuid, and NO crosswalk row is possible for it: the
   * `contact_source_links.source_type` CHECK admits address-book sources only
   * (`macos`/`iphone`/`outlook`/`google_contacts`/`android_sync`), never
   * `messages`. Delete the name filter and the twin renders beside the contact
   * the user just created from it, permanently, with no undo — the same defect
   * class this change exists to remove. The `NOT EXISTS` clause is what covers
   * that case: the contact minted from the twin has no crosswalk row, so it
   * still suppresses it.
   *
   * RESIDUAL GAPS, RECORDED RATHER THAN SILENTLY CLOSED. A saved contact typed
   * by hand, or imported before the crosswalk existed, has no crosswalk row and
   * therefore still suppresses a same-named sender. Both converge as the
   * crosswalk fills; neither is closed here.
   *
   * =========================================================================
   * BACKLOG-2365 — A REMOVED CONTACT MUST STILL COUNT AS KNOWN. UNCHANGED.
   * =========================================================================
   * This is the one place in this file where a tombstoned row must still
   * count, and the predicate is the exact OPPOSITE of every other tombstone
   * filter here: elsewhere the question is "should this person be shown?",
   * here it is "do we already know about this person?".
   *
   * Get it wrong and the removal visibly undoes itself. Dana is a saved contact
   * who has texted the user. He removes her. She vanishes from the DB-backed
   * rows and reappears one line later as `msg_dana example`, because
   * getImportedContactsByUserId merges getMessageDerivedContacts into the very
   * list it just filtered — same person, same list, different guise. The
   * activity-sorted picker does the same.
   *
   * `removed_at IS NOT NULL` is therefore a term on its own, ORed BEFORE the
   * crosswalk clause and not folded into it: a removed contact suppresses its
   * twin whether or not it came from an address book.
   */
  const importedNames = namesThatAreTheirOwnIdentity(userId);

  // Extract unique senders from messages (from field in participants JSON)
  // BACKLOG-313: Only include senders with actual display names (filter out raw emails/phones)
  // BACKLOG-311: Include COUNT(*) to avoid N+1 queries
  const sql = `
    SELECT
      'msg_' || LOWER(json_extract(participants, '$.from')) as id,
      json_extract(participants, '$.from') as display_name,
      json_extract(participants, '$.from') as name,
      CASE
        WHEN json_extract(participants, '$.from') LIKE '%@%'
        THEN LOWER(json_extract(participants, '$.from'))
        ELSE NULL
      END as email,
      CASE
        WHEN json_extract(participants, '$.from') NOT LIKE '%@%'
        THEN json_extract(participants, '$.from')
        ELSE NULL
      END as phone,
      NULL as company,
      'messages' as source,
      0 as is_imported,
      1 as is_message_derived,
      MAX(sent_at) as last_communication_at,
      COUNT(*) as communication_count
    FROM messages
    WHERE user_id = ?
      AND participants IS NOT NULL
      AND json_extract(participants, '$.from') IS NOT NULL
      AND json_extract(participants, '$.from') != ''
      AND json_extract(participants, '$.from') != 'me'
      -- BACKLOG-313: Filter out entries where "name" is raw phone/email (no display name)
      AND json_extract(participants, '$.from') NOT LIKE '%@%'
      AND json_extract(participants, '$.from') NOT LIKE '+%'
      AND json_extract(participants, '$.from') NOT GLOB '[0-9]*'
      AND json_extract(participants, '$.from') NOT LIKE 'urn:%'
      -- BACKLOG-2280: reactions carry a sender but are not real communications.
      AND ${LOCAL_REACTION_EXCLUSION}
    GROUP BY LOWER(json_extract(participants, '$.from'))
    ORDER BY last_communication_at DESC
    LIMIT 200
  `;

  const results = dbAll<MessageDerivedContact>(sql, [userId]);

  // BACKLOG-2618: ONE filter, and it is the one that can fire. The email and
  // phone branches that stood above it are deleted — see the note at the top of
  // this function for why they could not have fired and why they were not
  // repairable.
  return results.filter(contact => {
    if (contact.display_name && importedNames.has(contact.display_name.toLowerCase())) {
      return false;
    }
    return true;
  });
}

/**
 * Normalize phone to E.164 format
 */
function normalizeToE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+')) return phone;
  return `+${digits}`;
}

/**
 * Create a new contact, its addresses, and the row saying where it came from —
 * AS ONE ATOMIC WRITE (BACKLOG-2496).
 *
 * ===========================================================================
 * WHAT A CRASH USED TO LEAVE, AND WHY IT WAS PERMANENT
 * ===========================================================================
 * This was 1 + N + M unwrapped statements followed by a SEPARATE origin call in
 * the handler. `better-sqlite3` is synchronous, so every statement outside a
 * transaction commits before the next line runs — meaning a throw partway
 * through left exactly the wreckage a crash would, with every earlier statement
 * already on disk. A throw is far likelier than a crash.
 *
 * Two intermediate states mattered:
 *
 *   CONTACT WITH NO ORIGIN — indistinguishable from a contact created by a path
 *     that never wrote one. BACKLOG-2510 produced this as a bug; BACKLOG-2525
 *     then read it as "this address-book entry is unclaimed" and made a
 *     duplicate on the next import.
 *
 *   CONTACT WITH ONLY SOME OF ITS ADDRESSES — and this one was PERMANENT AT THE
 *     TIME. Retrying the create hit the duplicate-by-name guard in
 *     `contacts:create`, which returned the existing contact and never re-ran
 *     the address backfill. The addresses the user typed were gone for good,
 *     with the save reported as successful. (That guard is itself deleted now —
 *     BACKLOG-2617 — so a retry would reach the backfill; the atomicity below
 *     is what makes the half-written state unreachable in the first place, and
 *     is the property this paragraph is really about.)
 *
 * Neither state is expressible now: one transaction, so either the contact,
 * every address, and the origin row all land, or none of them do.
 *
 * @param origin WHERE THIS CONTACT CAME FROM — required, and required on
 *   purpose. See `ContactOrigin`: a new create path that omits it does not
 *   compile, which is the property that stops this recurring the fifth time
 *   someone adds a caller.
 */
export async function createContact(
  contactData: NewContact,
  origin: ContactOrigin,
): Promise<Contact> {
  const id = crypto.randomUUID();
  const contactSource = contactData.source || "manual";

  dbTransaction(() => {
    const sql = `
      INSERT INTO contacts (
        id, user_id, display_name, company, title, source, is_imported
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      id,
      contactData.user_id,
      contactData.display_name || "Unknown",
      contactData.company || null,
      contactData.title || null,
      contactSource,
      contactData.is_imported !== undefined
        ? contactData.is_imported
          ? 1
          : 0
        : 1,
    ];

    dbRun(sql, params);

    // BACKLOG-2427: the VALUE-level provenance, translated from the contact-level
    // source. Both inserts below hard-coded 'import', which stamped every
    // hand-typed address as imported — and BACKLOG-2427 gives the unlink
    // permission to delete 'import' values. See utils/contactValueProvenance.
    const valueSource = contactInfoSourceFor(contactData.source);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extendedData = contactData as any;

    // Store ALL phones in contact_phones table
    // Use allPhones array if available, otherwise fall back to single phone
    const allPhones: string[] = extendedData.allPhones || [];
    const singlePhone = extendedData.phone;

    // If no allPhones but we have a single phone, use that
    if (allPhones.length === 0 && singlePhone) {
      allPhones.push(singlePhone);
    }

    // Track stored phones to avoid duplicates
    const storedPhones = new Set<string>();
    let isFirstPhone = true;

    for (const phone of allPhones) {
      if (!phone) continue;

      const phoneE164 = normalizeToE164(phone);
      const normalizedKey = phoneE164.replace(/\D/g, '').slice(-10);

      // Skip if we've already stored this normalized phone
      if (storedPhones.has(normalizedKey)) continue;
      storedPhones.add(normalizedKey);

      const phoneId = crypto.randomUUID();
      const phoneSql = `
        INSERT OR IGNORE INTO contact_phones (
          id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `;
      dbRun(phoneSql, [phoneId, id, phoneE164, phone, toLookupKey(phoneE164), isFirstPhone ? 1 : 0, valueSource]);
      isFirstPhone = false;
    }

    if (storedPhones.size > 0) {
      logService.info(`[Contacts] Stored ${storedPhones.size} phone(s) for contact ${id}`, "Contacts");
    }

    // Store ALL emails in contact_emails table
    // Use allEmails array if available, otherwise fall back to single email
    const allEmails: string[] = extendedData.allEmails || [];
    const singleEmail = extendedData.email;

    // If no allEmails but we have a single email, use that
    if (allEmails.length === 0 && singleEmail) {
      allEmails.push(singleEmail);
    }

    // Track stored emails to avoid duplicates
    const storedEmails = new Set<string>();
    let isFirstEmail = true;

    for (const email of allEmails) {
      if (!email) continue;

      const normalizedEmail = email.toLowerCase().trim();

      // Skip if we've already stored this email
      if (storedEmails.has(normalizedEmail)) continue;
      storedEmails.add(normalizedEmail);

      const emailId = crypto.randomUUID();
      const emailSql = `
        INSERT OR IGNORE INTO contact_emails (
          id, contact_id, email, is_primary, source, created_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `;
      dbRun(emailSql, [emailId, id, normalizedEmail, isFirstEmail ? 1 : 0, valueSource]);
      isFirstEmail = false;
    }

    if (storedEmails.size > 0) {
      logService.info(`[Contacts] Stored ${storedEmails.size} email(s) for contact ${id}`, "Contacts");
    }

    // LAST, AND INSIDE. Writing where the contact came from is part of creating
    // it, not a follow-up. This throws rather than logging on failure — see
    // `writeContactOriginInTransaction` for why the swallow that is right AFTER
    // a commit is wrong BEFORE one.
    writeContactOriginInTransaction(contactData.user_id, id, contactSource, origin);
  });

  // Read back AFTER the commit: the row is now durable, and this is a read, so
  // it has no business holding the write transaction open.
  const contact = await getContactById(id);
  if (!contact) {
    throw new DatabaseError("Failed to create contact");
  }
  return contact;
}

/**
 * Batch create contacts, each with the row saying where it came from, in ONE
 * transaction (BACKLOG-2496).
 *
 * The contacts, phones and emails were already atomic here — the bulk insert has
 * never been the fragile part. THE CROSSWALK ROWS WERE NOT: they were written by
 * the import handler afterwards, outside this transaction, so an interruption
 * left contacts committed with no origin. That is the state BACKLOG-2525's
 * duplicate guard reads as "this address-book entry is unclaimed", which makes
 * the next press create a second contact.
 *
 * `origin` is REQUIRED per contact for the same reason it is required on
 * `createContact` — see `ContactOrigin`.
 */
export function createContactsBatch(
  contacts: Array<{
    user_id: string;
    display_name: string;
    email?: string;
    phone?: string;
    company?: string;
    title?: string;
    source?: string;
    is_imported?: boolean;
    allPhones?: string[];
    allEmails?: string[];
    /** WHERE THIS CONTACT CAME FROM. Required — a caller that omits it does not compile. */
    origin: ContactOrigin;
  }>,
  onProgress?: (current: number, total: number) => void
): string[] {
  const createdIds: string[] = [];
  const total = contacts.length;

  // Wrap entire operation in a transaction for 10-100x speedup
  dbTransaction(() => {
    for (let i = 0; i < contacts.length; i++) {
      const contactData = contacts[i];
      const id = crypto.randomUUID();
      createdIds.push(id);

      // Insert contact
      dbRun(
        `INSERT INTO contacts (id, user_id, display_name, company, title, source, is_imported)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          contactData.user_id,
          contactData.display_name || "Unknown",
          contactData.company || null,
          contactData.title || null,
          contactData.source || "contacts_app",
          contactData.is_imported !== undefined ? (contactData.is_imported ? 1 : 0) : 1,
        ]
      );

      // Store phones
      const allPhones = contactData.allPhones || [];
      if (allPhones.length === 0 && contactData.phone) {
        allPhones.push(contactData.phone);
      }
      const storedPhones = new Set<string>();
      let isFirstPhone = true;
      for (const phone of allPhones) {
        if (!phone) continue;
        const phoneE164 = normalizeToE164(phone);
        const normalizedKey = phoneE164.replace(/\D/g, '').slice(-10);
        if (storedPhones.has(normalizedKey)) continue;
        storedPhones.add(normalizedKey);
        dbRun(
          `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
          [crypto.randomUUID(), id, phoneE164, phone, toLookupKey(phoneE164), isFirstPhone ? 1 : 0]
        );
        isFirstPhone = false;
      }

      // Store emails
      const allEmails = contactData.allEmails || [];
      if (allEmails.length === 0 && contactData.email) {
        allEmails.push(contactData.email);
      }
      if (allEmails.length > 1) {
        logService.warn(`[DIAG-1270] Batch create: ${contactData.display_name} → storing ${allEmails.length} emails: ${allEmails.join(', ')}`, 'ContactDbService');
      }
      const storedEmails = new Set<string>();
      let isFirstEmail = true;
      for (const email of allEmails) {
        if (!email) continue;
        const normalizedEmail = email.toLowerCase().trim();
        if (storedEmails.has(normalizedEmail)) continue;
        storedEmails.add(normalizedEmail);
        dbRun(
          `INSERT OR IGNORE INTO contact_emails (id, contact_id, email, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
          [crypto.randomUUID(), id, normalizedEmail, isFirstEmail ? 1 : 0]
        );
        isFirstEmail = false;
      }
      logService.warn(`[DIAG-1270] Batch create: ${contactData.display_name} → ${storedEmails.size} emails stored (from ${allEmails.length} input)`, 'ContactDbService');

      // INSIDE the batch transaction, with the contact it describes. Written
      // here rather than by the caller afterwards so that an interrupted import
      // cannot leave a contact whose address-book entry still reads as
      // unclaimed (BACKLOG-2496, and the re-arming of BACKLOG-2525).
      writeContactOriginInTransaction(
        contactData.user_id,
        id,
        contactData.source || "contacts_app",
        contactData.origin,
      );

      // Report progress every 50 contacts
      if (onProgress && (i + 1) % 50 === 0) {
        onProgress(i + 1, total);
      }
    }
  });

  // Final progress update
  if (onProgress) {
    onProgress(total, total);
  }

  return createdIds;
}

/**
 * Get contact by ID
 */
export async function getContactById(contactId: string): Promise<Contact | null> {
  const sql = `
    SELECT c.*,
      c.display_name as name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone,
      (SELECT json_group_array(email) FROM contact_emails WHERE contact_id = c.id) as all_emails_json,
      (SELECT json_group_array(phone_e164) FROM contact_phones WHERE contact_id = c.id) as all_phones_json
    FROM contacts c
    WHERE c.id = ?
  `;
  const row = dbGet<Contact & { all_emails_json?: string; all_phones_json?: string }>(sql, [contactId]);
  if (!row) return null;

  // BACKLOG-2514: the same shared parse the list producers use.
  const { allEmails, allPhones, ...rest } = withParsedAddresses(row);
  // BACKLOG-2472: the live crosswalk set, so a single-contact read reports the
  // same sources the list does. Omitted (not emptied) when there are no links —
  // see the `source_types` doc on the Contact interface.
  const liveSources = getLiveSourcesForContact(contactId);
  const contact = {
    ...rest,
    allEmails,
    allPhones,
    ...(liveSources.length > 0 ? { source_types: liveSources } : {}),
  } as Contact;
  return validateResponse(ContactSchema, contact, 'contactDbService.getContactById') as Contact;
}

/*
 * `findContactByName` USED TO LIVE HERE. IT IS DELETED (BACKLOG-2617).
 *
 *     SELECT * FROM contacts
 *      WHERE user_id = ? AND LOWER(display_name) = LOWER(?) AND is_imported = 1
 *
 * Name only. No email, no phone, no `removed_at` filter — the loosest identity
 * rule this codebase has held. Every other heuristic here requires at least a
 * shared identifier; this one asked whether two strings matched and answered
 * "same person".
 *
 * Its single production caller was `contacts:create`, which on a hit returned
 * the OTHER person's contact and reported success, having created nothing. The
 * handler carries the founder's decision and what the branch cost a user.
 *
 * It is deleted rather than left callable, on purpose. A helper kept "in case"
 * is how a deleted rule grows a second call site. If some future caller
 * genuinely needs to find people by name, it will need a rule that says what to
 * do about the SECOND person with that name — a product question, not a lookup.
 */

/**
 * Get all contacts for a user
 */
export async function getContacts(filters?: ContactFilters): Promise<Contact[]> {
  let sql = "SELECT * FROM contacts WHERE 1=1";
  const params: unknown[] = [];

  // BACKLOG-2365: removed contacts are hidden unless a caller explicitly asks
  // for them. See ContactFilters.include_removed for why the CCPA export does.
  if (!filters?.include_removed) {
    sql += ACTIVE_CONTACTS_CLAUSE_UNALIASED;
  }

  if (filters?.user_id) {
    sql += " AND user_id = ?";
    params.push(filters.user_id);
  }

  if (filters?.source) {
    sql += " AND source = ?";
    params.push(filters.source);
  }

  if (filters?.is_imported !== undefined) {
    sql += " AND is_imported = ?";
    params.push(filters.is_imported ? 1 : 0);
  }

  sql += " ORDER BY display_name ASC";

  return dbAll<Contact>(sql, params);
}

/**
 * Get only imported contacts for a user
 * Returns contacts with display_name aliased as 'name' for backwards compatibility
 * Also includes primary email and phone from child tables
 */
/** The two raw JSON aggregate columns `IMPORTED_CONTACT_ADDRESSES_SQL` projects. */
interface ContactAddressAggregates {
  all_emails_json?: string;
  all_phones_json?: string;
}

/**
 * Turn the raw address aggregates into the arrays the RENDERER reads, and drop
 * the raw columns (BACKLOG-2514).
 *
 * ONE implementation, because the SQL is now one constant and the parse must
 * not be the place the producers diverge instead. The renderer's matcher reads
 * `allEmails` / `allPhones` and NOTHING in `src/` reads `all_emails_json` — so
 * a producer that selects the columns and skips this step searches exactly as
 * badly as one that never selected them, while looking in a debugger as though
 * the data arrived. That is precisely how this item's fix shipped half-done in
 * review: the SQL was widened and the parse was not added.
 *
 * `null` entries are filtered because `json_group_array` over a contact with no
 * addresses yields `[null]`, not `[]`.
 */
function withParsedAddresses<T extends ContactAddressAggregates>(
  row: T,
): Omit<T, "all_emails_json" | "all_phones_json"> & { allEmails: string[]; allPhones: string[] } {
  const allEmails: string[] = row.all_emails_json
    ? JSON.parse(row.all_emails_json).filter((e: string | null) => e !== null)
    : [];
  const allPhones: string[] = row.all_phones_json
    ? JSON.parse(row.all_phones_json).filter((p: string | null) => p !== null)
    : [];
  const { all_emails_json: _e, all_phones_json: _p, ...rest } = row;
  return { ...rest, allEmails, allPhones };
}

/** `withParsedAddresses` over a result set. */
function parseContactAddressAggregates<T extends ContactAddressAggregates>(
  rows: T[],
): Array<Omit<T, "all_emails_json" | "all_phones_json"> & { allEmails: string[]; allPhones: string[] }> {
  return rows.map(withParsedAddresses);
}

/**
 * Message-derived people, shaped as `Contact` rows (BACKLOG-2514).
 *
 * ONE mapper, because there were two and they had already disagreed. The sync
 * producer merged these people and the worker producer did not, so Clients &
 * Contacts showed a DIFFERENT SET depending on whether the worker pool happened
 * to be warm — same user, same data, same screen. The pool is cold whenever its
 * init timeout fires, which is exactly what CPU starvation does (BACKLOG-2576),
 * so this was reachable in the field and silent when it happened.
 *
 * BACKLOG-2472: these are NOT stamped with live sources. They are synthesised
 * from message participants rather than address-book records, so they have no
 * crosswalk rows by construction and must keep answering to their `source`
 * scalar — which is what the Inferred filter reads.
 */
function messageDerivedAsContacts(userId: string): Contact[] {
  return getMessageDerivedContacts(userId).map(
    (mc) =>
      ({
        id: mc.id,
        user_id: userId,
        display_name: mc.display_name,
        name: mc.name,
        email: mc.email,
        phone: mc.phone,
        company: mc.company,
        source: mc.source,
        is_imported: mc.is_imported,
        is_message_derived: mc.is_message_derived,
        last_communication_at: mc.last_communication_at,
      }) as Contact,
  );
}

export async function getImportedContactsByUserId(
  userId: string,
): Promise<Contact[]> {
  // BACKLOG-2514: THE imported-contacts statement, shared with the worker's
  // `runImportedQuery` rather than duplicated beside it. It used to be two
  // copies required to stay byte-identical — they had not yet drifted, and now
  // they cannot.
  const sql = IMPORTED_CONTACTS_SELECT_SQL;
  const importedContacts = dbAll<Contact & { all_emails_json?: string; all_phones_json?: string }>(sql, [userId]);

  // BACKLOG-2514: one shared parse. The SQL is a shared constant now, so the
  // parse must not become the place the producers diverge instead.
  const contactsWithArrays = parseContactAddressAggregates(importedContacts) as unknown as Contact[];

  // Merge both lists — imported contacts first (with allEmails/allPhones), then
  // message-derived. The mapper lives in `messageDerivedAsContacts` so this path
  // and the worker path cannot disagree about who appears (BACKLOG-2514); the
  // BACKLOG-2472 reasoning about stamping is recorded there.
  // BACKLOG-2471 PR F: `review_state` is stamped wherever `source_types` is.
  // A producer that stamps one and not the other returns a contact carrying
  // half its state, and the missing half is the one the compare screen routes
  // on — an unflagged row that intercepts anyway, or a flagged one that opens
  // an ordinary card.
  const allContacts = [
    ...attachReviewState(userId, attachLiveSources(userId, contactsWithArrays)),
    ...messageDerivedAsContacts(userId),
  ];

  // Sort alphabetically by display_name/name
  return allContacts.sort((a, b) => {
    const nameA = (a.display_name || a.name || '').toLowerCase();
    const nameB = (b.display_name || b.name || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

/**
 * TASK-1956: Async version of getImportedContactsByUserId that runs the SQL
 * in a worker thread via the persistent worker pool. This prevents blocking
 * the Electron main process — no new Worker() spawn per query.
 *
 * Falls back to sync version if pool is not ready.
 */
export async function getImportedContactsByUserIdAsync(
  userId: string,
  timeoutMs: number = 30_000,
): Promise<Contact[]> {
  if (!isPoolReady()) {
    // Fallback to sync version if pool not initialized
    return getImportedContactsByUserId(userId);
  }

  // Run imported contacts SQL in persistent worker thread
  const rawRows = await queryContacts('imported', userId, timeoutMs) as Array<Contact & { all_emails_json?: string; all_phones_json?: string }>;

  // Post-process: parse JSON arrays (fast, no DB access). BACKLOG-2514: the
  // same shared parse the main-thread producer uses.
  const contactsWithArrays = parseContactAddressAggregates(rawRows) as unknown as Contact[];

  // BACKLOG-2472: the crosswalk read stays on the MAIN thread rather than being
  // folded into the worker's SQL. BACKLOG-2514 made that SQL ONE shared constant
  // (IMPORTED_CONTACTS_SELECT_SQL) rather than two copies required to stay
  // byte-identical, so the drift hazard is gone — but the read still belongs
  // here: it needs the main thread's database handle. This is ONE indexed
  // statement over a result smaller than the contact list the worker just
  // returned; the work the pool exists to move off the main thread — the
  // per-contact email/phone/recency subqueries — is untouched.
  // BACKLOG-2514: merge message-derived people, exactly as the sync producer
  // does. Without this the SAME SCREEN showed a different set of people
  // depending on whether the worker pool was warm — the fallback above is the
  // only difference between the two paths, and it must not change WHO appears.
  // BACKLOG-2471 PR F — stamped here too; see the sync producer above.
  return [
    ...attachReviewState(userId, attachLiveSources(userId, contactsWithArrays)),
    ...messageDerivedAsContacts(userId),
  ].sort(
    (a, b) => {
      const nameA = (a.display_name || a.name || '').toLowerCase();
      const nameB = (b.display_name || b.name || '').toLowerCase();
      return nameA.localeCompare(nameB);
    },
  );
}

/**
 * Get unimported contacts for a user (available to import)
 * These are contacts synced from iPhone that haven't been imported yet.
 *
 * BACKLOG-1689 / BACKLOG-1727: Populates `last_communication_at` from
 * `phone_last_message` so message-derived externals sort by recency in the
 * contact picker rather than dropping to the bottom with NULL timestamps.
 * The JOIN is keyed on `contact_phones.phone_normalized`, which is populated
 * via the shared `toLookupKey` helper at insert time and matches
 * the writer-side normalization stored in `phone_last_message.phone_normalized`.
 */
export async function getUnimportedContactsByUserId(
  userId: string,
): Promise<Contact[]> {
  const sql = `
    SELECT
      c.*,
      c.display_name as name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone,
      (
        SELECT MAX(plm.last_message_at)
        FROM contact_phones cp
        JOIN phone_last_message plm
          ON plm.user_id = c.user_id
         AND plm.phone_normalized = cp.phone_normalized
        WHERE cp.contact_id = c.id
          AND cp.phone_normalized IS NOT NULL
      ) as last_communication_at
    FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 0${ACTIVE_CONTACTS_CLAUSE_C}
    ORDER BY c.display_name ASC
  `;
  return dbAll<Contact>(sql, [userId]);
}

/**
 * Mark a contact as imported (change is_imported from 0 to 1)
 * Optionally update the source field (e.g., when importing from macOS Contacts)
 * @param contactId - The contact ID to update
 * @param source - Optional source to set (e.g., "contacts_app")
 */
export async function markContactAsImported(contactId: string, source?: string): Promise<void> {
  if (source) {
    const sql =
      "UPDATE contacts SET is_imported = 1, source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?";
    dbRun(sql, [source, contactId]);
  } else {
    const sql =
      "UPDATE contacts SET is_imported = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?";
    dbRun(sql, [contactId]);
  }
}

/**
 * Backfill emails for a contact from external source (e.g., macOS Contacts)
 * Only adds emails that don't already exist in the junction table.
 *
 * Thin wrapper over the SYNC core. Kept `async` because every existing caller
 * awaits it; see `backfillContactEmailsSync` for why the core is separate.
 */
export async function backfillContactEmails(
  contactId: string,
  emails: string[],
  source: ContactInfoSource = "import",
): Promise<number> {
  return backfillContactEmailsSync(contactId, emails, source);
}

/**
 * The synchronous core of `backfillContactEmails` (BACKLOG-2423).
 *
 * better-sqlite3 is synchronous, so this function always was — the `async` on
 * the wrapper is a calling convention, not concurrency. It is exposed because
 * the crosswalk link sites that must now trigger a copy (`contactSourceLinker`,
 * `contactNameAutoLink`, `contactLinkReview`) are synchronous and run INSIDE
 * `dbTransaction`. Awaiting there would either be impossible or would resolve
 * after the transaction had closed.
 *
 * One implementation, two entry points: the async wrapper delegates here, so
 * the insert rule cannot drift between the two call styles.
 */
export function backfillContactEmailsSync(
  contactId: string,
  emails: string[],
  /**
   * BACKLOG-2427: defaults to 'import' because the crosswalk backfill — the
   * caller this was written for — genuinely is importing. The manual-create
   * path passes 'manual', because it is not: `contacts:create` routes the form's
   * `allEmails` array through here, and stamping those 'import' let the unlink
   * delete addresses the user had typed.
   */
  source: ContactInfoSource = "import",
): number {
  if (!emails || emails.length === 0) return 0;

  let added = 0;
  const storedEmails = new Set<string>();

  // Get existing emails for this contact
  const existingSql = "SELECT LOWER(email) as email FROM contact_emails WHERE contact_id = ?";
  const existingRows = dbAll<{ email: string }>(existingSql, [contactId]);
  logService.warn(`[DIAG-1270] Backfill emails for ${contactId}: input=${emails.length} emails [${emails.join(', ')}], existing=${existingRows.length}`, 'ContactDbService');
  for (const row of existingRows) {
    storedEmails.add(row.email);
  }

  // Add any new emails
  for (const email of emails) {
    if (!email) continue;

    const normalizedEmail = email.toLowerCase().trim();
    if (storedEmails.has(normalizedEmail)) continue;
    storedEmails.add(normalizedEmail);

    const emailId = crypto.randomUUID();
    const isPrimary = existingRows.length === 0 && added === 0 ? 1 : 0;
    const emailSql = `
      INSERT OR IGNORE INTO contact_emails (
        id, contact_id, email, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;
    const result = dbRun(emailSql, [emailId, contactId, normalizedEmail, isPrimary, source]);
    // Only count as added if the insert actually happened (changes > 0)
    if (result.changes > 0) {
      added++;
    }
  }

  logService.warn(`[DIAG-1270] Backfill emails for ${contactId}: added=${added}`, 'ContactDbService');
  if (added > 0) {
    logService.info(`[Contacts] Backfilled ${added} email(s) for contact ${contactId}`, "Contacts");
  }

  return added;
}

/**
 * Backfill phones for a contact from external source (e.g., macOS Contacts)
 * Only adds phones that don't already exist in the junction table.
 *
 * Thin wrapper over the SYNC core — see `backfillContactEmailsSync`.
 */
export async function backfillContactPhones(
  contactId: string,
  phones: string[],
  source: ContactInfoSource = "import",
): Promise<number> {
  return backfillContactPhonesSync(contactId, phones, source);
}

/** The synchronous core of `backfillContactPhones` (BACKLOG-2423). */
export function backfillContactPhonesSync(
  contactId: string,
  phones: string[],
  /** See `backfillContactEmailsSync` — same rule, same reason. */
  source: ContactInfoSource = "import",
): number {
  if (!phones || phones.length === 0) return 0;

  let added = 0;
  const storedPhones = new Set<string>();

  // Get existing phones for this contact (normalized to last 10 digits)
  const existingSql = "SELECT phone_e164 FROM contact_phones WHERE contact_id = ?";
  const existingRows = dbAll<{ phone_e164: string }>(existingSql, [contactId]);
  for (const row of existingRows) {
    const normalized = row.phone_e164.replace(/\D/g, '').slice(-10);
    storedPhones.add(normalized);
  }

  // Add any new phones
  for (const phone of phones) {
    if (!phone) continue;

    const phoneE164 = normalizeToE164(phone);
    const normalizedKey = phoneE164.replace(/\D/g, '').slice(-10);

    if (storedPhones.has(normalizedKey)) continue;
    storedPhones.add(normalizedKey);

    const phoneId = crypto.randomUUID();
    const isPrimary = existingRows.length === 0 && added === 0 ? 1 : 0;
    const phoneSql = `
      INSERT OR IGNORE INTO contact_phones (
        id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;
    const result = dbRun(phoneSql, [phoneId, contactId, phoneE164, phone, toLookupKey(phoneE164), isPrimary, source]);
    // Only count as added if the insert actually happened (changes > 0)
    if (result.changes > 0) {
      added++;
    }
  }

  if (added > 0) {
    logService.info(`[Contacts] Backfilled ${added} phone(s) for contact ${contactId}`, "Contacts");
  }

  return added;
}

/**
 * Backfill last_inbound_at for contacts from their messages.
 * Uses a simpler approach: get max message date per phone, then update contacts.
 */
export async function backfillContactCommunicationDates(userId: string): Promise<number> {
  // Step 1: Get the most recent message date for each normalized phone number
  // This is the simple GROUP BY approach the user suggested
  const phoneMessagesSql = `
    SELECT
      SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) as normalized_phone,
      cp.contact_id,
      MAX(m.sent_at) as last_msg_date
    FROM contact_phones cp
    JOIN contacts c ON cp.contact_id = c.id AND c.user_id = ? AND c.is_imported = 1
    JOIN messages m ON (
      m.user_id = ?
      AND (m.channel = 'sms' OR m.channel = 'imessage')
      AND ${reactionExclusion("m")}
      AND m.participants_flat LIKE '%' || SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) || '%'
    )
    WHERE LENGTH(SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)) >= 7
    GROUP BY cp.contact_id
  `;

  const phoneMessages = dbAll<{ normalized_phone: string; contact_id: string; last_msg_date: string }>(
    phoneMessagesSql,
    [userId, userId]
  );

  logService.info("Backfill: Found phone-message matches", "ContactDbService", {
    matchCount: phoneMessages.length,
    samples: phoneMessages.slice(0, 5).map(p => ({
      contactId: p.contact_id.substring(0, 8),
      phone: p.normalized_phone,
      lastDate: p.last_msg_date,
    })),
  });

  // Step 2: Update each contact with their most recent message date
  let updatedCount = 0;
  for (const match of phoneMessages) {
    const updateSql = `
      UPDATE contacts
      SET last_inbound_at = ?
      WHERE id = ? AND (last_inbound_at IS NULL OR last_inbound_at < ?)
    `;
    const result = dbRun(updateSql, [match.last_msg_date, match.contact_id, match.last_msg_date]);
    updatedCount += result.changes;
  }

  // Debug: Show final state
  const debugSql = `
    SELECT c.display_name, c.last_inbound_at
    FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 1
    ORDER BY c.last_inbound_at DESC NULLS LAST
    LIMIT 10
  `;
  const debugContacts = dbAll<{ display_name: string; last_inbound_at: string | null }>(debugSql, [userId]);

  logService.info("Backfill complete", "ContactDbService", {
    userId,
    updatedCount,
    topContacts: debugContacts.map(c => ({
      name: c.display_name,
      lastInbound: c.last_inbound_at,
    })),
  });

  return updatedCount;
}

/**
 * Get contacts sorted by recent communication and optionally by property address relevance
 * SIMPLIFIED: Uses denormalized last_inbound_at column with simple ORDER BY
 */
export async function getContactsSortedByActivity(
  userId: string,
  _propertyAddress?: string,
): Promise<ContactWithActivity[]> {
  // Check if backfill has ever run (single lightweight query)
  // BACKLOG-2365: removed contacts excluded so the probe matches the population
  // the backfill and the list below actually operate on. Without this, a user
  // whose only dated contacts had all been removed would keep re-running the
  // backfill on every call.
  const hasBackfilled = dbGet<{ count: number }>(`
    SELECT COUNT(*) as count FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 1 AND c.last_inbound_at IS NOT NULL${ACTIVE_CONTACTS_CLAUSE_C}
  `, [userId]);

  // Only run backfill once - if no contacts have dates yet
  if (!hasBackfilled || hasBackfilled.count === 0) {
    await backfillContactCommunicationDates(userId);
  }

  // Get contacts sorted by last_inbound_at (denormalized field)
  const contactsSql = `
    SELECT
      c.*,
      c.display_name as name,
      -- BACKLOG-2514: the SAME projection the get-all path uses. This query
      -- previously returned only the PRIMARY email and phone, so the picker's
      -- matcher received empty allEmails / allPhones on the transaction wizard
      -- and add-to-existing: a second address was unsearchable exactly where a
      -- user is building a deal.
      --
      -- It also read its primary through LEFT JOIN ... AND is_primary = 1,
      -- which returned NULL for a contact with no primary flag and MULTIPLIED
      -- the row for a contact with two. The correlated LIMIT 1 form cannot do
      -- either. The two JOINs are gone with it.
${IMPORTED_CONTACT_ADDRESSES_SQL},
      0 as is_message_derived,
      -- BACKLOG-2357: use the SHARED phone+email recency fragment (was the
      -- phone-only COALESCE(c.last_inbound_at, c.last_outbound_at)) so the
      -- TRANSACTION flows (Add Contacts / audit wizard) compute the SAME
      -- last_communication_at as the external path (EXTERNAL_CONTACT_LAST_MESSAGE_EXPR)
      -- and the get-all path (getImportedContactsByUserId). The fragment aliases
      -- itself as last_communication_at and correlates on the contacts alias c
      -- (this query's FROM is "contacts c"); no GROUP BY needed (scalar MAX over
      -- correlated scalar subqueries). Kills the email-only select-jump at the
      -- root: a freshly-imported EMAIL-ONLY contact keeps its real email date here
      -- instead of reading NULL (the denormalized last_inbound_at/last_outbound_at
      -- columns are backfilled from PHONE/SMS/iMessage only, never email).
      ${IMPORTED_CONTACT_LAST_COMMUNICATION_SQL},
      CASE WHEN c.last_inbound_at IS NOT NULL OR c.last_outbound_at IS NOT NULL THEN 1 ELSE 0 END as communication_count,
      0 as address_mention_count
    FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 1${ACTIVE_CONTACTS_CLAUSE_C}
    ORDER BY
      COALESCE(c.last_inbound_at, c.last_outbound_at) DESC,
      c.display_name ASC
  `;

  try {
    // BACKLOG-2514: parse the address aggregates into the arrays the RENDERER
    // actually reads.
    //
    // Widening the SQL is only half the fix and the half that looks finished.
    // The picker's matcher reads `contact.allEmails` / `contact.allPhones`
    // (contactPickerList.ts) and nothing anywhere in `src/` reads
    // `all_emails_json` — so a row carrying the raw JSON string and no arrays
    // searches exactly as badly as one that never selected the columns, while
    // looking in a debugger as though the data arrived. Without this step every
    // gate stays green and the reported bug stays live on both transaction
    // screens.
    const importedContacts = parseContactAddressAggregates(
      dbAll<ContactWithActivity & ContactAddressAggregates>(contactsSql, [userId]),
    );

    // Get message-derived contacts (already have last_communication_at from their source)
    const messageDerivedContacts = getMessageDerivedContacts(userId);

    const messageDerivedWithActivity: ContactWithActivity[] = messageDerivedContacts.map(mc => ({
      id: mc.id,
      user_id: userId,
      display_name: mc.display_name,
      name: mc.name,
      email: mc.email,
      phone: mc.phone,
      company: mc.company,
      source: mc.source,
      is_imported: mc.is_imported,
      is_message_derived: mc.is_message_derived,
      last_communication_at: mc.last_communication_at,
      communication_count: mc.communication_count,
      address_mention_count: 0,
    } as ContactWithActivity));

    // BACKLOG-2472: stamp the live crosswalk set on the imported bucket only —
    // the message-derived bucket has no source records to link to.
    // BACKLOG-2471 PR F — the THIRD producer, and the one easiest to miss. A
    // contact reached through the activity sort would otherwise carry
    // `source_types` and no review flag.
    const importedWithSources = attachReviewState(
      userId,
      attachLiveSources(userId, importedContacts),
    );

    // BACKLOG-1745 Part 1: unified iPhone-Messages-style sort across both buckets.
    // Previously concatenated [...imported, ...messageDerived], which bucketed
    // imported contacts at top regardless of recency. That undermined BACKLOG-1689's
    // intent (shipped May 29 via #1750 + #1764 + #1767) of a single chronological
    // list. Now: combine, then sort by last_communication_at DESC with NULLS-LAST
    // and display_name ASC tie-break.
    const combined = [...importedWithSources, ...messageDerivedWithActivity];
    return combined.sort((a, b) => {
      // NULLS-LAST: treat null/undefined as oldest so DESC pushes them to the end.
      const aTs = a.last_communication_at ? new Date(a.last_communication_at).getTime() : 0;
      const bTs = b.last_communication_at ? new Date(b.last_communication_at).getTime() : 0;
      const aValid = Number.isFinite(aTs) ? aTs : 0;
      const bValid = Number.isFinite(bTs) ? bTs : 0;
      if (aValid !== bValid) return bValid - aValid; // DESC: most recent first
      // Tie-break: display_name ASC (case-insensitive)
      const aName = (a.display_name || "").toLowerCase();
      const bName = (b.display_name || "").toLowerCase();
      return aName.localeCompare(bName);
    });
  } catch (error) {
    logService.error("Error getting sorted contacts", "ContactDbService", {
      error: (error as Error).message,
      userId,
    });
    throw error;
  }
}

/**
 * Search contacts by name or email
 */
export async function searchContacts(
  query: string,
  userId: string,
): Promise<Contact[]> {
  const sql = `
    SELECT * FROM contacts
    WHERE user_id = ?${ACTIVE_CONTACTS_CLAUSE_UNALIASED} AND (display_name LIKE ? OR display_name LIKE ?)
    ORDER BY display_name ASC
  `;
  const searchPattern = `%${query}%`;
  return dbAll<Contact>(sql, [userId, searchPattern, searchPattern]);
}

/*
 * BACKLOG-2621 — `getContactByPhone` DELETED. It had no callers beyond a
 * one-line pass-through on `databaseService`, which is deleted with it.
 *
 * It is removed rather than fixed because leaving it invited someone to wire it
 * up: it read like the phone lookup, sat next to the real one, and was wrong in
 * a way that would not show up in a test written against a single user's data.
 * It carried NO `user_id` predicate at all, so it would happily return another
 * account's contact, and it matched with
 * `REPLACE(...) LIKE '%<key>'` — a trailing-wildcard pattern, which is both
 * unindexable and a suffix match rather than an equality one.
 *
 * The lookup to use is `findContactByNormalizedPhone` below: scoped by user,
 * compares `contact_phones.phone_normalized`, served by an index.
 */

/**
 * Synchronous phone lookup scoped by user_id.
 * Used by Android contact promotion to check for duplicates before
 * creating entries in the main contacts table.
 *
 * BACKLOG-1469: Added to support contact promotion dedup.
 *
 * ===========================================================================
 * BACKLOG-2621 — compares `phone_normalized`, not a re-derived key
 * ===========================================================================
 * This used to compute the lookup key inside the query:
 *
 *   SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(phone_e164,'+',''),'-',''),' ',''),'(',''), -10)
 *
 * which no index can serve, and which was a THIRD implementation of
 * last-ten-digits — one in SQL here, one in `toLookupKey`, one in the caller
 * (`localSyncService`, which strips `\D` and slices before calling). The two
 * did not agree. The SQL copy strips only `+`, `-`, space and `(` — not `)`
 * and not `.` — so for a number stored with punctuation it produced a
 * different key from `toLookupKey`, and `contact_phones.phone_normalized`
 * holds the `toLookupKey` one.
 *
 * THIS IS A BEHAVIOUR DELTA, AND IT IS THE ONE INTENTIONAL ONE IN BACKLOG-2621.
 * `syncContactPhones` — the contact-edit path — writes `p.phone.trim()` into
 * `phone_e164` verbatim, so a number typed by hand as "(415) 555-0109" is
 * stored in that shape. The old SQL reduced it to "15)5550109" and therefore
 * MISSED it; matching on `phone_normalized` ("4155550109") FINDS it. The
 * effect is on Android contact promotion: a hand-entered number that today
 * gets promoted a second time as a duplicate is now recognised as existing.
 * Rows written through `toE164` (every import path) are "+" plus digits, for
 * which the two forms are byte-identical — so nothing shifts for imported
 * contacts. Both halves of that claim are pinned by
 * `matchingIndexUsage.test.ts`, which builds its corpus
 * by calling the real write paths rather than hand-writing rows.
 *
 * `+c.user_id` is the SQLite no-op prefix — see the long note in
 * `contactSourceLinker.ts`. It leaves the result set alone and stops the term
 * anchoring `contacts` as the outer loop, which is what lets
 * `idx_contact_phones_normalized` drive the join.
 *
 * ===========================================================================
 * WHAT `normalizedPhone` MUST BE — BACKLOG-2630. READ THIS BEFORE CALLING.
 * ===========================================================================
 * A key produced by `toLookupKey` (or `toMatchingKey`, which is the same key
 * above the digit floor) — NOT "the last ten digits". Since BACKLOG-2630 the
 * key is the libphonenumber-parsed E.164 digits, so a US number keys as
 * "14155550109" and migration v64 re-keyed every stored row to match.
 *
 * The old wording of this line said "last 10 digits", and a caller that
 * believed it hand-rolled `digits.slice(-10)`, asked for "4155550109", and got
 * null for every real number on file — which made the Android promotion dedup
 * treat the entire address book as new (SR blocker B1 on PR #2346, fixed at
 * `localSyncService.promoteToMainContacts`). Compute the key, never transcribe
 * the rule.
 *
 * @param userId - Owning user ID
 * @param normalizedPhone - A `toLookupKey`/`toMatchingKey` key. See above.
 * @returns Contact ID and display_name if found, null otherwise
 */
export function findContactByNormalizedPhone(
  userId: string,
  normalizedPhone: string
): { id: string; display_name: string } | null {
  if (!normalizedPhone || normalizedPhone.length < 7) {
    return null;
  }

  const sql = `
    SELECT
      c.id,
      c.display_name
    FROM contacts c
    JOIN contact_phones cp ON c.id = cp.contact_id
    WHERE +c.user_id = ?
      AND cp.phone_normalized = ?
    LIMIT 1
  `;

  const result = dbGet<{ id: string; display_name: string }>(sql, [userId, normalizedPhone]);
  return result || null;
}

/**
 * BACKLOG-1762: Build an email address -> contact display_name map for a user.
 *
 * Email views (thread chat bubbles, single-email From/To/CC lines, email list
 * rows) use this to resolve display names when the email header carries no name.
 * Keys are lowercase email addresses.
 *
 * When the same address maps to multiple contacts, imported + primary rows win
 * (ORDER BY ... DESC + keep-first) so the "best" display name is chosen. Rows
 * with an empty address or empty/whitespace display_name are skipped.
 *
 * Read-only; safe to call frequently (the renderer caches the result per user).
 */
export function getEmailNameMap(userId: string): Record<string, string> {
  const sql = `
    SELECT LOWER(ce.email) AS email, c.display_name AS display_name
    FROM contact_emails ce
    JOIN contacts c ON ce.contact_id = c.id
    WHERE c.user_id = ?
      AND ce.email IS NOT NULL AND TRIM(ce.email) != ''
      AND c.display_name IS NOT NULL AND TRIM(c.display_name) != ''
    ORDER BY c.is_imported DESC, ce.is_primary DESC
  `;
  const rows = dbAll<{ email: string; display_name: string }>(sql, [userId]);

  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = (row.email || "").toLowerCase().trim();
    const name = (row.display_name || "").trim();
    if (!key || !name) continue;
    // ORDER BY DESC surfaces the best (imported + primary) row first; keep it.
    if (map[key]) continue;
    map[key] = name;
  }
  return map;
}

/**
 * Batch lookup contacts by multiple phone numbers.
 * Returns a map of normalized phone -> contact name.
 */
export async function getContactNamesByPhones(
  phones: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (phones.length === 0) return result;

  // Normalize all phones
  const normalizedPhones = phones.map(p => {
    const digits = p.replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : digits;
  }).filter(p => p.length >= 7);

  if (normalizedPhones.length === 0) return result;

  // Build query with multiple OR conditions
  const conditions = normalizedPhones.map(() =>
    "REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', '') LIKE ?"
  ).join(' OR ');

  const sql = `
    SELECT
      c.display_name,
      cp.phone_e164 as phone
    FROM contacts c
    JOIN contact_phones cp ON c.id = cp.contact_id
    WHERE ${conditions}
  `;

  const params = normalizedPhones.map(p => `%${p}`);
  const rows = dbAll<{ display_name: string; phone: string }>(sql, params);

  // Map results back to original phone format
  for (const row of rows) {
    const rowDigits = row.phone.replace(/\D/g, '');
    const rowNormalized = rowDigits.slice(-10);

    // Find matching input phone
    for (let i = 0; i < phones.length; i++) {
      if (normalizedPhones[i] === rowNormalized) {
        result.set(phones[i], row.display_name);
      }
    }
    // Store by multiple normalized variants to handle different lookup formats
    // 1. Raw 10-digit (5555550112)
    result.set(rowNormalized, row.display_name);

    // For US numbers (10 digits), also store with country code variants
    if (rowNormalized.length === 10) {
      // 2. With +1 prefix (+15555550112) - E.164 format
      result.set(`+1${rowNormalized}`, row.display_name);
      // 3. With 1 prefix (15555550112) - 11-digit format
      result.set(`1${rowNormalized}`, row.display_name);
    }
  }

  // Fallback: Check macOS Contacts for any unresolved phones
  const unresolvedPhones = phones.filter(p => !result.has(p));
  if (unresolvedPhones.length > 0) {
    try {
      const macOSContacts = await getContactNames();
      const contactMap = macOSContacts.contactMap;

      for (const phone of unresolvedPhones) {
        // Try direct lookup
        if (contactMap[phone]) {
          result.set(phone, contactMap[phone]);
          continue;
        }

        // Try normalized lookup (last 10 digits)
        const digits = phone.replace(/\D/g, '');
        const normalized = digits.length >= 10 ? digits.slice(-10) : digits;

        // Search contactMap for matching phone
        for (const [key, name] of Object.entries(contactMap)) {
          const keyDigits = key.replace(/\D/g, '');
          const keyNormalized = keyDigits.length >= 10 ? keyDigits.slice(-10) : keyDigits;
          if (keyNormalized === normalized && keyNormalized.length >= 7) {
            result.set(phone, name);
            result.set(normalized, name);
            // Also store with country code variants for US numbers
            if (normalized.length === 10) {
              result.set(`+1${normalized}`, name);
              result.set(`1${normalized}`, name);
            }
            break;
          }
        }
      }
    } catch (err) {
      logService.warn("Failed to load macOS Contacts for fallback lookup", "Contacts", { err });
    }
  }

  return result;
}

/**
 * BACKLOG-2532: the mapping MOVED to `types/models.ts`, beside the type it now
 * generates. It was a hand-typed `Map` here and a hand-typed interface there,
 * kept in step by whoever remembered — and a field on one side but not the
 * other was discarded in silence with the handler still reporting success
 * (BACKLOG-2528, the rename that did nothing).
 *
 * Imported rather than re-declared. There is one list.
 */

/**
 * Update contact information.
 *
 * CAUTION — a key that is PRESENT is written, whatever its value. `undefined`
 * does not mean "leave this column alone": it reaches the driver as a bound
 * parameter and lands as NULL. Omit the key entirely to leave a column
 * untouched. That asymmetry is the separate defect filed as BACKLOG-2534 and is
 * described, not fixed, here.
 */
export async function updateContact(
  contactId: string,
  updates: ContactUpdateFields,
): Promise<void> {
  updateContactSync(contactId, updates);
}

/**
 * The synchronous core of `updateContact` (BACKLOG-2496).
 *
 * WHY IT HAD TO BE SPLIT OUT. `contacts:update` now runs the contact UPDATE and
 * both address syncs in ONE transaction, and `dbTransaction` takes a SYNCHRONOUS
 * callback. Calling the `async` wrapper inside it would have been a silent
 * atomicity hole: the body is synchronous, but an `async` function turns a
 * throw into a REJECTED PROMISE rather than a synchronous throw, so
 * `dbTransaction` would see the callback return normally and COMMIT — with the
 * failure surfacing later as an unhandled rejection, after the write it was
 * supposed to prevent had already landed.
 *
 * The async wrapper is kept because other callers await it.
 */
export function updateContactSync(
  contactId: string,
  updates: ContactUpdateFields,
): void {
  // Keyed by COLUMN so `name` and `display_name` collapse to one assignment.
  const byColumn = new Map<string, unknown>();

  Object.keys(updates).forEach((key) => {
    // OWN properties only. A bare index read would let a key like
    // `constructor` resolve through Object.prototype — which is why this was a
    // `Map` before it became the single definition. `Object.hasOwn` would say
    // this more plainly but needs a lib bump; not worth one here.
    if (!Object.prototype.hasOwnProperty.call(CONTACT_UPDATE_FIELD_TO_COLUMN, key)) return;
    const column =
      CONTACT_UPDATE_FIELD_TO_COLUMN[key as keyof typeof CONTACT_UPDATE_FIELD_TO_COLUMN];

    // NOT filtered on `undefined`, deliberately — see BACKLOG-2534.
    //
    // A second, distinct defect lives on this statement: `undefined` reaches
    // the driver as a bound parameter and better-sqlite3 writes it as NULL.
    // Measured under the shipping Electron driver, not reasoned about:
    //
    //   run(undefined, undefined, 'a')
    //     -> changes=1, row {company: null, title: null}
    //
    // `contacts:update` materialises all five fields whether or not the caller
    // supplied them, so a caller that sends only a name blanks the contact's
    // company and job title. It is filed separately because the fix is NOT the
    // one line it looks like: skipping `undefined` HERE without also removing
    // the handler's `?? undefined` collapse would break clearing a field, since
    // an emptied box validates to `null` and is collapsed to `undefined` before
    // it ever arrives. The two must change together.
    byColumn.set(column, (updates as Record<string, unknown>)[key]);
  });

  if (byColumn.size === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  const fields = [...byColumn.keys()].map((column) => `${column} = ?`);
  const values = [...byColumn.values()];

  // Validate fields against whitelist before SQL construction.
  //
  // BACKLOG-2739 PHASE 1 SEAM — the cast is the finding, not the fix.
  // `fields` is built above as `${column} = ?` from plain strings, so it is
  // `string[]` and cannot satisfy the column union `validateFields` now takes.
  // The cast keeps the build green WITHOUT touching this writer's field map,
  // which is deliberately Phase 2 (BACKLOG-2738): the writer must declare an
  // exhaustive `Record<Column, Decision>` so an OMITTED column is a build
  // error. Until then a wrong name here is still only caught at runtime.
  validateFields(
    "contacts",
    fields as ReadonlyArray<FieldExpression<ColumnOf<"contacts">>>,
  );

  values.push(contactId);
  const sql = `UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`;
  dbRun(sql, values);
}

/**
 * Get all transactions associated with a contact
 */
export async function getTransactionsByContact(
  contactId: string,
): Promise<TransactionWithRoles[]> {
  const transactionMap = new Map<
    string,
    {
      id: string;
      property_address: string;
      closing_deadline?: string | null;
      transaction_type?: string | null;
      status: string;
      roles: string[];
    }
  >();

  // 1. Check direct FK references
  const directQuery = `
    SELECT DISTINCT
      id,
      property_address,
      closing_deadline,
      transaction_type,
      status,
      CASE
        WHEN buyer_agent_id = ? THEN 'Buyer Agent'
        WHEN seller_agent_id = ? THEN 'Seller Agent'
        WHEN escrow_officer_id = ? THEN 'Escrow Officer'
        WHEN inspector_id = ? THEN 'Inspector'
      END as role
    FROM transactions
    WHERE buyer_agent_id = ?
       OR seller_agent_id = ?
       OR escrow_officer_id = ?
       OR inspector_id = ?
  `;

  const directResults = dbAll<{
    id: string;
    property_address: string;
    closing_deadline?: string | null;
    transaction_type?: string | null;
    status: string;
    role: string;
  }>(directQuery, [
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
  ]);

  directResults.forEach((txn) => {
    if (!transactionMap.has(txn.id)) {
      transactionMap.set(txn.id, {
        id: txn.id,
        property_address: txn.property_address,
        closing_deadline: txn.closing_deadline,
        transaction_type: txn.transaction_type,
        status: txn.status,
        roles: [txn.role],
      });
    } else {
      transactionMap.get(txn.id)?.roles.push(txn.role);
    }
  });

  // 2. Check junction table (transaction_contacts)
  const junctionQuery = `
    SELECT DISTINCT
      t.id,
      t.property_address,
      t.closing_deadline,
      t.transaction_type,
      t.status,
      tc.specific_role,
      tc.role_category
    FROM transaction_contacts tc
    JOIN transactions t ON tc.transaction_id = t.id
    -- BACKLOG-2366 (filter contributed here to avoid a gap between two PRs):
    -- transaction_contacts rows are becoming tombstones rather than DELETEs, so
    -- a row's existence stops meaning "this is a current role". Without this,
    -- a contact taken off every deal still reports those deals as live.
    -- No-op on this branch: every removed_at is NULL until that PR lands.
    WHERE tc.contact_id = ? AND tc.removed_at IS NULL
  `;

  const junctionResults = dbAll<{
    id: string;
    property_address: string;
    closing_deadline?: string | null;
    transaction_type?: string | null;
    status: string;
    specific_role?: string;
    role_category?: string;
  }>(junctionQuery, [contactId]);

  junctionResults.forEach((txn) => {
    const role = txn.specific_role || txn.role_category || "Associated Contact";
    if (!transactionMap.has(txn.id)) {
      transactionMap.set(txn.id, {
        id: txn.id,
        property_address: txn.property_address,
        closing_deadline: txn.closing_deadline,
        transaction_type: txn.transaction_type,
        status: txn.status,
        roles: [role],
      });
    } else {
      transactionMap.get(txn.id)?.roles.push(role);
    }
  });

  // 3. Check JSON array (other_contacts)
  try {
    const jsonQuery = `
      SELECT DISTINCT
        t.id,
        t.property_address,
        t.closing_deadline,
        t.transaction_type,
        t.status
      FROM transactions t, json_each(t.other_contacts) j
      WHERE j.value = ?
    `;

    const jsonResults = dbAll<{
      id: string;
      property_address: string;
      closing_deadline?: string | null;
      transaction_type?: string | null;
      status: string;
    }>(jsonQuery, [contactId]);

    jsonResults.forEach((txn) => {
      if (!transactionMap.has(txn.id)) {
        transactionMap.set(txn.id, {
          id: txn.id,
          property_address: txn.property_address,
          closing_deadline: txn.closing_deadline,
          transaction_type: txn.transaction_type,
          status: txn.status,
          roles: ["Other Contact"],
        });
      } else {
        transactionMap.get(txn.id)?.roles.push("Other Contact");
      }
    });
  } catch (error) {
    logService.warn(
      "json_each not supported, using LIKE fallback",
      "ContactDbService",
      { error: (error as Error).message },
    );
    // Fallback implementation using LIKE
    const fallbackQuery = `
      SELECT id, property_address, closing_deadline, transaction_type, status, other_contacts
      FROM transactions
      WHERE other_contacts LIKE ?
    `;

    const fallbackResults = dbAll<{
      id: string;
      property_address: string;
      closing_deadline?: string | null;
      transaction_type?: string | null;
      status: string;
      other_contacts?: string;
    }>(fallbackQuery, [`%"${contactId}"%`]);

    fallbackResults.forEach((txn) => {
      try {
        const contacts = JSON.parse(txn.other_contacts || "[]");
        if (contacts.includes(contactId)) {
          if (!transactionMap.has(txn.id)) {
            transactionMap.set(txn.id, {
              id: txn.id,
              property_address: txn.property_address,
              closing_deadline: txn.closing_deadline,
              transaction_type: txn.transaction_type,
              status: txn.status,
              roles: ["Other Contact"],
            });
          } else {
            transactionMap.get(txn.id)?.roles.push("Other Contact");
          }
        }
      } catch (parseError) {
        logService.error(
          "Error parsing other_contacts JSON",
          "ContactDbService",
          { error: (parseError as Error).message },
        );
      }
    });
  }

  // Convert map to array; roles is a deduped string[] (BACKLOG-1930 —
  // no ", " join here; the renderer formats for display).
  return Array.from(transactionMap.values()).map((txn) => ({
    ...txn,
    roles: [...new Set(txn.roles)],
  }));
}

/**
 * Resolve the owning user_id for a contact (contacts belong to exactly one
 * user). Used to scope the contact-scoped comms queries below.
 */
function getContactUserId(contactId: string): string | null {
  const row = dbGet<{ user_id: string }>(
    "SELECT user_id FROM contacts WHERE id = ?",
    [contactId],
  );
  return row?.user_id ?? null;
}

/**
 * BACKLOG-1933: Get ALL emails involving a contact's email addresses,
 * aggregated across every transaction (contact-scoped, NOT transaction-scoped).
 *
 * Match path: contact's own email addresses (getContactEmailEntries, lowercased)
 * → `email_participants.email_address` (indexed `idx_email_participants_email_address`)
 * → `emails` (the messages/emails content table)
 * → LEFT JOIN `communications c ON c.email_id = e.id` to carry the owning
 *   `transaction_id` (NULL when the email is not linked to any transaction —
 *   EXPECTED per S2, the "See transaction" button is simply hidden for those).
 *
 * Each row is returned as a HYDRATED `Communication` (= `Message`), mirroring the
 * canonical email projection in `communicationDbService.ts:608-690`, so the
 * existing `EmailViewModal` (takes `email: Communication`) can be mounted directly.
 * Deduped by `emails.id`. Newest-first.
 *
 * NOTE: `emails` has NO `duplicate_of` column (dedup on that table is via
 * `content_hash`, not a pointer) — we dedup by primary key `emails.id`.
 *
 * @param contactId - The contact whose emails to fetch
 * @returns Hydrated Communication[] (empty array when none / unknown contact)
 */
export async function getEmailsForContact(
  contactId: string,
): Promise<Communication[]> {
  const userId = getContactUserId(contactId);
  if (!userId) return [];

  // Contact's own email addresses, lowercased+trimmed for exact indexed match.
  const addresses = getContactEmailEntries(contactId)
    .map((e) => e.email.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (addresses.length === 0) return [];

  const placeholders = addresses.map(() => "?").join(", ");

  // Mirror the email branch of getCommunicationsWithMessages
  // (communicationDbService.ts:608-690): populate the Message/Communication
  // fields from REAL `emails` columns. `transaction_id` comes from the
  // `communications` junction (LEFT JOIN → NULL for non-linked emails).
  const sql = `
    SELECT
      e.id                 as id,
      e.user_id            as user_id,
      e.subject            as subject,
      e.body_html          as body,
      e.body_html          as body_html,
      e.body_plain         as body_text,
      e.body_plain         as body_plain,
      e.sender             as sender,
      e.recipients         as recipients,
      e.cc                 as cc,
      e.bcc                as bcc,
      e.sent_at            as sent_at,
      e.received_at        as received_at,
      e.has_attachments    as has_attachments,
      e.attachment_count   as attachment_count,
      e.thread_id          as thread_id,
      e.external_id        as external_id,
      e.source             as source,
      e.direction          as direction,
      'email'              as channel,
      c.transaction_id     as transaction_id
    FROM email_participants ep
    JOIN emails e ON e.id = ep.email_id
    LEFT JOIN communications c ON c.email_id = e.id
    WHERE e.user_id = ?
      AND LOWER(TRIM(ep.email_address)) IN (${placeholders})
    ORDER BY e.sent_at DESC
  `;

  const rows = dbAll<Communication>(sql, [userId, ...addresses]);

  // Dedup by emails.id — a contact can appear as multiple participants on the
  // same email, and multiple contact addresses can match the same email; the
  // LEFT JOIN to communications can also multiply rows when an email is linked
  // to more than one transaction.
  const seen = new Set<string>();
  const deduped: Communication[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    // has_attachments is a required boolean on Message; SQLite returns 0/1.
    row.has_attachments = !!row.has_attachments;
    deduped.push(row);
  }
  return deduped;
}

/**
 * BACKLOG-1933: Get ALL text messages involving a contact's phone numbers,
 * grouped into conversation threads, aggregated across every transaction
 * (contact-scoped, NOT transaction-scoped).
 *
 * Match path: contact's own phones (getContactPhoneEntries, E.164) → scan
 * `messages.participants_flat` using the PURE helpers `phonesMatch`/`toE164`
 * (NOT the transaction-scoped `findTextMessagesByPhones`). Group matched
 * messages by `thread_id`; derive a representative `phoneNumber` per thread
 * (the matched contact phone). `transaction_id` is read DIRECTLY off the
 * message row (`messages.transaction_id`), with the `communications` junction
 * as a fallback.
 *
 * Excludes `duplicate_of IS NOT NULL` rows. Messages within a thread are
 * chronological (oldest → newest); threads are ordered newest-activity-first.
 *
 * @param contactId - The contact whose text threads to fetch
 * @returns ContactMessageThread[] (empty array when none / unknown contact)
 */
export async function getMessagesForContact(
  contactId: string,
): Promise<ContactMessageThread[]> {
  const userId = getContactUserId(contactId);
  if (!userId) return [];

  // Contact's own phones in E.164 (getContactPhoneEntries already stores E.164;
  // normalize defensively via toE164).
  const contactPhones = getContactPhoneEntries(contactId)
    .map((p) => toE164(p.phone))
    .filter((p): p is string => !!p);
  if (contactPhones.length === 0) return [];

  // Fetch the user's text messages (SMS/iMessage), excluding duplicates.
  // participants_flat is a denormalized comma string; a phone lookup inside it
  // is a bounded per-user scan (acceptable MVP per the Query/Index Plan).
  const sql = `
    SELECT
      m.id                 as id,
      m.user_id            as user_id,
      m.channel_account_id as channel_account_id,
      m.external_id        as external_id,
      m.channel            as channel,
      m.direction          as direction,
      m.subject            as subject,
      m.body_html          as body_html,
      m.body_text          as body_text,
      m.participants       as participants,
      m.participants_flat  as participants_flat,
      m.thread_id          as thread_id,
      m.sent_at            as sent_at,
      m.received_at        as received_at,
      m.has_attachments    as has_attachments,
      m.transaction_id     as transaction_id,
      m.message_type       as message_type,
      m.associated_message_type as associated_message_type,
      m.associated_message_guid as associated_message_guid,
      m.created_at         as created_at
    FROM messages m
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND m.duplicate_of IS NULL
    ORDER BY m.sent_at ASC
  `;

  const allTextMessages = dbAll<Message & { participants_flat?: string }>(sql, [userId]);

  // Filter to messages whose participants_flat contains any of the contact's
  // phones, using the pure phonesMatch helper on each comma-separated token.
  interface ThreadAccumulator {
    thread_id: string;
    phoneNumber: string;
    messages: Message[];
    transaction_id?: string;
    lastActivity: string;
  }
  const threadMap = new Map<string, ThreadAccumulator>();

  for (const msg of allTextMessages) {
    // BACKLOG-2280: reaction rows ride along on this INCLUDE query so the two
    // columns are available; partition them out of the bubble threads here so
    // they never render as empty bubbles (contact-card pills are out of scope).
    if (isReactionRow(msg)) continue;

    const flat = msg.participants_flat || "";
    if (!flat) continue;

    const tokens = flat.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    // Find which contact phone (if any) this message involves.
    let matchedPhone: string | null = null;
    for (const token of tokens) {
      const hit = contactPhones.find((cp) => phonesMatch(cp, token));
      if (hit) {
        matchedPhone = hit;
        break;
      }
    }
    if (!matchedPhone) continue;

    // Group by thread_id; messages without a thread_id fall back to their own id.
    const threadKey = msg.thread_id || msg.id;
    msg.has_attachments = !!msg.has_attachments;

    const existing = threadMap.get(threadKey);
    const activity = msg.sent_at || msg.received_at || msg.created_at || "";
    if (!existing) {
      threadMap.set(threadKey, {
        thread_id: threadKey,
        phoneNumber: matchedPhone,
        messages: [msg],
        transaction_id: msg.transaction_id || undefined,
        lastActivity: activity,
      });
    } else {
      existing.messages.push(msg);
      // Prefer a defined transaction_id if any message in the thread carries one.
      if (!existing.transaction_id && msg.transaction_id) {
        existing.transaction_id = msg.transaction_id;
      }
      if (activity > existing.lastActivity) existing.lastActivity = activity;
    }
  }

  // Fallback: fill any thread still missing a transaction_id from the
  // communications junction (message_id or thread_id linkage).
  for (const thread of threadMap.values()) {
    if (thread.transaction_id) continue;
    const link = dbGet<{ transaction_id: string | null }>(
      `SELECT transaction_id FROM communications
       WHERE transaction_id IS NOT NULL
         AND (thread_id = ? OR message_id IN (${thread.messages.map(() => "?").join(", ")}))
       LIMIT 1`,
      [thread.thread_id, ...thread.messages.map((m) => m.id)],
    );
    if (link?.transaction_id) thread.transaction_id = link.transaction_id;
  }

  // Threads newest-activity-first; strip the internal lastActivity field.
  return Array.from(threadMap.values())
    .sort((a, b) => (b.lastActivity > a.lastActivity ? 1 : b.lastActivity < a.lastActivity ? -1 : 0))
    .map(({ thread_id, phoneNumber, messages, transaction_id }) => ({
      thread_id,
      phoneNumber,
      messages,
      transaction_id,
    }));
}

/**
 * Why a contact carries a tombstone. Stored verbatim in `contacts.removed_reason`
 * (migration v56). Deliberately a closed union: the reason is compliance-visible
 * once the Removed contacts section lands (BACKLOG-2367), so it must not become a
 * free-text field that accumulates one-off strings.
 */
export type ContactRemovalReason = "user_deleted" | "user_unimported";

/**
 * Tombstone a contact — BACKLOG-2365.
 *
 * ## Why this is not a DELETE
 *
 * It used to be `DELETE FROM contacts WHERE id = ?`. Four tables hang off that
 * foreign key with ON DELETE CASCADE, and one of them is `transaction_contacts`
 * — which is where a party's **role on a deal** lives (`role`, `role_category`,
 * `specific_role`). So deleting a contact did not merely hide a person: it
 * erased the record that they were ever on an audited transaction, with no undo.
 * On a compliance product that is precisely the failure the product exists to
 * prevent.
 *
 * Writing `removed_at` instead means no cascade fires. The contact row, its
 * emails, its phones and every one of its transaction roles survive untouched;
 * only its visibility changes. Restore is then a matter of clearing two columns
 * (the restore surfaces themselves are BACKLOG-2367).
 *
 * `email_participants.resolved_contact_id` has no FK at all (schema.sql:420),
 * so the old DELETE also left dangling references behind it. Those cannot be
 * created any more either.
 *
 * ## Idempotent by construction
 *
 * `AND removed_at IS NULL` means removing an already-removed contact is a no-op
 * rather than a re-stamp. The FIRST removal's timestamp and reason are the ones
 * that survive — a second delete must not silently rewrite when the audit trail
 * says the person was taken off the deal.
 */
export async function deleteContact(
  contactId: string,
  reason: ContactRemovalReason = "user_deleted",
): Promise<void> {
  dbRun(
    `UPDATE contacts
        SET removed_at = datetime('now'),
            removed_reason = ?
      WHERE id = ? AND removed_at IS NULL`,
    [reason, contactId],
  );
}

/**
 * Remove a contact from the local database (un-import) — BACKLOG-2365.
 *
 * This is the path the Clients & Contacts "remove" button actually takes, so it
 * is the one a user hits in the field. It previously branched on source: an
 * address-book contact (`contacts_app` / `outlook`) was **deleted outright** on
 * the reasoning that it still exists in the `external_contacts` shadow table and
 * could be re-imported. That reasoning covers the contact's NAME and NUMBERS. It
 * does not cover anything Keepr learned afterwards — above all the transaction
 * roles in `transaction_contacts`, which exist nowhere but here and which the
 * cascade destroyed.
 *
 * Both branches now converge on the same non-destructive result: tombstone the
 * row and change nothing else.
 *
 * ## Why this does NOT also write `is_imported = 0`
 *
 * An earlier revision did, on the reasoning that "un-import" should leave the
 * row un-imported. That was wrong twice over:
 *
 *  - **It resurrected the contact.** The three exclusion sets in
 *    `getMessageDerivedContacts` key on `is_imported = 1`. Clearing the flag
 *    dropped the removed contact out of them, so her message-derived twin
 *    reappeared in the very list she had just been removed from. Removed is
 *    removed; it must not also mean "un-imported".
 *  - **It corrupted restore.** Clearing the flag means BACKLOG-2367's restore
 *    would return the contact to the un-imported bucket rather than to where
 *    she came from. A tombstone must be losslessly reversible, which it can
 *    only be if removal changes exactly one thing.
 *
 * The exclusion sets were widened to cover tombstones as well, so the
 * resurrection is closed from both ends rather than relying on this alone.
 */
export async function removeContact(contactId: string): Promise<void> {
  dbRun(
    `UPDATE contacts
        SET removed_at = datetime('now'),
            removed_reason = ?
      WHERE id = ? AND removed_at IS NULL`,
    ["user_unimported" satisfies ContactRemovalReason, contactId],
  );
}

/**
 * Undo a contact tombstone — BACKLOG-2367.
 *
 * ## Why this is a two-column UPDATE and nothing else
 *
 * `deleteContact` / `removeContact` change exactly one thing about a contact:
 * they stamp `removed_at` + `removed_reason`. Nothing else about the row, its
 * emails, its phones or its `transaction_contacts` roles is touched — that
 * restraint is the whole point of the tombstone, and it is documented at length
 * on `removeContact` above (an earlier revision also wrote `is_imported = 0`
 * and thereby made removal irreversible).
 *
 * Restore is therefore the exact inverse: clear those two columns and touch
 * nothing else. In particular it does NOT write `is_imported = 1` and does NOT
 * bump `updated_at`. Writing either would mean a remove/restore round trip
 * returns a DIFFERENT row than it started with, which is precisely the lossy
 * behaviour the tombstone exists to avoid. Restoring is not an edit.
 *
 * ## `AND removed_at IS NOT NULL`, and why the caller gets the changes count
 *
 * The guard makes restoring an already-active contact a no-op rather than a
 * silent double-write, mirroring the `AND removed_at IS NULL` on the removal
 * side. Returning whether a row actually changed lets the IPC layer tell a real
 * restore apart from a stale click on a list the user was already looking at —
 * without it the handler would have to report success for a restore that
 * restored nothing, and the removed-list count would drift from the truth.
 *
 * There is deliberately no `user_id` parameter: the id is a UUID and every
 * other single-contact mutation in this file (`updateContact`, `deleteContact`,
 * `removeContact`) is keyed on id alone. The IPC handler resolves the owning
 * user from the row for its audit entry.
 */
export async function restoreContact(contactId: string): Promise<boolean> {
  const { changes } = dbRun(
    `UPDATE contacts
        SET removed_at = NULL,
            removed_reason = NULL
      WHERE id = ? AND removed_at IS NOT NULL`,
    [contactId],
  );
  return changes > 0;
}

/** One row of the Clients & Contacts "Removed contacts" section — BACKLOG-2367. */
export interface RemovedContactRow {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  source: string | null;
  /** Never null: the tombstone filter is `removed_at IS NOT NULL`. */
  removed_at: string;
  /** A `ContactRemovalReason`, or null for a row tombstoned before v56 typing. */
  removed_reason: string | null;
  /**
   * `transaction_contacts` rows for this contact that are THEMSELVES still
   * live. This is the number the whole epic is about: it is what the old
   * cascading DELETE destroyed, and showing it is how a user can see that the
   * roles survived before they commit to restoring.
   *
   * Counted with `tc.removed_at IS NULL` because the two tombstones are
   * independent — a party can be removed from one deal (BACKLOG-2366) and later
   * removed from the database (BACKLOG-2365), and the deal she was taken off
   * must not be counted among the roles restoring her would bring back.
   */
  active_role_count: number;
}

/**
 * Contacts the user has removed, most recent first — BACKLOG-2367.
 *
 * ## Why not just widen `getRemovedContactIdentifiers`
 *
 * That function (below) answers a different question for a different caller: it
 * feeds the import picker's already-imported filter, so it returns the bare
 * matching keys and nothing else. This one renders a card a human reads and
 * decides on, so it needs the display fields plus the two facts that only exist
 * for a tombstoned row — when it was removed and why. Widening the picker query
 * would put a correlated COUNT on a path that runs on every address-book sync
 * and never displays it.
 *
 * ## No index
 *
 * Migration v56 declined to ship one and said why: ship the index with the
 * query that justifies it. This query does not justify one. `idx_contacts_user_id`
 * already covers the leading term, tombstoned rows are a small minority of a
 * table that is written on every sync, and this query runs only when a user
 * expands a collapsed section by hand.
 */
export async function getRemovedContacts(
  userId: string,
): Promise<RemovedContactRow[]> {
  const sql = `
    SELECT
      c.id,
      c.display_name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone,
      c.company,
      c.title,
      c.source,
      c.removed_at,
      c.removed_reason,
      (
        SELECT COUNT(*) FROM transaction_contacts tc
         WHERE tc.contact_id = c.id AND tc.removed_at IS NULL
      ) as active_role_count
    FROM contacts c
    WHERE c.user_id = ? AND c.removed_at IS NOT NULL
    ORDER BY c.removed_at DESC, c.display_name ASC
  `;
  return dbAll<RemovedContactRow>(sql, [userId]);
}

/**
 * Identifiers of REMOVED contacts, for the import picker's already-imported
 * filter — BACKLOG-2365.
 *
 * ## Why this exists at all
 *
 * The import picker decides what to OFFER by subtracting the people we already
 * have from the address book. It builds that subtrahend from
 * `getImportedContactsByUserId`, which now hides removed contacts — so without
 * this, removal silently undoes itself through the import path:
 *
 *   Madison deletes a duplicate contact. The next macOS sync runs. The contact
 *   she deleted no longer matches the imported filter, so the picker offers her
 *   as if she were new. She imports her again — and the deletion is gone.
 *
 * That is the failure this epic exists to prevent, reintroduced through the
 * import path rather than the delete path. It was predicted in as many words on
 * this backlog item on 2026-07-31, before the code was written.
 *
 * A tombstone means "we know about this person", which is exactly the question
 * the filter asks — so removed contacts must be VISIBLE here, the opposite of
 * every list in this file.
 *
 * ## Why a separate query rather than a flag on the main read
 *
 * The main read runs on a worker thread (TASK-1956) precisely because it is
 * heavy. Removed contacts are rare, so fetching them separately keeps that path
 * untouched and adds a small query instead of widening a hot one.
 *
 * Shape matches the fields the filter consumes (`name`/`display_name`, `email`,
 * `phone`) so the two results can simply be concatenated.
 */
export async function getRemovedContactIdentifiers(
  userId: string,
): Promise<Array<{ id: string; display_name: string; name: string; email: string | null; phone: string | null }>> {
  const sql = `
    SELECT
      c.id,
      c.display_name,
      c.display_name as name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone
    FROM contacts c
    WHERE c.user_id = ? AND c.removed_at IS NOT NULL
  `;
  return dbAll(sql, [userId]);
}

/**
 * `getOrCreateContactFromEmail` WAS HERE, AND IT WAS DEAD AND BROKEN
 * (removed in BACKLOG-2496).
 *
 * It opened with `SELECT * FROM contacts WHERE user_id = ? AND email = ?`.
 * **`contacts` has no `email` column** — addresses live in `contact_emails`, and
 * the only `ALTER TABLE contacts ADD COLUMN` in the whole migration chain is
 * `default_role`. So the function threw `no such column: email` on its first
 * statement, every time, and could never have returned a contact.
 *
 * Nothing called it. Its sole reference was a `databaseService` passthrough,
 * which nothing called either; both are gone.
 *
 * ITS TWO TESTS PASSED ANYWAY, WHICH IS THE PART WORTH REMEMBERING. They drove
 * a fully mocked statement (`mockStatement.get.mockReturnValue(...)`), so they
 * never touched a database and never discovered that the column they filtered
 * on does not exist. Green, and carrying no information about whether the code
 * worked. They are deleted with the function rather than ported.
 *
 * It is listed as the fourth contact-creating path on BACKLOG-2496. It is not a
 * path — it is an unreachable one, so it was deleted rather than given the new
 * required-origin signature.
 */

/**
 * Search contacts for selection modal (database-level search)
 * Searches both imported contacts and message-derived contacts.
 * Used when user types in search box - performs DB search instead of client-side filter.
 *
 * This fixes the LIMIT 200 issue where contacts beyond position 200 were unsearchable.
 * Search has no arbitrary LIMIT on the searchable pool - only limits result count.
 *
 * ## BACKLOG-2467 — phone search covers EVERY number, in the formats people type
 *
 * The phone clause was `cp_primary.phone_e164 LIKE '%query%'` against a join
 * pinned to `is_primary = 1`. Two defects in one line:
 *
 *  - ONE COLUMN. A contact reachable only on their second number — a work line,
 *    a spouse's mobile, the number a text thread actually arrived on — could not
 *    be found here at all. This is the picker that attaches a party to a deal
 *    under audit, so failing to find someone means a duplicate contact gets
 *    created or the party is silently left off the transaction.
 *  - RAW SUBSTRING. `+14155550100` is stored; `+1 (415) 555-0100` is what the UI
 *    PRINTS and therefore what a user types. The parentheses, spaces and dash are
 *    not in the stored value, so the formatted form matched nothing — the same
 *    defect BACKLOG-2466 fixed on the Clients & Contacts screen.
 *
 * Both are fixed by joining ALL of `contact_phones` and comparing on the
 * digits-only lookup key. `toLookupKey` is applied SYMMETRICALLY: it is the same
 * function that WROTE `contact_phones.phone_normalized` (and that migration v40
 * backfilled it with), so the typed query and the stored value are reduced by
 * one rule. `COALESCE(NULLIF(phone_normalized,''), <digits of phone_e164>)`
 * covers rows written before that column existed — the same fallback used by
 * `contactSourceValues` and `contactSourceLinker`.
 *
 * The four original clauses are untouched, and the new one is OR-ed in behind
 * `looksLikePhoneQuery`, so this is a strict SUPERSET: no query that finds a
 * contact today can stop finding one, and "415 Realty" stays on the name path.
 *
 * NOTE — the message-derived half below is deliberately NOT given a phone
 * clause. Its BACKLOG-313 filters already exclude every handle that starts with
 * "+" or a digit, so no row it can return HAS a phone-like handle; a phone
 * clause there would be dead code.
 *
 * @param userId - User ID to search contacts for
 * @param query - Search query (min 2 characters for meaningful results)
 * @param limit - Maximum results to return (default 50)
 * @returns Contacts matching the search query, sorted by relevance
 */
export function searchContactsForSelection(
  userId: string,
  query: string,
  limit: number = 50
): ContactWithActivity[] {
  const searchPattern = `%${query}%`;

  // BACKLOG-2467: digits-only needle, gated so a query with letters in it never
  // reaches the phone path. `phoneGate` is bound as a SQL parameter (1/0) rather
  // than string-built into the query so the statement text stays constant and
  // prepared-statement caching still works.
  const phoneIsQuery = looksLikePhoneQuery(query);
  const phoneGate = phoneIsQuery ? 1 : 0;
  /**
   * The searchable form of one phone row: its stored key when it has one, else
   * the raw `phone_e164` with the separators a person types stripped out.
   * Declared once because the clause below reads it against TWO needles.
   */
  const PHONE_HAYSTACK_SQL = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
             COALESCE(NULLIF(cp_all.phone_normalized, ''), cp_all.phone_e164)
           , '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), '.', '')`;

  const phonePattern = phoneIsQuery ? `%${toLookupKey(query)}%` : "%";
  // BACKLOG-2630: the pre-2630 needle, kept alongside the new one so a row whose
  // `phone_normalized` is NULL (written before migration v40 added the column)
  // is still found by its own number through the `phone_e164` fallback branch.
  const phoneLegacyPattern = phoneIsQuery ? `%${legacyDigitKey(query.trim())}%` : "%";

  // BACKLOG-2618: the email set that stood here was read by a filter that could
  // never fire — `messageSql` below carries the same
  // `NOT LIKE '%@%'` guarantee as `getMessageDerivedContacts`, so the `email`
  // column it projects is always NULL. Deleted with its filter.
  //
  // What replaces it is the rule the OTHER producer already applies, and this
  // one did not apply at all: a message-derived person is suppressed only by a
  // saved contact whose name is the whole of its identity. Before this, removing
  // Dana hid her from the contacts list and left `msg_dana example` visible in
  // the transaction picker's search — the BACKLOG-2365 defect surviving in the
  // one surface that had no name filter.
  const namesOwningThemselves = namesThatAreTheirOwnIdentity(userId);

  // Search imported contacts
  // Searches across display_name, all emails, phone, and company
  // BACKLOG-506: Join emails FIRST, then communications by email_id
  const importedSql = `
    SELECT
      c.id,
      c.user_id,
      c.display_name,
      c.display_name as name,
      ce_primary.email as email,
      cp_primary.phone_e164 as phone,
      c.company,
      c.title,
      c.source,
      c.is_imported,
      0 as is_message_derived,
      MAX(e.sent_at) as last_communication_at,
      COUNT(DISTINCT comm.id) as communication_count,
      0 as address_mention_count
    FROM contacts c
    LEFT JOIN contact_emails ce_primary ON c.id = ce_primary.contact_id AND ce_primary.is_primary = 1
    LEFT JOIN contact_phones cp_primary ON c.id = cp_primary.contact_id AND cp_primary.is_primary = 1
    LEFT JOIN contact_emails ce_all ON c.id = ce_all.contact_id
    -- BACKLOG-2467: EVERY number, not just the primary one. cp_primary above is
    -- still the row PROJECTED as the phone column; this join exists only to
    -- widen the WHERE. Row fan-out is absorbed by the existing GROUP BY c.id,
    -- and the only aggregate that could care already uses COUNT(DISTINCT comm.id).
    LEFT JOIN contact_phones cp_all ON c.id = cp_all.contact_id
    -- BACKLOG-1722: indexed exact-match via email_participants junction.
    -- The previous LIKE '%' || email || '%' on recipients was unindexed AND
    -- false-positive prone (matched alisa@x.com when querying lisa@x.com).
    LEFT JOIN email_participants ep ON ep.email_address = LOWER(ce_all.email)
    LEFT JOIN emails e ON e.id = ep.email_id AND e.user_id = c.user_id
    LEFT JOIN communications comm ON (
      comm.email_id = e.id
    )
    WHERE c.user_id = ? AND c.is_imported = 1${ACTIVE_CONTACTS_CLAUSE_C}
      AND (
        c.display_name LIKE ?
        OR ce_all.email LIKE ?
        OR cp_primary.phone_e164 LIKE ?
        OR c.company LIKE ?
        -- BACKLOG-2467: digits-only match across ALL of this contact's numbers.
        -- REPLACE-stripping is a no-op on phone_normalized (already digits). On
        -- the phone_e164 fallback it strips only the separators people actually
        -- type — "+ - space ( ) ." — which is NARROWER than toLookupKey's "every
        -- non-digit". A legacy row using some other separator (e.g.
        -- "213/555/0177") whose phone_normalized is NULL therefore stays
        -- unfindable. SQLite has no regex, so closing that would mean an
        -- unbounded REPLACE chain or a backfill; the fallback exists only for
        -- rows predating the column, and every write path since populates it.
        --
        -- BACKLOG-2630: TWO needles, because this expression yields TWO key
        -- spaces. phone_normalized now holds E.164 digits ("14155550109"); the
        -- phone_e164 fallback branch yields whatever the row happens to hold
        -- with separators stripped, which for a pre-column legacy row is a bare
        -- national number ("2135550177"). One needle cannot match both, and the
        -- E.164 needle alone would make a legacy-shaped row unfindable by its
        -- own number. The second needle is the pre-2630 key, so this clause
        -- keeps every match it makes today and adds the new-key ones.
        OR (? = 1 AND (
             ${PHONE_HAYSTACK_SQL} LIKE ?
             OR ${PHONE_HAYSTACK_SQL} LIKE ?
           ))
      )
    GROUP BY c.id
    ORDER BY
      CASE WHEN c.display_name LIKE ? THEN 0 ELSE 1 END,
      last_communication_at DESC NULLS LAST
    LIMIT ?
  `;

  // Search message-derived contacts (no LIMIT 200 restriction when searching)
  // BACKLOG-313 filters still apply: exclude raw emails/phones as names
  const messageSql = `
    SELECT
      'msg_' || LOWER(json_extract(participants, '$.from')) as id,
      ? as user_id,
      json_extract(participants, '$.from') as display_name,
      json_extract(participants, '$.from') as name,
      CASE
        WHEN json_extract(participants, '$.from') LIKE '%@%'
        THEN LOWER(json_extract(participants, '$.from'))
        ELSE NULL
      END as email,
      CASE
        WHEN json_extract(participants, '$.from') NOT LIKE '%@%'
        THEN json_extract(participants, '$.from')
        ELSE NULL
      END as phone,
      NULL as company,
      NULL as title,
      'messages' as source,
      0 as is_imported,
      1 as is_message_derived,
      MAX(sent_at) as last_communication_at,
      COUNT(*) as communication_count,
      0 as address_mention_count
    FROM messages
    WHERE user_id = ?
      AND participants IS NOT NULL
      AND json_extract(participants, '$.from') IS NOT NULL
      AND json_extract(participants, '$.from') != ''
      AND json_extract(participants, '$.from') != 'me'
      -- BACKLOG-313: Filter out entries where "name" is raw phone/email (no display name)
      AND json_extract(participants, '$.from') NOT LIKE '%@%'
      AND json_extract(participants, '$.from') NOT LIKE '+%'
      AND json_extract(participants, '$.from') NOT GLOB '[0-9]*'
      AND json_extract(participants, '$.from') NOT LIKE 'urn:%'
      -- BACKLOG-2280: reactions carry a sender but are not real communications.
      AND ${LOCAL_REACTION_EXCLUSION}
      -- Search filter
      AND json_extract(participants, '$.from') LIKE ?
    GROUP BY LOWER(json_extract(participants, '$.from'))
    ORDER BY last_communication_at DESC
    LIMIT ?
  `;

  try {
    // Execute imported contacts search
    const importedResults = dbAll<ContactWithActivity>(importedSql, [
      userId,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      phoneGate, // BACKLOG-2467: 1 only when the query looks like a phone number
      phonePattern, // BACKLOG-2467/2630: E.164-digits needle (toLookupKey)
      phoneLegacyPattern, // BACKLOG-2630: pre-2630 needle for the phone_e164 fallback
      searchPattern, // For ORDER BY CASE
      limit,
    ]);

    // Execute message-derived contacts search
    const messageResults = dbAll<ContactWithActivity>(messageSql, [
      userId, // For user_id column
      userId, // For WHERE clause
      searchPattern,
      limit,
    ]);

    // BACKLOG-2618: one filter, the same one the contacts list applies.
    const filteredMessageResults = messageResults.filter(contact => {
      const name = contact.display_name || contact.name;
      return !(name && namesOwningThemselves.has(name.toLowerCase()));
    });

    // Merge results: imported first, then message-derived
    const allResults = [...importedResults, ...filteredMessageResults];

    // Sort by name match first, then by communication date
    allResults.sort((a, b) => {
      // Prioritize exact name prefix match
      const aNameMatch = (a.display_name || a.name || '').toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
      const bNameMatch = (b.display_name || b.name || '').toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
      if (aNameMatch !== bNameMatch) {
        return aNameMatch - bNameMatch;
      }

      // Then by last communication date
      const dateA = a.last_communication_at ? new Date(a.last_communication_at).getTime() : 0;
      const dateB = b.last_communication_at ? new Date(b.last_communication_at).getTime() : 0;
      return dateB - dateA;
    });

    // Return up to limit results
    return allResults.slice(0, limit);
  } catch (error) {
    logService.error("Error searching contacts for selection", "ContactDbService", {
      error: (error as Error).message,
      userId,
      query,
    });
    throw error;
  }
}

/**
 * Get email entries (with row IDs) for a contact — used by edit form
 */
export function getContactEmailEntries(contactId: string): { id: string; email: string; is_primary: boolean }[] {
  const sql = `
    SELECT id, email, is_primary
    FROM contact_emails
    WHERE contact_id = ?
    ORDER BY is_primary DESC, created_at ASC
  `;
  const rows = dbAll<{ id: string; email: string; is_primary: number }>(sql, [contactId]);
  logService.warn(`[DIAG-1270] getContactEmailEntries(${contactId}): ${rows.length} emails found`, 'ContactDbService');
  return rows.map(r => ({ id: r.id, email: r.email, is_primary: r.is_primary === 1 }));
}

/**
 * Get phone entries (with row IDs) for a contact — used by edit form
 */
export function getContactPhoneEntries(contactId: string): { id: string; phone: string; is_primary: boolean }[] {
  const sql = `
    SELECT id, phone_e164 as phone, is_primary
    FROM contact_phones
    WHERE contact_id = ?
    ORDER BY is_primary DESC, created_at ASC
  `;
  const rows = dbAll<{ id: string; phone: string; is_primary: number }>(sql, [contactId]);
  return rows.map(r => ({ id: r.id, phone: r.phone, is_primary: r.is_primary === 1 }));
}

/**
 * Sync contact email entries. Handles insert/update/delete to match incoming array.
 * Enforces exactly one primary email.
 *
 * ===========================================================================
 * ATOMIC (BACKLOG-2496 / BACKLOG-2530)
 * ===========================================================================
 * THE DELETES RUN FIRST AND THE INSERTS RUN SECOND. Unwrapped, an interruption
 * between the two loops left the contact with NEITHER THE OLD SET NOR THE NEW
 * ONE — no addresses at all. That is the worst state in the write-path audit,
 * because nothing reports it and nothing recovers it:
 * `getContactEmailsForTransaction` drives the audit's email sweep off this
 * table, so a party on a live deal silently stops matching their own
 * correspondence and the deal's communication set narrows, with no error
 * anywhere.
 *
 * Wrapped HERE rather than only at the caller, so it holds when called directly
 * too. `contacts:update` wraps the whole edit as well, which nests — production
 * escalates a nested transaction to a SAVEPOINT and the test helper now does
 * the same.
 */
export function syncContactEmails(
  contactId: string,
  emails: Array<{ id?: string; email: string; is_primary: boolean }>,
): void {
  dbTransaction(() => {
  // Filter and normalize incoming emails
  const incomingEmails = emails
    .filter((e) => e.email && e.email.trim())
    .map((e) => ({
      id: e.id || undefined,
      email: e.email.toLowerCase().trim(),
      is_primary: !!e.is_primary,
    }));

  // Enforce exactly one primary
  const hasPrimary = incomingEmails.some((e) => e.is_primary);
  if (!hasPrimary && incomingEmails.length > 0) {
    incomingEmails[0].is_primary = true;
  }

  // Get existing rows
  const existingEmails = getContactEmailEntries(contactId);
  const existingIds = new Set(existingEmails.map((e) => e.id));
  const incomingIds = new Set(incomingEmails.filter((e) => e.id).map((e) => e.id));

  // Delete rows not in incoming
  for (const existing of existingEmails) {
    if (!incomingIds.has(existing.id)) {
      dbRun("DELETE FROM contact_emails WHERE id = ?", [existing.id]);
    }
  }

  // Update existing / insert new
  for (const entry of incomingEmails) {
    if (entry.id && existingIds.has(entry.id)) {
      dbRun(
        "UPDATE contact_emails SET email = ?, is_primary = ? WHERE id = ?",
        [entry.email, entry.is_primary ? 1 : 0, entry.id],
      );
    } else {
      dbRun(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source, created_at) VALUES (?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP)",
        [crypto.randomUUID(), contactId, entry.email, entry.is_primary ? 1 : 0],
      );
    }
  }
  });
}

/**
 * Set a single email as primary for a contact (legacy backward-compat path).
 * If email doesn't exist in contact_emails, replaces all emails with this one.
 *
 * ATOMIC (BACKLOG-2496 / BACKLOG-2530). The `else` branch is
 * `DELETE FROM contact_emails WHERE contact_id = ?` — ALL of them — followed by
 * one INSERT. Unwrapped, that is a one-statement window in which the contact
 * has ZERO email addresses, reachable from an edit as small as correcting a
 * primary address. Same damage as `syncContactEmails`, from a smaller action.
 */
export function setContactPrimaryEmail(
  contactId: string,
  email: string,
): void {
  const newEmail = email?.trim();
  if (!newEmail) return;

  dbTransaction(() => {

  const normalizedEmail = newEmail.toLowerCase();
  const targetExists = dbGet<{ id: string }>(
    "SELECT id FROM contact_emails WHERE contact_id = ? AND LOWER(email) = LOWER(?)",
    [contactId, normalizedEmail],
  );

  if (targetExists) {
    dbRun("UPDATE contact_emails SET is_primary = 0 WHERE contact_id = ? AND id != ?", [contactId, targetExists.id]);
    dbRun("UPDATE contact_emails SET is_primary = 1 WHERE id = ?", [targetExists.id]);
  } else {
    dbRun("DELETE FROM contact_emails WHERE contact_id = ?", [contactId]);
    dbRun(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, 1, 'manual')",
      [crypto.randomUUID(), contactId, normalizedEmail],
    );
  }
  });
}

/**
 * Sync contact phone entries. Handles insert/update/delete to match incoming array.
 * Enforces exactly one primary phone.
 *
 * ATOMIC (BACKLOG-2496 / BACKLOG-2530). PHONES HAVE THE SAME SHAPE AS EMAILS —
 * established by reading both, not assumed: delete-loop first, then the
 * update/insert loop, so an interruption between them leaves the contact with
 * neither the old numbers nor the new ones.
 */
export function syncContactPhones(
  contactId: string,
  phones: Array<{ id?: string; phone: string; is_primary: boolean }>,
): void {
  dbTransaction(() => {
  // Filter and normalize incoming phones
  const incomingPhones = phones
    .filter((p) => p.phone && p.phone.trim())
    .map((p) => ({
      id: p.id || undefined,
      phone: p.phone.trim(),
      is_primary: !!p.is_primary,
    }));

  // Enforce exactly one primary
  const hasPrimary = incomingPhones.some((p) => p.is_primary);
  if (!hasPrimary && incomingPhones.length > 0) {
    incomingPhones[0].is_primary = true;
  }

  // Get existing rows
  const existingPhones = getContactPhoneEntries(contactId);
  const existingIds = new Set(existingPhones.map((p) => p.id));
  const incomingIds = new Set(incomingPhones.filter((p) => p.id).map((p) => p.id));

  // Delete rows not in incoming
  for (const existing of existingPhones) {
    if (!incomingIds.has(existing.id)) {
      dbRun("DELETE FROM contact_phones WHERE id = ?", [existing.id]);
    }
  }

  // Update existing / insert new
  for (const entry of incomingPhones) {
    if (entry.id && existingIds.has(entry.id)) {
      dbRun(
        "UPDATE contact_phones SET phone_e164 = ?, phone_normalized = ?, is_primary = ? WHERE id = ?",
        [entry.phone, toLookupKey(entry.phone), entry.is_primary ? 1 : 0, entry.id],
      );
    } else {
      dbRun(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source, created_at) VALUES (?, ?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP)",
        [crypto.randomUUID(), contactId, entry.phone, toLookupKey(entry.phone), entry.is_primary ? 1 : 0],
      );
    }
  }
  });
}

/**
 * Set a single phone as primary for a contact (legacy backward-compat path).
 * If phone doesn't exist in contact_phones, updates the top phone or inserts new.
 *
 * ATOMIC (BACKLOG-2496 / BACKLOG-2530), though it is the MILDEST of the four:
 * unlike `setContactPrimaryEmail` this branch UPDATES the top row or inserts,
 * and never mass-deletes, so no window existed in which the contact had no
 * numbers. It is still two statements in the `targetPhoneExists` branch —
 * demote the others, promote this one — and an interruption between them leaves
 * a contact with NO primary phone, which the edit form and every
 * "primary phone" read then disagree about. Wrapped for that, and so the four
 * address writers behave identically rather than three-out-of-four.
 */
export function setContactPrimaryPhone(
  contactId: string,
  phone: string,
): void {
  const newPhone = phone?.trim();
  if (!newPhone) return;

  dbTransaction(() => {

  const targetPhoneExists = dbGet<{ id: string }>(
    "SELECT id FROM contact_phones WHERE contact_id = ? AND phone_e164 = ?",
    [contactId, newPhone],
  );

  if (targetPhoneExists) {
    dbRun("UPDATE contact_phones SET is_primary = 0 WHERE contact_id = ? AND id != ?", [contactId, targetPhoneExists.id]);
    dbRun("UPDATE contact_phones SET is_primary = 1 WHERE id = ?", [targetPhoneExists.id]);
  } else {
    const existingPhone = dbGet<{ id: string }>(
      "SELECT id FROM contact_phones WHERE contact_id = ? ORDER BY is_primary DESC LIMIT 1",
      [contactId],
    );
    if (existingPhone) {
      dbRun("UPDATE contact_phones SET phone_e164 = ?, phone_normalized = ?, is_primary = 1 WHERE id = ?", [newPhone, toLookupKey(newPhone), existingPhone.id]);
    } else {
      dbRun(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, 1, 'manual')",
        [crypto.randomUUID(), contactId, newPhone, toLookupKey(newPhone)],
      );
    }
  }
  });
}

// ============================================
// CONTACT EMAIL QUERY HELPERS (TASK-2000)
// Extracted from emailSyncHandlers.ts raw SQL
// ============================================

/**
 * Get all distinct email addresses for contacts assigned to a transaction.
 * Used by email sync to filter provider searches by relevant contacts.
 */
export function getContactEmailsForTransaction(transactionId: string): string[] {
  const rows = dbAll<{ email: string }>(
    // BACKLOG-2366 (filter contributed here to avoid a gap between two PRs):
    // this builds the provider email-search filter for a transaction. Once
    // transaction_contacts removal is a tombstone, an unfiltered read would keep
    // pulling a removed party's new mail into the deal they were taken off —
    // the "removal is a negative signal" requirement. No-op until that PR lands.
    `SELECT DISTINCT LOWER(ce.email) as email
     FROM transaction_contacts tc
     JOIN contact_emails ce ON tc.contact_id = ce.contact_id
     WHERE tc.transaction_id = ? AND tc.removed_at IS NULL`,
    [transactionId],
  );
  return rows.map((r) => r.email);
}

/**
 * Get email addresses for a single contact (by contact ID).
 * Used during email sync to collect per-contact emails.
 */
export function getEmailsByContactId(contactId: string): string[] {
  const rows = dbAll<{ email: string }>(
    "SELECT email FROM contact_emails WHERE contact_id = ?",
    [contactId],
  );
  return rows.map((r) => r.email);
}

/**
 * Resolve a search query to matching contact email addresses.
 * Searches display_name, email, company, and title fields.
 * Used to translate user search terms into email-based provider filters.
 */
export function resolveContactEmailsByQuery(userId: string, query: string): string[] {
  const queryLower = query.toLowerCase().trim();
  const words = queryLower.split(/\s+/).filter((w) => w.length > 0);

  if (words.length <= 1) {
    // Single-word query: original behavior
    const rows = dbAll<{ email: string }>(
      `SELECT DISTINCT LOWER(ce.email) as email
       FROM contacts c
       JOIN contact_emails ce ON c.id = ce.contact_id
       WHERE c.user_id = ?${ACTIVE_CONTACTS_CLAUSE_C}
         AND (LOWER(c.display_name) LIKE ? OR LOWER(ce.email) LIKE ?
              OR LOWER(c.company) LIKE ? OR LOWER(c.title) LIKE ?)`,
      [userId, `%${queryLower}%`, `%${queryLower}%`, `%${queryLower}%`, `%${queryLower}%`],
    );
    return rows.map((r) => r.email);
  }

  // Multi-word query: each word must match at least one field (AND logic across words)
  const wordClauses = words.map(
    () =>
      `(LOWER(c.display_name) LIKE ? OR LOWER(ce.email) LIKE ?
        OR LOWER(c.company) LIKE ? OR LOWER(c.title) LIKE ?)`,
  );
  const params: string[] = [userId];
  for (const word of words) {
    params.push(`%${word}%`, `%${word}%`, `%${word}%`, `%${word}%`);
  }

  const rows = dbAll<{ email: string }>(
    `SELECT DISTINCT LOWER(ce.email) as email
     FROM contacts c
     JOIN contact_emails ce ON c.id = ce.contact_id
     WHERE c.user_id = ?${ACTIVE_CONTACTS_CLAUSE_C}
       AND ${wordClauses.join("\n       AND ")}`,
    params,
  );
  return rows.map((r) => r.email);
}

// Export types for consumers
export type { ContactWithActivity, TransactionWithRoles };

/** One contact's missing values, as planned by the read-only worker (BACKLOG-2536). */
export interface ContactBackfillPlanRow {
  contactId: string;
  emails: string[];
  phones: string[];
}

/**
 * Apply a backfill plan. THE ONLY WRITER (BACKLOG-2536).
 *
 * WHY THIS IS ON THE MAIN CONNECTION. The worker used to write these rows from
 * its own connection, which made a second writer. The contention was the
 * visible half — `better-sqlite3` is synchronous, so a main-connection
 * busy-wait blocks the whole process until `busy_timeout` expires, up to five
 * seconds. The invisible half was worse: `is_primary` was decided from a read
 * ("does this contact have any email yet?") and then written, and the main
 * process could insert into that gap. Two primaries, or none. **Nothing failed
 * — both writes succeeded and disagreed, which is why no retry could fix it.**
 *
 * `is_primary` is therefore decided HERE, inside the transaction, against what
 * the contact holds at the moment of the write. The plan does not carry it.
 *
 * `INSERT OR IGNORE` because the plan is a snapshot: the contact may have
 * gained a value between the worker's scan and this write, and that is a
 * no-op rather than a conflict.
 */
export function applyContactBackfillSync(plan: ContactBackfillPlanRow[]): number {
  if (plan.length === 0) return 0;

  return dbTransaction(() => {
    let updated = 0;

    for (const row of plan) {
      let touched = false;

      const hasEmail = dbGet<{ n: number }>(
        `SELECT COUNT(*) as n FROM contact_emails WHERE contact_id = ?`,
        [row.contactId],
      );
      let emailIsFirst = (hasEmail?.n ?? 0) === 0;

      for (const email of row.emails) {
        const result = dbRun(
          `INSERT OR IGNORE INTO contact_emails (id, contact_id, email, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
          [crypto.randomUUID(), row.contactId, email, emailIsFirst ? 1 : 0],
        );
        if (result.changes > 0) {
          touched = true;
          emailIsFirst = false;
        }
      }

      const hasPhone = dbGet<{ n: number }>(
        `SELECT COUNT(*) as n FROM contact_phones WHERE contact_id = ?`,
        [row.contactId],
      );
      let phoneIsFirst = (hasPhone?.n ?? 0) === 0;

      for (const phone of row.phones) {
        const digits = phone.replace(/\D/g, "");
        let phoneE164: string;
        if (digits.length === 10) phoneE164 = `+1${digits}`;
        else if (digits.length === 11 && digits.startsWith("1")) phoneE164 = `+${digits}`;
        else if (phone.startsWith("+")) phoneE164 = phone;
        else phoneE164 = `+${digits}`;

        const result = dbRun(
          `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
          [
            crypto.randomUUID(),
            row.contactId,
            phoneE164,
            phone,
            toLookupKey(phoneE164),
            phoneIsFirst ? 1 : 0,
          ],
        );
        if (result.changes > 0) {
          touched = true;
          phoneIsFirst = false;
        }
      }

      if (touched) updated++;
    }

    return updated;
  });
}
