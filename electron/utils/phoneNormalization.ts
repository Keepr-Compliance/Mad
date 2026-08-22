/**
 * Phone Number Normalization Utilities (consolidated module — BACKLOG-1729)
 *
 * Single source of truth for phone normalization across the Electron main process.
 * Replaces:
 *   - electron/utils/phoneUtils.ts (deleted)
 *   - electron/utils/phoneLookupKey.ts (reduced to 1-line shim — see migration v40 immutability note)
 *
 * Canonical functions:
 *   - `toE164(raw)` → "+15555550112" form (used for display / contact storage)
 *   - `toLookupKey(raw)` → "15555550112" (E.164 digits) (used as JOIN key against
 *     `phone_last_message.phone_normalized` / `contact_phones.phone_normalized` /
 *     `external_contacts.phones_normalized_json`)
 *   - `toMatchingKey(raw)` → `toLookupKey` above a digit floor, `""` below it
 *     (used ONLY to emit match CANDIDATES — never to store, search or display)
 *
 * BACKLOG-2630 slice 1 changed `toLookupKey` from last-ten-digits to the
 * library-parsed E.164 digits. Migration v64 re-keys every persisted store to
 * match; migration v40's original last-ten backfill is superseded by it.
 *
 * Behavioural changes adopted during consolidation (see PR description for audit):
 *   - `toE164("")` returns `""` (not `"+"` as the old phoneNormalization version did).
 *     The phoneUtils branch already had this guard; the bug was latent (no caller
 *     keyed off the `"+"` sentinel).
 */

import { parsePhoneNumberFromString } from "libphonenumber-js";

import { REGEX_PATTERNS } from "../constants";

// ---------------------------------------------------------------------------
// Canonical helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a phone number to E.164-ish format (`+` followed by digits).
 *
 * - Email handles (contain `@`) are returned lowercased, untouched.
 * - 10-digit US numbers gain a `1` country code prefix.
 * - Other inputs keep all digits.
 * - Null / undefined / empty / whitespace-only / no-digit input returns `""`.
 *
 * Returns `""` for invalid input. If you need null-discriminator semantics, wrap
 * at the call site (see `messageMatchingService.normalizePhone`).
 *
 * @example
 * toE164("(555) 555-0112")        // "+15555550112"
 * toE164("+44 20 7946 0958")      // "+442079460958"
 * toE164("User@ICLOUD.COM")       // "user@icloud.com"
 * toE164("")                      // ""
 * toE164(null)                    // ""
 */
export function toE164(phone: string | null | undefined): string {
  if (!phone) return "";

  // Preserve email handles unchanged (lowercased)
  if (phone.includes("@")) return phone.toLowerCase();

  // Remove all non-digit characters
  let digits = phone.replace(REGEX_PATTERNS.PHONE_NORMALIZE, "");

  if (!digits) return "";

  // 10-digit US: prepend country code
  if (digits.length === 10) {
    digits = "1" + digits;
  }

  return "+" + digits;
}

/**
 * The default region for a phone number written WITHOUT a country code.
 *
 * No parser — not this library, not any other — can know what country
 * "5550109" belongs to. Something has to be assumed, and this constant is that
 * assumption made explicit in one place instead of scattered through digit-shape
 * rules. It is **US** by founder ruling (BACKLOG-2774): Keepr is a US-market
 * product, and a domestic form from any other locale keys self-consistently but
 * does not unify with its `+code` twin. BACKLOG-2774 carries the trigger for
 * making it per-user; until then, changing this one value is the whole change.
 *
 * A `+`-prefixed number ignores this entirely — E.164 carries its own country.
 */
export const DEFAULT_PHONE_REGION = "US" as const;

