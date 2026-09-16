/**
 * =============================================================================
 * BACKLOG-3358 — AN ADDRESS-BOOK VALUE THE APP CANNOT USE NO LONGER BLOCKS
 * THE IMPORT
 * =============================================================================
 * `contacts:import` hands each record to `validateContactData`, the same
 * validator `contacts:create` and `contacts:update` use. That validator checks
 * the record's SCALAR `email` and `phone` — which, for a picker row, are the
 * address book's FIRST email and FIRST phone (`contacts:get-available` sets
 * `email: emails[0]`). So one card whose first address has no dot after the
 * `@`, or whose first phone field holds two numbers jammed together past 50
 * characters, was refused whole. Every press of Import failed, forever, while
 * the same bad value in SECOND position imported without complaint (arrays are
 * not validated and never were).
 *
 * The founder's rule (pm_comments on BACKLOG-3358, 2026-09-15): **save the
 * values as the address book has them, with a USABLE one first.** This module
 * is that rule, for one record, on the import path only.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DOES
 * -----------------------------------------------------------------------------
 *   - Emails and phones are REORDERED, never removed and never cut: usable
 *     values first, then the rest in the address book's order. A cut address or
 *     number is a DIFFERENT identifier — it would later be matched and linked as
 *     one — so nothing identifying is ever truncated.
 *   - The scalar `email` / `phone` handed to the validator is the first USABLE
 *     value (trimmed), or `null` when none is usable. So the validator cannot
 *     refuse a record for a value the address book merely happens to hold.
 *   - Name, company and title are free text: cut to the validator's own limits
 *     (`CONTACT_FIELD_MAX_LENGTH`), never mid-surrogate-pair.
 *
 * `createContactsBatch` marks the FIRST stored value primary
 * (`contactDbService.createContactsBatch`), so the order produced here decides
 * which address the saved contact shows. Later copies (the in-import link
 * copy, both relaunch backfills) set `is_primary` only when the contact holds
 * no rows at all, so they never move it.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * -----------------------------------------------------------------------------
 *   - It does not loosen `validateContactData`. Add Contact and Edit still
 *     refuse a bad address typed by hand; separation is by construction, since
 *     only the import loop calls this.
 *   - It does not decide whether a record is importable at all. The handler
 *     runs `importRefusalReason` on the RAW record first, and nothing here
 *     changes whether a value is present — only its order, whitespace and
 *     length.
 *   - It does not validate type. A non-string passes through untouched so the
 *     validator still refuses it with its own message.
 *
 * "Usable" is defined by CALLING the validator, not by a second copy of its
 * regex, so the two cannot drift. Trim first, then check: the validator tests
 * its regex before trimming, which is why a padded address is refused when
 * typed, and an address book's stray space must not decide the primary.
 */
import {
  CONTACT_FIELD_MAX_LENGTH,
  validateEmail,
  validateString,
} from "./validation";

function accepts(check: () => unknown): boolean {
  try {
    return check() !== null;
  } catch {
    return false;
  }
}

/** Usable = the create/update email validator accepts it once trimmed. */
export function isUsableImportEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && accepts(() => validateEmail(trimmed, false));
}

/**
 * BACKLOG-3376 — CAN THIS VALUE EVER EQUAL AN `email_participants.email_address`?
 *
 * A STRICT SUBSET of "not usable", and deliberately much narrower than it. The
 * import saves every address the source holds (`createContactsBatch` and
 * `backfillContactEmailsSync` apply no format check at all), and the
 * auto-linker reads every stored row back and matches it by EXACT string
 * equality after `toLowerCase().trim()` — `AUTOLINK_CONTACT_EMAILS_SQL` in
 * `autoLinkSql.ts` selects every row, and the candidate lookup binds them into
 * an `email_participants.email_address IN (...)`. So an address links iff some
 * participant address equals it. Validity never enters it.
 *
 * `validateEmail` refuses far more than that. `pat@intranet` has no dot after
 * the `@`, so the import calls it unusable — and it is stored, and its mail
 * links perfectly normally. "Emails from it won't be linked" would be a FALSE
 * statement about that address. Same for `name@`, `@domain.com`,
 * `name@domain.`, `two@@domain.com` and a 256-character address: all unusable,
 * all matchable, all SILENT.
 *
 * Two arms, and they do NOT rest on the same footing:
 *
 *   - NO `@` — ENFORCED in this repo, on every writer of
 *     `email_participants.email_address`. Gmail (`gmailFetchService.ts`) and the
 *     legacy self-derive (`emailDbService.ts`) both go through
 *     `parseEmailAddressList` -> `validateAddress` (`emailAddress.ts`), which
 *     returns "missing \'@\'" and pushes the value into `.errors`; neither
 *     reader ever looks at `.errors`. Outlook/Graph (`outlookFetchService.ts`)
 *     rejects `indexOf("@") < 1` and a trailing `@` inline. The staging promote
 *     (`emailStagingSql.ts`) is an `INSERT ... SELECT` relaying rows already
 *     produced by one of those three, so it introduces no new address shape.
 *
 *   - INTERIOR WHITESPACE — enforced on the Gmail and legacy paths by that same
 *     `validateAddress` ("invalid character: whitespace in address"), but on the
 *     Outlook/Graph direct path it is a PREMISE, not a check:
 *     `normalizeEmailAddress` is `toLowerCase().trim()` and deliberately does
 *     not collapse interior space. The premise is that providers deliver
 *     RFC 5321 addr-specs, which cannot carry a space. NOT verified against live
 *     provider output.
 *
 * The direction of the error matters. Being a strict subset, this can only ever
 * UNDER-warn — stay silent about an address that in fact will not link. For a
 * sentence stated as definitely true, that is the safe direction.
 *
 * `isUsableImportEmail` is checked as well, so the subset relation holds by
 * construction rather than by coincidence. Today that check is redundant: a
 * value the validator accepts has matched `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, so
 * it can carry neither whitespace nor a missing `@` — and removing it was
 * MEASURED INERT (BACKLOG-3376 implementation handoff, mutation M10). It is kept
 * because it is the only thing that would still hold the invariant if that regex
 * were ever loosened, which is what the sweep in `contactImportValues-3376.test.ts`
 * exists to catch.
 *
 * PHONES ARE NOT COVERED. An unusable phone is only one longer than 50
 * characters (`isUsableImportPhone` passes no pattern), and whether such a value
 * can match a message handle runs through `normalizeToE164` ->
 * `phone_normalized` -> `normalizePhone` in `autoLinkService.ts`. **MECHANISM
 * UNTRACED** — no phone sentence is shipped on it. The question is on
 * BACKLOG-3377.
 */
