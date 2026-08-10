/**
 * One mailbox, one row — collapsing a source record's own repeated values.
 * (BACKLOG-2457)
 *
 * ===========================================================================
 * THE REPORTED CARD
 * ===========================================================================
 * Founder QA, 2026-08-04. One contact's row in the import picker — shown here
 * with fictional values, for the reason in the next section:
 *
 *     Emails
 *       quillfeather@example.test
 *       quillfeather@example.test
 *     Phone
 *       5555550142
 *
 * One Outlook record, one mailbox, listed under two FIELD TYPES on that record
 * (`Email` and `Chat`). Microsoft Graph returns both in the same
 * `emailAddresses` array, `_mapGraphContact` pushes each `address` it finds, and
 * `emails_json` therefore stores the string twice. Nothing downstream collapsed
 * it, so the picker drew it twice.
 *
 * ===========================================================================
 * FIXTURES ARE FICTIONAL, DELIBERATELY (BACKLOG-2485)
 * ===========================================================================
 * This defect was found against a real person in the founder's own address book,
 * and quoting that record verbatim is the obvious way to write the test. Don't:
 * this repository is PUBLIC, and a contact's name, mailbox and mobile number are
 * that third party's personal data — published without their knowledge, in the
 * source of a product whose entire purpose is handling exactly this data
 * carefully.
 *
 * Every address and number in this module and its tests is therefore drawn from
 * a range reserved so it cannot collide with a real person: `example.test` /
 * `example.com` domains (RFC 2606) and `555-01xx` numbers (reserved for
 * fiction). Names are unmistakably invented. The bug reproduces identically —
 * what matters is one value appearing twice on one record, never whose it was.
 *
 * This is NOT cross-record dedup. It is dedup WITHIN one source record, and it
 * is unaffected by BACKLOG-2556 — which DELETED the only code that decided the
 * Mac card and the Outlook record were the same person (`findDuplicateOwner`,
 * formerly in `contacts:get-available`). Nothing now compares one record to
 * another on content; this module still collapses a value repeated inside a
 * single record, which is not a judgement about people.
 *
 * ===========================================================================
 * WHY THE FIELD TYPE IS NOT THE POINT
 * ===========================================================================
 * It would be tempting to special-case Outlook's chat field. Don't: the shape
 * is general and every address book we read produces it.
 *
 *   - Outlook: `Email` / `Email 2` / `Email 3` / the chat field all land in the
 *     one Graph array.
 *   - Apple Contacts: `home` / `work` / `other` email labels, and a UNIFIED card
 *     merges the same address off several linked cards.
 *   - Phones are worse, not better: `_mapGraphContact` flattens `mobilePhone`,
 *     `homePhones` and `businessPhones` into one array, and Apple's unified
 *     cards routinely carry one number under both `mobile` and `iPhone`.
 *
 * So the rule is about the VALUE, not the label it arrived under.
 *
 * ===========================================================================
 * WHAT "THE SAME VALUE" MEANS
 * ===========================================================================
 * Byte equality is too strict to be useful — an address book is hand-typed.
 *
 *   emails: trim, then compare case-insensitively. `Robin@Example.test`, `robin@example.test `
 *           and `robin@example.test` are one mailbox. This is deliberately the SAME key
 *           `backfillContactEmailsSync` stores on (`toLowerCase().trim()`) and
 *           the same one `contactSourceValues.emailKey` removes on, so display
 *           and storage cannot disagree about how many addresses a record has.
 *
 *   phones: compare on `toLookupKey` — the shared last-10-digits key that
 *           `contact_phones.phone_normalized` is built from. `(555) 555-0142`,
 *           `+1 555-555-0142` and `5555550142` are one number.
 *
 * ===========================================================================
 * FIRST SPELLING WINS
 * ===========================================================================
 * The kept value is the FIRST occurrence, trimmed but otherwise untouched — the
 * source's own capitalisation and phone punctuation survive to the screen. A
 * card that silently rewrote `Robin@Example.test` to lowercase would be a
 * second, quieter version of the same complaint: the picker showing something
 * other than what the address book says.
 *
 * Order is otherwise preserved, so the primary (index 0) that
 * `contacts:get-available` derives with `emails?.[0]` is still the record's
 * first-listed address.
 */

import { toLookupKey } from "./phoneNormalization";

/**
 * Collapse a source record's repeated values, keeping first-seen order and the
 * first spelling of each.
 *
 * `keyOf` returns the comparison key. A key of `""` means "this value has no
 * usable identity" and the value is DROPPED — that only happens for blank
 * strings, which no card should render as an empty bullet anyway.
 *
 * Non-string entries are dropped too. `emails_json` is parsed from a TEXT
 * column written by several sync providers over several schema versions; a
 * `null` or a number in there must not become a rendered row or a crash.
 */
function dedupeBy(
  values: readonly unknown[] | null | undefined,
  keyOf: (trimmed: string) => string,
): string[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    const key = keyOf(trimmed);
    if (key === "" || seen.has(key)) continue;

    seen.add(key);
    out.push(trimmed);
  }

  return out;
}

/**
 * One row per mailbox. Case-insensitive, whitespace-trimmed.
 *
 * @example
 * dedupeEmailValues(["quillfeather@example.test", "quillfeather@example.test"])
 * // ["quillfeather@example.test"]     <- the reported card
 *
 * @example
 * dedupeEmailValues(["Robin@Example.test", "robin@example.test ", "other@example.test"])
 * // ["Robin@Example.test", "other@example.test"]       <- first spelling kept, order kept
 */
export function dedupeEmailValues(
  values: readonly unknown[] | null | undefined,
): string[] {
  return dedupeBy(values, (trimmed) => trimmed.toLowerCase());
}

/**
 * One row per number, compared after normalisation.
 *
 * `toLookupKey` returns the trimmed input unchanged when it contains no digits
 * at all (a pager label, a stray note), so two genuinely different non-numeric
 * entries still count as two — dedup must never be a licence to hide a value it
 * failed to parse.
 *
 * @example
 * dedupePhoneValues(["(555) 555-0142", "+1 555-555-0142"])
 * // ["(555) 555-0142"]                  <- same number, mobile + iPhone labels
 *
 * @example
 * dedupePhoneValues(["5555550142", "5555550187"])
 * // ["5555550142", "5555550187"]      <- two distinct numbers both survive
 */
export function dedupePhoneValues(
  values: readonly unknown[] | null | undefined,
): string[] {
  return dedupeBy(values, (trimmed) => toLookupKey(trimmed));
}