/**
 * The PRE-BACKLOG-2630 lookup rule, transcribed exactly, kept as the fallback
 * for anything the library cannot parse.
 *
 * This is not dead code and it is not a convenience: it is what makes
 * "an unparseable value is never keyed WORSE than it is today" a property that
 * can be checked rather than asserted. Every input that fails
 * `parsePhoneNumberFromString(...).isValid()` — short codes, extensions,
 * alphanumeric senders, fragments, malformed runs — comes out of `toLookupKey`
 * byte-identical to the rule that shipped before the library arrived.
 *
 * Semantics (byte-equivalent to the BACKLOG-1727 writer):
 *   - Strip ALL non-digit characters
 *   - If ≥10 digits remain → keep last 10
 *   - If 1–9 digits → keep all (short-code path)
 *   - If 0 digits (alphanumeric senders like "VERIZON") → return trimmed original
 */
export function legacyDigitKey(trimmed: string): string {
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

/**
 * Normalize a phone number to its JOIN/lookup key — the value stored in
 * `contact_phones.phone_normalized`, `external_contacts.phones_normalized_json`
 * and `phone_last_message.phone_normalized`.
 *
 * ===========================================================================
 * BACKLOG-2630 slice 1 — libphonenumber-js, default region US
 * ===========================================================================
 * The old rule was `digits.slice(-10)`. It had two defects that BACKLOG-2635
 * measured on a real address book: a number stored without its country code
 * could never meet the same number stored with one, and `slice(-10)` amputated
 * long country codes into keys that correspond to no real number
 * (an 11-digit international number lost its country code and came out as a
 * plausible-looking 10-digit NANP number, which could collide with a real
 * one).
 *
 * The first attempt at a fix hand-wrote digit-shape rules per country and was
 * dropped by the founder — *"overfitting for one number format without knowing
 * if it can cause issues is more risk than help."* A hand rule declared any
 * 9-digit leading-0 number, in any user's book, forever, to be Israeli. In an
 * audit product a wrong key is how a text thread attaches to the wrong human.
 *
 * So the country knowledge is the library's, and there is none of ours:
 *
 *   1. Parse with `DEFAULT_PHONE_REGION` for numbers lacking a `+`.
 *   2. Accept the answer ONLY when `isValid()`.
 *   3. Otherwise fall back to `legacyDigitKey` — today's behaviour, unchanged.
 *
 * **Why `isValid()` and not `isPossible()`.** Measured on libphonenumber-js
 * 1.13.11: `parsePhoneNumberFromString("0525550123", "US")` reports
 * `isPossible() === true` and `isValid() === false`. Gating on possibility
 * would key that value as `+1 052…` — the same "invent a country for a
 * domestic form" move that got the hand-rolled attempt dropped, merely
 * outsourced. Gating on validity sends it to the fallback, where it keeps the
 * key it has today and asserts nothing about where it is from.
 *
 * The key is the E.164 DIGITS, without the leading `+`. The column is compared
 * with `LIKE` needles built from the same function and is `IN`-matched against
 * digit strings; a `+` in the stored value would be decoration on one side of
 * comparisons that never carry it on the other.
 *
 * @example
 * toLookupKey("+1 (415) 555-0109")  // "14155550109"
 * toLookupKey("(415) 555-0109")     // "14155550109"  ← same key, no country code typed
 * toLookupKey("+44 20 7946 0958")   // "442079460958" ← country code kept, not amputated
 * toLookupKey("020794609")          // "020794609"    ← invented into no country
 * toLookupKey("12345")              // "12345"        ← short code, untouched
 * toLookupKey("VERIZON")            // "VERIZON"
 * toLookupKey(null)                 // ""
 */
export function toLookupKey(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_PHONE_REGION);
  if (parsed && parsed.isValid()) {
    // `.number` is E.164 ("+14155550109"); the stored key drops the "+".
    return parsed.number.slice(1);
  }

  return legacyDigitKey(trimmed);
}

/**
 * Below this many digits, a phone value is not evidence that two records are
 * the same person.
 *
 * Founder, 13 Aug: *"it probably has to be 6 or 7 or more digits, nothing
 * less"* — resolved to **7**, a local number without its area code. Below that
 * you are matching on extensions ("4021"), typos ("11") and fragments, and two
 * unrelated contacts carrying the same extension get proposed as duplicates.
 * That is a FALSE POSITIVE, and in a review queue whose whole value is that
 * every question is worth answering, a false positive costs more than a miss.
 */
