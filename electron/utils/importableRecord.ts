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
 * The reason a refusal carries. Mirrors the renderer string exactly — the
 * parity test asserts the two are identical, because a caller that shows the
 * handler's message next to the button's message must not show two different
 * sentences for one rule.
 */
export const NOTHING_TO_IMPORT_REASON =
  "No name, phone, or email — nothing to import";

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
 * Nothing on this record to make a contact out of.
 *
 * THE PREDICATE IS DELIBERATELY NARROW, and every widening breaks a real
 * record. Control 2 of the founder's BACKLOG-2672 decision is that a record
 * with NO NAME but WITH A PHONE stays importable — 23 such records were parsed
 * at his last app start.
 *
 *  - COMPANY counts as a name. The display chain's second tier is the company,
 *    so a company-only record renders as "Vantrees Realty" on screen. Refusing
 *    it with "no name" would be false on its face.
 *  - NO DIGIT TEST on phones. An iMessage handle can be an Apple ID that is
 *    neither digits nor an email address and identifies a person perfectly
 *    well. Non-empty and non-placeholder is the whole test.
 */
export function hasNothingToImport(contact: ImportableRecordParts): boolean {
  if (usable(contact.display_name) || usable(contact.name)) return false;
  if (usable(contact.company)) return false;
  if (anyUsable([contact.phone, ...(contact.allPhones ?? [])])) return false;
  if (anyUsable([contact.email, ...(contact.allEmails ?? [])])) return false;
  return true;
}
