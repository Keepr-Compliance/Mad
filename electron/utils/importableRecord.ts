/**
 * WHEN A SOURCE RECORD HAS NOTHING ON IT TO IMPORT — MAIN-PROCESS HALF
 * (BACKLOG-2684)
 *
 * ===========================================================================
 * MIRROR PAIR. Renderer copy: `src/utils/importableRecord.ts`
 * ===========================================================================
 * BACKLOG-2672 expressed this rule once, in the renderer, and disabled the
 * Import button with it. BACKLOG-2684 is the door behind that button:
 * `contacts:import` had no equivalent refusal, so anything reaching the IPC
 * channel directly still created the nameless contact BACKLOG-2461 exists to
 * eliminate — and no test anywhere would have failed.
 *
 * The item asks for the rule to be "expressed once and imported in both
 * places". THE MODULE BOUNDARY FORBIDS THAT, in both directions:
 *
 *   - `electron/` cannot import from `src/` — `rootDir` rejects it.
 *   - the renderer cannot VALUE-import from `electron/` — Vite parses it as
 *     JavaScript.
 *
 * So this is a MIRROR, which is the convention this repo already uses for
 * exactly this problem: `contactDisplayLabel`, `phoneNormalization`,
 * `contactNameCompat` and `contactSourceDefaults` are all mirror pairs. What
 * makes a mirror safe is not this comment —
 * `src/utils/__tests__/importableRecord.parity.test.ts` loads BOTH copies and
 * asserts identical answers over a corpus that sweeps the boundary.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY *NOT* MIRRORED
 * ===========================================================================
 * `isUnimportedSourceRecord` and `importBlockedReason` stay renderer-only.
 * Both take `isExternal` — membership of `ContactSearchList`'s
 * `externalContacts` array — which is a fact about what a list is showing, not
 * a fact about the record. It has no meaning in the main process.
 *
 * The handler needs no such gate: EVERY record arriving at `contacts:import`
 * is by definition being imported, so `hasNothingToImport` applies directly.
 * Mirroring the renderer's outer gate would have imported a question the main
 * process cannot answer, and answering it wrongly (`isExternal = false`) would
 * have disabled the refusal entirely while leaving every test green — the same
 * failure BACKLOG-2672 measured as its mutation 3.
 *
 * ===========================================================================
 * WHY `realContactName` IS REUSED FOR ALL FOUR FIELDS
 * ===========================================================================
 * The sentinel set `{"unknown", "unknown contact"}` lives in
 * `contactDisplayLabel.ts` — itself the canonical half of a mirror pair, so
 * each side of this file single-sources the set from its own side. A second
 * copy here would be a second place for that set to change, and the failure
 * would be silent in exactly the direction that matters: a new sentinel added
 * to the label chain and not here means a record that renders as "No name" is
 * still imported.
 *
 * `realContactName` is named for the name field but is a pure "trimmed value,
 * unless it is a placeholder" function, and applying it to an identifier is
 * exactly right: a phone of "unknown" is not a phone.
 */

import { realContactName } from "./contactDisplayLabel";



/**
 * The fields that decide whether there is anything to import.
 *
 * The plural arrays are load-bearing: they are where an address-book record
 * actually keeps its identifiers, and reading only the deprecated flat
 * `phone`/`email` would call a record with three phone numbers empty.
 */
export interface ImportableRecordParts {
  display_name?: string | null;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  allPhones?: string[];
  allEmails?: string[];
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