export const MATCHING_DIGIT_FLOOR = 7;

/**
 * The key used to emit a MATCH CANDIDATE. `""` means "this value may not be
 * used to match" — not "no match found".
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE FUNCTION AND NOT A BRANCH INSIDE `toLookupKey`
 * ===========================================================================
 * BACKLOG-2754. The founder's floor decision says such values are "never used
 * for **matching**", and matching is a different layer from storage. Putting
 * the floor in `toLookupKey` — the obvious-looking place — breaks two shipped
 * behaviours:
 *
 *   1. **It drops short codes from `phone_last_message`, undoing BACKLOG-1493.**
 *      That table is keyed BY the lookup key, and a 5-digit short code is a
 *      legitimate row in it.
 *   2. **It turns the contact search needle into `'%%'`.** `contactDbService`
 *      builds `` `%${toLookupKey(query)}%` ``, so an empty key makes a 3-to-6
 *      digit query match EVERY row on file — a silent, total false positive in
 *      the one surface where the user is actively looking for one person.
 *
 * A below-floor value therefore stays exactly as it is today: stored,
 * searchable, displayable, de-duplicable. It is only barred from the
 * candidate sets that ask "are these two records the same person?".
 *
 * The floor counts the digits of the RAW value, not of the resulting key, so
 * the verdict does not depend on whether the library happened to parse it.
 *
 * @example
 * toMatchingKey("(415) 555-0109")  // "14155550109"
 * toMatchingKey("555-0109")        // "5550109"   (exactly 7 digits — at the floor)
 * toMatchingKey("555010")          // ""          (6 digits — below the floor)
 * toMatchingKey("4021")            // ""          (an extension is not a person)
 * toMatchingKey("VERIZON")         // ""          (no digits at all)
 */
export function toMatchingKey(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  const digitCount = (trimmed.match(/\d/g) || []).length;
  if (digitCount < MATCHING_DIGIT_FLOOR) return "";

  return toLookupKey(trimmed);
}

// ---------------------------------------------------------------------------
// Phone helpers (preserved from earlier modules; widely used across services)
// ---------------------------------------------------------------------------

/**
 * Check if two phone numbers match (after normalization).
 *
 * Uses last-10-digits semantics (matching the historical `phoneUtils`
 * implementation) — safer for international numbers than E.164-suffix
 * comparison. Falsy inputs always return false.
 *
 * @example
 * phoneNumbersMatch("(555) 555-0112", "5555550112")     // true
 * phoneNumbersMatch("+44 20 7946 0958", "2079460958")    // true
 * phoneNumbersMatch("5555550112", "5555550121")          // false
 */
export function phoneNumbersMatch(
  phone1: string | null | undefined,
  phone2: string | null | undefined,
): boolean {
  const normalized1 = toE164(phone1);
  const normalized2 = toE164(phone2);

  if (!normalized1 || !normalized2) return false;

  // Exact match after E.164 normalization
  if (normalized1 === normalized2) return true;

  // Fallback: match last 10 digits (handles country-code differences)
  const digits1 = extractDigits(phone1);
  const digits2 = extractDigits(phone2);
  if (digits1.length >= 10 && digits2.length >= 10) {
    return digits1.slice(-10) === digits2.slice(-10);
  }

  return false;
}

/**
 * Heuristic: does this handle look like a phone number (vs. an email)?
 * Returns false for handles containing `@`; otherwise true if the handle
 * contains at least 7 digits.
 */
export function isPhoneNumber(handle: string): boolean {
  if (handle.includes("@")) return false;
  const digitCount = (handle.match(/\d/g) || []).length;
  return digitCount >= 7;
}

/**
 * Extract just the digit characters from a string. Null/undefined → "".
 */
