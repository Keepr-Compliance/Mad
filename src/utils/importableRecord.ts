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
 * Nothing on this record to make a contact out of AT ALL.
 *
 * THE LOOSER OF THE TWO RULES, and the one every other rule is derived from.
 * It answers "may this be SAVED?" — the question `contacts:create` and the Add
 * Contact form ask. `hasNothingToImport` below answers the narrower question by
 * CALLING this one, so the two can never drift apart.
 *
 * THE PREDICATE IS DELIBERATELY NARROW. Control 2 of the founder's decision is
 * that a record with NO NAME but WITH A PHONE must stay importable — 23 such
 * records were parsed at his last app start, and they are the common, useful
 * case. Every widening of this function is a step toward breaking them:
 *
 *  - COMPANY counts. The display chain's second tier is the company, so a
 *    company-only record renders as "Acme Corp" on screen. Refusing to SAVE
 *    that would be false on its face — and PM decision `5fac2d84` (2026-09-07,
 *    on the founder's delegated authority) makes it explicit: blocking
 *    hand-creation does not stop the data, it makes the user type the company
 *    into the NAME field, which is strictly worse. Import treats it differently
 *    — see below — and that is the ONLY difference between the two rules.
 *  - NO DIGIT TEST on phones. An iMessage handle can be an Apple ID that is
 *    neither digits nor an email address, and it identifies a person perfectly
 *    well. Non-empty and non-placeholder is the whole test.
 */
export function hasNothingToSave(contact: ImportableRecordParts): boolean {
  if (usable(contact.display_name) || usable(contact.name)) return false;
  if (usable(contact.company)) return false;
  if (anyUsable([contact.phone, ...(contact.allPhones ?? [])])) return false;
  if (anyUsable([contact.email, ...(contact.allEmails ?? [])])) return false;
  return true;
}

/**
 * Nothing on this record to IMPORT. Strictly narrower than `hasNothingToSave`,
 * BY CONSTRUCTION rather than by agreement.
 *
 * ===========================================================================
 * WHY THIS CALLS THE OTHER RULE INSTEAD OF RESTATING IT
 * ===========================================================================
 * BACKLOG-2707 is an item about two rules that were supposed to agree and did
 * not — the renderer offered an Import button the handler then refused. It was
 * fixed at the validator, and the founder's testing gate found the SAME shape
 * again in the renderer, and again in the Add Contact form. Writing a second
 * field list here, however carefully it matched on the day it was written,
 * would be that defect with new names.
 *
 * So the single import-specific fact — **a company is not an identifier you can
 * import somebody on** — is expressed as ONE FIELD OVERRIDE, and every other
 * field is inherited. Two properties follow and neither needs asserting:
 *
 *  1. Blanking a field can only move `hasNothingToSave` toward `true`, so
 *     nothing unsaveable can be importable. `importable ⊂ saveable` holds by
 *     construction.
 *  2. A new identifier added to `hasNothingToSave` — a second email column, a
 *     messaging handle — is honoured here for free, with nothing to remember.
 *
 * PM decision `5fac2d84`: import is inference, creation is intent. A nameless
 * record arriving from a sync is Keepr guessing a scrap is worth keeping; a
 * person typing a company name and pressing Save has said what they want.
 */
export function hasNothingToImport(contact: ImportableRecordParts): boolean {
  return hasNothingToSave({ ...contact, company: null });
}

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
 *
 * ===========================================================================
 * BACKLOG-2707 — WHY THERE ARE NOW TWO STRINGS AND NOT ONE
 * ===========================================================================
 * Once a company-only record became un-importable (PM decision `5fac2d84`),
 * ONE string could no longer be true of every record it covered. Measured: a
 * row rendering the label **"Vantrees Realty Test"** — because `labelForContact`
 * shows the company when there is no name — displayed a disabled button reading
 * "No name, phone, or email — nothing to import". Literally true of the three
 * fields; false to the person reading it, beside a row that is plainly showing
 * a name.
 *
 * A disabled button stating an untrue reason is THIS ITEM'S OWN DEFECT one
 * layer down: a control that says one thing and means another. So the reason is
 * chosen per record by `importRefusalReason`, and each string is true of
 * exactly the records it is shown on.
 */
export const NOTHING_TO_IMPORT_REASON =
  "No name, phone, or email — nothing to import";

/**
 * Shown when the record HAS a company and nothing else.
 *
 * It must read true next to the label on that same row, which is the company
 * name itself. It says what is missing and it says what would fix it, without
 * claiming the row is empty — which the reader can see it is not.
 */
export const COMPANY_ONLY_IMPORT_REASON =
  "A company on its own can't be imported — needs a name, phone, or email";

/**
 * WHICH reason this record gets, decided once so every surface agrees.
 *
 * Returns `null` when there is nothing to refuse. Both `importBlockedReason`
 * (the renderer's disabled-button text) and the `contacts:import` handler's
 * refusal message read it, so the string a user sees on the button is the same
 * string the door gives back — the disagreement this whole item is about.
 */
export function importRefusalReason(
  contact: ImportableRecordParts,
): string | null {
  if (!hasNothingToImport(contact)) return null;
  return usable(contact.company)
    ? COMPANY_ONLY_IMPORT_REASON
    : NOTHING_TO_IMPORT_REASON;
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
  // BACKLOG-2707: the WHICH-reason decision lives in `importRefusalReason`, so
  // the string on this disabled button is the same string `contacts:import`
  // returns for the same record. Two surfaces, one sentence.
  return importRefusalReason(contact);
}
