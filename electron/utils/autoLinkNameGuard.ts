/**
 * Do the NAMES support linking these two automatically? (BACKLOG-2619 /
 * BACKLOG-2624)
 *
 * ===========================================================================
 * THIS IS NOT A MATCHING RULE. IT IS A VETO.
 * ===========================================================================
 * Nothing here ever says "these are the same person". A name is never a
 * positive signal for linking — that is the mechanism `contactSourceLinker`'s
 * header calls "NEVER FALL BACK TO NAME", and it stays deleted.
 *
 * What this answers is the opposite question, asked only AFTER something else
 * has already matched: an identifier was shared, so may that match be applied
 * SILENTLY, or must a human be asked?
 *
 *     shared identifier + agreeing names   -> act   (link, no question)
 *     shared identifier + disagreeing names -> ask  (question, no link)
 *     shared identifier + a missing name    -> ask  (question, no link)
 *
 * ===========================================================================
 * WHY A MISSING NAME MEANS ASK — BACKLOG-2624
 * ===========================================================================
 * `namesAreCompatible("", x)` returns TRUE: an empty name cannot contradict, so
 * it is compatible with everyone. That is the right answer for the question
 * THAT function is asked (its one production caller is a scroll-anchor rule
 * which removes nothing), and it is the wrong answer here, because it disables
 * the veto for exactly the records carrying the least evidence — 18 of the
 * founder's 1,124 macOS contacts have no name at all, plus every email-only
 * record.
 *
 * **A missing name is absence of evidence, not evidence of a match.** So this
 * module does not change `namesAreCompatible`; it composes it with an explicit
 * rule of its own, per the founder's standing instruction to suppress only what
 * we KNOW and never what we GUESS.
 *
 * ===========================================================================
 * WHAT COUNTS AS "NO NAME" — three shapes, and two of them look like names
 * ===========================================================================
 * 1. Blank / whitespace.
 *
 * 2. A MACHINE SENTINEL. `schema.sql` declares `display_name TEXT NOT NULL`, so
 *    "write nothing" was never available and five live paths write the literal
 *    "Unknown" instead (`contactDbService.ts:187,327`, `contactHandlers.ts:1280,1519`,
 *    `localSyncService.ts:1534`). `realContactName` already owns that set; it is
 *    reused here rather than restated so the two cannot drift.
 *
 * 3. AN IDENTIFIER ECHO — the case that would have quietly defeated this guard.
 *    `contactsService.buildContactLabel` bakes `emails[0]`, else the formatted
 *    `phones[0]`, into a nameless record's `name`, and `validateContactData`
 *    forces that same string into `contacts.display_name` on import. So TWO
 *    nameless records that share one email both end up carrying the SAME baked
 *    label — two identical strings, which a naive check reads as a name match
 *    and links. That is BACKLOG-2624's defect wearing a disguise: a match on
 *    emptiness, laundered through a label the app wrote itself.
 *
 *    A name that is exactly one of the record's own identifiers is therefore
 *    treated as absent. Exact comparison only — lowercased equality for email,
 *    a ten-digit lookup key for phone — so a person genuinely called
 *    "Unknown Records LLC", or one whose name merely contains a digit, keeps
 *    their name.
 *
 * ===========================================================================
 * WHY THERE IS NO `src/` MIRROR
 * ===========================================================================
 * `contactNameCompat.ts` and `contactDisplayLabel.ts` are both hand-duplicated
 * for the renderer because both processes need to answer their question. This
 * one has no renderer consumer and must not acquire one: the renderer no longer
 * decides whether two records are the same person at all (BACKLOG-2370 — "a
 * hiding rule that stores nothing cannot be audited or undone"). Auto-linking is
 * a main-process decision that writes a row, and it belongs where the row is
 * written. If a renderer ever needs this verdict, mirror it and pin the pair
 * with a parity test rather than re-deriving the rule.
 */

import { namesAreCompatible } from "./contactNameCompat";
import { realContactName } from "./contactDisplayLabel";
import { toLookupKey } from "./phoneNormalization";

/**
 * Why the names refused an automatic link. Recorded distinguishably because the
 * remedies differ: a mismatch is evidence these may be two people sharing a
 * line, whereas a missing name is no evidence at all and the question reads
 * differently.
 */
export type AutoLinkNameRefusal = "name_mismatch" | "name_unknown";

export type AutoLinkNameVerdict =
  | { supportsLink: true }
  | { supportsLink: false; reason: AutoLinkNameRefusal };

export interface AutoLinkNameInput {
  /** The source record's name, as the source spells it. */
  recordName?: string | null;
  /** The saved contact's `display_name`. */
  contactName?: string | null;
  /**
   * The record's OWN identifiers — used only to recognise a baked label (see
   * shape 3 above). Never used to compare the names themselves.
   */
  identifiers?: { emails?: string[] | null; phones?: string[] | null };
}

/** A ten-digit lookup key, and nothing else. */
const TEN_DIGIT_KEY = /^\d{10}$/;

/**
 * The name a human would recognise as a name, or "" when there isn't one.
 *
 * `toLookupKey` returns the ORIGINAL STRING when its input holds no digits, so
 * the phone comparison is gated on the key actually being ten digits. Without
 * that gate every name would be its own lookup key and any record whose phone
 * list happened to contain that same text would read as an echo.
 */
function usableName(
  raw: string | null | undefined,
  emailKeys: Set<string>,
  phoneKeys: Set<string>,
): string {
  const real = realContactName(raw);
  if (!real) return "";

  if (emailKeys.has(real.toLowerCase())) return "";

  const key = toLookupKey(real);
  if (TEN_DIGIT_KEY.test(key) && phoneKeys.has(key)) return "";

  return real;
}

/**
 * May a match on a shared identifier be applied without asking?
 *
 * Returns a verdict rather than a boolean so the caller can file the RIGHT
 * question — "these are saved under different names" and "one of these has no
 * name" are different things to put in front of a person.
 */
export function nameSupportForAutoLink(input: AutoLinkNameInput): AutoLinkNameVerdict {
  const emailKeys = new Set(
    (input.identifiers?.emails ?? [])
      .map((e) => (e || "").trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
  const phoneKeys = new Set(
    (input.identifiers?.phones ?? [])
      .map((p) => toLookupKey(p))
      .filter((k) => TEN_DIGIT_KEY.test(k)),
  );

  const record = usableName(input.recordName, emailKeys, phoneKeys);
  const contact = usableName(input.contactName, emailKeys, phoneKeys);

  // BACKLOG-2624. Checked BEFORE compatibility, because `namesAreCompatible`
  // would answer `true` here and that answer is the defect.
  if (!record || !contact) return { supportsLink: false, reason: "name_unknown" };

  if (!namesAreCompatible(record, contact)) {
    return { supportsLink: false, reason: "name_mismatch" };
  }
  return { supportsLink: true };
}