export function isUnmatchableImportEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  // The two arms: whitespace inside it, or no `@` at all.
  const cannotBeAddressed = /\s/.test(trimmed) || !trimmed.includes("@");
  if (!cannotBeAddressed) return false;
  // The subset guard. LAST for a compiler reason, not a logical one:
  // `isUsableImportEmail` is declared `value is string`, so testing it in a
  // condition narrows an already-`string` binding to `never` in the false
  // branch and every use of `trimmed` after it fails to compile. Order does not
  // change the result — the conjunction is the same either way.
  return !isUsableImportEmail(trimmed);
}

/**
 * The unmatchable entries of ONE record's email list, in the address book's own
 * order and its own casing, deduped on `toLowerCase().trim()` — the same key
 * `createContactsBatch` dedupes stored rows on, so the message can never name
 * two entries the database stored as one.
 *
 * Reads the ORDERED list, which is a permutation of the record's candidates with
 * the usable ones hoisted to the front. Every unmatchable value is unusable, so
 * all of them sit in the tail, where the source's own order is preserved.
 *
 * The address book's casing, not the stored lowercase form: the user is being
 * asked to go and find this address on their own contact card.
 */
function unmatchableFrom(ordered: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of ordered) {
    if (!isUnmatchableImportEmail(value)) continue;
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Usable = the create/update phone validator accepts it once trimmed. */
export function isUsableImportPhone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    accepts(() =>
      validateString(trimmed, "phone", {
        maxLength: CONTACT_FIELD_MAX_LENGTH.phone,
      }),
    )
  );
}

/**
 * Cut free text to `max` UTF-16 units — the unit the validator measures in.
 * A cut that would leave half of a surrogate pair drops that half, so an emoji
 * at the boundary is removed whole rather than stored as a broken character.
 */
function cutText(value: unknown, max: number): { value: unknown; cut: boolean } {
  if (typeof value !== "string") return { value, cut: false };
  const trimmed = value.trim();
  if (trimmed.length <= max) return { value, cut: false };
  let out = trimmed.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return { value: out.trimEnd(), cut: true };
}

interface OrderedValues {
  ordered: unknown[];
  firstUsable: string | null;
  /** The first non-blank value is unusable. */
  firstUnusable: boolean;
  /** At least one non-blank value, and none of them usable. */
  none: boolean;
}

function usableFirst(
  list: unknown,
  scalar: unknown,
  isUsable: (v: unknown) => v is string,
): OrderedValues {
  // A record with an empty array but a scalar (message-derived rows) is
  // treated as holding that one value — which is also what
  // `createContactsBatch` stores for it.
  const candidates: unknown[] =
    Array.isArray(list) && list.length > 0
      ? list
      : typeof scalar === "string" && scalar.trim() !== ""
        ? [scalar.trim()]
        : [];
  const usable = candidates.filter(isUsable);
  const rest = candidates.filter((v) => !isUsable(v));
  const nonBlank = candidates.filter(
    (v) => typeof v === "string" && v.trim() !== "",
  );
  return {
    ordered: [...usable, ...rest],
    firstUsable: usable.length > 0 ? usable[0].trim() : null,
    firstUnusable: nonBlank.length > 0 && !isUsable(nonBlank[0]),
    none: nonBlank.length > 0 && usable.length === 0,
  };
}