export function extractDigits(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(REGEX_PATTERNS.PHONE_NORMALIZE, "");
}

/** The characters a person actually types when writing a phone number. */
const PHONE_QUERY_CHARS = /^[+()\-.\s\d]+$/;

/**
 * Does this SEARCH QUERY look like someone typing a phone number?
 *
 * ===========================================================================
 * MIRROR PAIR. Renderer copy: `src/utils/phoneNormalization.ts`
 * ===========================================================================
 * BACKLOG-2467. `tsconfig.electron.json` sets `rootDir: "./electron"`, so the
 * main process cannot import the renderer copy (same constraint that produced
 * the two copies of `formatPhoneNumber` above and of `contactDisplayLabel`).
 * The two are held together by
 * `src/utils/__tests__/contactDisplayLabel.parity.test.ts`, which loads both and
 * asserts an identical verdict for every case — a query that the picker's
 * client-side matcher treats as a phone number and the SQL search does not (or
 * vice versa) is precisely how the two surfaces diverged in the first place.
 *
 * Read the renderer copy for the full reasoning. In short: no letters, at least
 * 3 digits. The letter rule keeps a company called "415 Realty" on the name
 * path; the 3-digit floor rejects "+", "()" and a bare "1", a needle that would
 * substring-match nearly every number on file.
 *
 * Gates the NORMALISED phone comparison ONLY — every caller keeps its plain
 * substring pass unconditionally, so this can never remove a match that works
 * today.
 */
export function looksLikePhoneQuery(query: string | null | undefined): boolean {
  const trimmed = (query || "").trim();
  if (!trimmed) return false;
  if (!PHONE_QUERY_CHARS.test(trimmed)) return false;
  return extractDigits(trimmed).length >= 3;
}

/**
 * Return the last N digits of a phone number (default 10). Useful for fuzzy
 * matching across country-code variations.
 */
export function getTrailingDigits(phone: string, count: number = 10): string {
  const digits = extractDigits(phone);
  return digits.slice(-count);
}

/**
 * Format a phone number for human display.
 * - Emails are returned unchanged (no lowercasing — display path).
 * - 11-digit US with leading 1 → "+1 (XXX) XXX-XXXX"
 * - 10-digit US → "(XXX) XXX-XXXX"
 * - 7-digit local → "XXX-XXXX"
 * - International (input carried a leading "+") → "+<digits>", country code kept.
 * - Otherwise returns the cleaned digit string, or the original if cleaning
 *   yields empty.
 *
 * BACKLOG-2461: the international branch did not exist. `PHONE_NORMALIZE` is
 * `/\D/g`, which strips the "+" along with the punctuation, so every non-US
 * number missed all three US shapes and fell out as a bare digit run —
 * "+50664103686" (Costa Rica, real data) became "50664103686", which is not
 * dialable and reads as a serial number.
 *
 * That matters more now than it did: this string can BE a contact's label.
 * `contactDisplayLabel` falls back to the phone when a contact has no name, so
 * a mangled number would be printed into the compliance PDF as a party's
 * identity.
 *
 * Digits are deliberately NOT regrouped for international numbers. Grouping
 * varies by country and guessing it wrongly misrepresents the number; doing it
 * correctly needs a full libphonenumber metadata set. Keeping "+" and the
 * digits leaves the number faithful and dialable, which is the property that
 * matters here. US shapes are unchanged — asserted by test, so no existing
 * caller shifts.
 */
export function formatPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return "";
  if (phone.includes("@")) return phone;

  const cleaned = extractDigits(phone);

  if (cleaned.length === 11 && cleaned[0] === "1") {
    return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  } else if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  } else if (cleaned.length === 7) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
  }
  // Only re-attach "+" when the caller supplied one. Inventing a country code
  // for a bare digit run would assert something we were never told.
  if (cleaned && phone.trim().startsWith("+")) {
    return `+${cleaned}`;
  }
  return cleaned || phone;
}
