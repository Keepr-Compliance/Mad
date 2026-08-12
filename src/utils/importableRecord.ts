/**
 * WHEN A SOURCE RECORD HAS NOTHING ON IT TO IMPORT (BACKLOG-2672)
 *
 * ===========================================================================
 * THE RECORD THIS EXISTS FOR
 * ===========================================================================
 * The founder searched Clients & Contacts for "Unknown" and found:
 *
 *     U   unknown
 *         Message · Not Imported · [Import]
 *         Phone: unknown
 *
 * Six of them are in his book. Pressing Import would have created a contact
 * with nothing on it — the exact state BACKLOG-2461 was filed to eliminate,
 * arriving through a door 2461 did not close.
 *
 * ===========================================================================
 * WHERE THE ROW COMES FROM, BECAUSE IT IS NOT WHERE IT LOOKS LIKE
 * ===========================================================================
 * It is NOT an `external_contacts` row. `getMessageDerivedContacts`
 * (`electron/services/db/contactDbService.ts:165`) synthesises message-derived
 * pseudo-contacts straight out of the `messages` table — there is no
 * `external_contacts` row and no `contacts` row behind them at all. Its SQL
 * projects, per distinct `participants.$.from`:
 *
 *     display_name / name = from                    -> 'unknown'
 *     phone               = from, when it has no @  -> 'unknown'
 *     email               = NULL
 *     company             = NULL
 *
 * The literal comes from
 * `macOSMessagesImportService.ts:909-913`:
 * `sanitizeString(msg.handle_id, MAX_HANDLE_LENGTH, "unknown")` — a message
 * whose `handle_id` is NULL or empty gets the STRING "unknown" as its
 * participant, and every such message in the corpus groups into ONE row.
 *
 * That is also why the row reads "unknown" rather than "No name":
 * `labelForContact` tiers name -> company -> phone -> email, `realContactName`
 * correctly rejects the "unknown" sentinel in the NAME tier, and the chain then
 * falls through to the PHONE tier — where `formatPhoneNumber("unknown")` finds
 * no digits and returns its input verbatim (`phoneNormalization.ts:135`).
 *
 * ===========================================================================
 * WHY `realContactName` IS REUSED FOR ALL FOUR FIELDS
 * ===========================================================================
 * The sentinel set `{"unknown", "unknown contact"}` lives in
 * `contactDisplayLabel.ts` and is what makes the NAME tier reject this record.
 * A second copy here would be a second place for that set to change, and the
 * failure would be silent in exactly the direction that matters: a new sentinel
 * added to the label chain and not to this file means a record that renders as
 * "No name" is still offered for import.
 *
 * So `realContactName` is applied to the company, phone and email values too.
 * It is named for the name field but it is a pure "trimmed value, unless it is
 * a placeholder" function, and applying it to an identifier is exactly right:
 * a phone of "unknown" is not a phone.
 */

import { realContactName } from "./contactDisplayLabel";

/**
 * The reason, shown ON the disabled control — never in a tooltip.
 *
 * FOUNDER DECISION, 12 Aug (BACKLOG-2672, option 2): the reason must name the
 * MISSING THING, not the rule. "This record cannot be imported" tells him
 * nothing the grey button did not.
 *
 * His example string was *"No name or phone number — nothing to import"*. It
 * omits email while his rule names all three fields, and a record that shows
 * this string is missing all three — so the complete list is the accurate one.
 * The one-word extension is deliberate and is flagged in the PR.
 */
export const NOTHING_TO_IMPORT_REASON =
  "No name, phone, or email — nothing to import";

/**
 * The fields that decide whether there is anything to import.
 *
 * Mirrors `ContactLabelParts` plus the plural arrays, because the plural arrays
 * are where an address-book record actually keeps its identifiers — reading
 * only the deprecated flat `phone`/`email` would call a record with three phone
 * numbers empty.
 */
export interface ImportableRecordParts {
  display_name?: string | null;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  allPhones?: string[];
  allEmails?: string[];
  /**
   * Truthy on any row the renderer is showing as UNSAVED — both address-book
   * rows (stamped by `useContactDirectory`) and message-derived pseudo-contacts
   * (`1 as is_message_derived` in the synthesising SQL). See
   * `isUnimportedSourceRecord`.
   */
  is_message_derived?: number | boolean;
}

/** Present, once placeholders are discounted. */
function usable(value: string | null | undefined): boolean {
  return realContactName(value).length > 0;
}

/** Any usable entry in a list of identifiers. */
function anyUsable(values: (string | null | undefined)[]): boolean {
  return values.some(usable);
}

/**
 * Nothing on this record to make a contact out of.
 *
 * THE PREDICATE IS DELIBERATELY NARROW. Control 2 of the founder's decision is
 * that a record with NO NAME but WITH A PHONE must stay importable — 23 such
 * records were parsed at his last app start, and they are the common, useful
 * case. Every widening of this function is a step toward breaking them:
 *
 *  - COMPANY counts as a name. The display chain's second tier is the company,
 *    so a company-only record renders as "Acme Corp" on screen. Refusing that
 *    one with "no name" would be false on its face.
 *  - NO DIGIT TEST on phones. An iMessage handle can be an Apple ID that is
 *    neither digits nor an email address, and it identifies a person perfectly
 *    well. Non-empty and non-placeholder is the whole test.
 */
export function hasNothingToImport(contact: ImportableRecordParts): boolean {
  if (usable(contact.display_name) || usable(contact.name)) return false;
  if (usable(contact.company)) return false;
  if (anyUsable([contact.phone, ...(contact.allPhones ?? [])])) return false;
  if (anyUsable([contact.email, ...(contact.allEmails ?? [])])) return false;
  return true;
}

/**
 * Is this row a SOURCE RECORD — something an Import/Add press would CREATE a
 * contact from — rather than a contact that already exists?
 *
 * Both legs are load-bearing and neither subsumes the other:
 *
 *  - `isExternal` is `ContactSearchList`'s membership test against the
 *    `externalContacts` array (`contacts:get-available`, i.e. the address-book
 *    half).
 *  - `is_message_derived` is what the message-derived pseudo-contacts carry.
 *    They arrive in the SAVED half's array (`contacts:get-all` merges them at
 *    `contactDbService.ts:765`), so `externalSet` does not contain them and
 *    `isExternal` is FALSE for the founder's own record.
 *
 * Gating on `isExternal` alone would therefore have missed the record this item
 * is about, with every test green.
 */
export function isUnimportedSourceRecord(
  contact: ImportableRecordParts,
  isExternal: boolean,
): boolean {
  return (
    isExternal ||
    contact.is_message_derived === 1 ||
    contact.is_message_derived === true
  );
}

/**
 * The reason to show on this row's import control, or `null` when the control
 * should behave normally.
 *
 * The saved-contact gate is here rather than at each call site so no surface can
 * forget it. A SAVED contact with an empty label is not blocked: adding an
 * existing contact to a transaction is not an import, and refusing it would
 * break a real workflow to guard against a state that gate 4 check 6 measured
 * as zero rows.
 */
export function importBlockedReason(
  contact: ImportableRecordParts,
  isExternal: boolean,
): string | null {
  if (!isUnimportedSourceRecord(contact, isExternal)) return null;
  return hasNothingToImport(contact) ? NOTHING_TO_IMPORT_REASON : null;
}