/**
 * What changed on one record, for the counts-only Sentry warning.
 *
 * A bad value in a LATER position is not an adjustment: that record imported
 * before this change and nothing about it differs now. Counting it would turn
 * "imports this change unblocked" into "imports carrying junk".
 */
export interface ImportAdjustments {
  nameCut: boolean;
  companyCut: boolean;
  titleCut: boolean;
  /** The first email was unusable; a usable one exists and is now first. */
  emailReordered: boolean;
  phoneReordered: boolean;
  /** The record holds at least one email and none is usable. */
  noUsableEmail: boolean;
  noUsablePhone: boolean;
}

export interface ShapedImportValues<T> {
  /** The record to hand `validateContactData`. */
  forValidation: T;
  /** Every email the record holds, usable first. */
  allEmails: string[];
  /** Every phone the record holds, usable first. */
  allPhones: string[];
  /**
   * BACKLOG-3376 — the record's addresses that satisfy
   * `isUnmatchableImportEmail`: saved as the source has them, and unable to
   * equal any `email_participants.email_address`. Empty when there is nothing
   * to say. NOT on `ImportAdjustments` or `ImportAdjustmentCounts` on purpose —
   * the handler spreads the counts object straight into a Sentry `extra`, and
   * that warning stays counts-only (BACKLOG-3358).
   */
  unmatchableEmails: string[];
  adjustments: ImportAdjustments;
}

export function hasImportAdjustment(a: ImportAdjustments): boolean {
  return (
    a.nameCut ||
    a.companyCut ||
    a.titleCut ||
    a.emailReordered ||
    a.phoneReordered ||
    a.noUsableEmail ||
    a.noUsablePhone
  );
}

/** Per-call totals for the counts-only Sentry warning. No values, ever. */
export interface ImportAdjustmentCounts {
  recordsAdjusted: number;
  namesCut: number;
  companiesCut: number;
  titlesCut: number;
  emailsReordered: number;
  phonesReordered: number;
  noUsableEmail: number;
  noUsablePhone: number;
}

export function emptyImportAdjustmentCounts(): ImportAdjustmentCounts {
  return {
    recordsAdjusted: 0,
    namesCut: 0,
    companiesCut: 0,
    titlesCut: 0,
    emailsReordered: 0,
    phonesReordered: 0,
    noUsableEmail: 0,
    noUsablePhone: 0,
  };
}

export function addImportAdjustments(
  counts: ImportAdjustmentCounts,
  a: ImportAdjustments,
): void {
  if (hasImportAdjustment(a)) counts.recordsAdjusted++;
  if (a.nameCut) counts.namesCut++;
  if (a.companyCut) counts.companiesCut++;
  if (a.titleCut) counts.titlesCut++;
  if (a.emailReordered) counts.emailsReordered++;
  if (a.phoneReordered) counts.phonesReordered++;
  if (a.noUsableEmail) counts.noUsableEmail++;
  if (a.noUsablePhone) counts.noUsablePhone++;
}

/** The field names the counts touch, in a fixed order. Names only. */
export function adjustedFieldNames(counts: ImportAdjustmentCounts): string[] {
  const fields: string[] = [];
  if (counts.namesCut > 0) fields.push("name");
  if (counts.companiesCut > 0) fields.push("company");
  if (counts.titlesCut > 0) fields.push("title");
  if (counts.emailsReordered > 0 || counts.noUsableEmail > 0) fields.push("email");
  if (counts.phonesReordered > 0 || counts.noUsablePhone > 0) fields.push("phone");
  return fields;
}

export function shapeImportValues<T extends object>(
  record: T,
): ShapedImportValues<T> {
  const view = record as Record<string, unknown>;
  const name = cutText(view.name, CONTACT_FIELD_MAX_LENGTH.name);
  const company = cutText(view.company, CONTACT_FIELD_MAX_LENGTH.company);
  const title = cutText(view.title, CONTACT_FIELD_MAX_LENGTH.title);
  const emails = usableFirst(view.allEmails, view.email, isUsableImportEmail);
  const phones = usableFirst(view.allPhones, view.phone, isUsableImportPhone);

  const forValidation = {
    ...view,
    ...(view.name !== undefined ? { name: name.value } : {}),
    ...(view.company !== undefined ? { company: company.value } : {}),
    ...(view.title !== undefined ? { title: title.value } : {}),
    email: emails.firstUsable,
    phone: phones.firstUsable,
  } as T;

  return {
    forValidation,
    // The arrays reach `createContactsBatch` exactly as the handler passed the
    // raw ones before: typed `string[]`, contents whatever the source held.
    allEmails: emails.ordered as string[],
    allPhones: phones.ordered as string[],
    unmatchableEmails: unmatchableFrom(emails.ordered),
    adjustments: {
      nameCut: name.cut,
      companyCut: company.cut,
      titleCut: title.cut,
      emailReordered: emails.firstUnusable && !emails.none,
      phoneReordered: phones.firstUnusable && !phones.none,
      noUsableEmail: emails.none,
      noUsablePhone: phones.none,
    },
  };
}
