/**
 * Phone Number Normalization Utilities (consolidated module — BACKLOG-1729)
 *
 * Single source of truth for phone normalization across the Electron main process.
 * Replaces:
 *   - electron/utils/phoneUtils.ts (deleted)
 *   - electron/utils/phoneLookupKey.ts (reduced to 1-line shim — see migration v40 immutability note)
 *
 * Two canonical functions:
 *   - `toE164(raw)` → "+15555550112" form (used for display / contact storage / matching)
 *   - `toLookupKey(raw)` → "5555550112" (used as JOIN key against
 *     `phone_last_message.phone_normalized` / `contact_phones.phone_normalized` /
 *     `external_contacts.phones_normalized_json`)
 *
 * BACKLOG-2635 SUPERSEDED the "byte-equivalent to migration v40" rule that
 * used to live here. The v40 rule (≥10 digits → last 10, under 10 → kept
 * whole) had two defects: a number stored without its country code could
 * never key-match the same number stored with one, and slice(-10) mangled
 * 11+-digit international numbers into keys of no real number. The key is
 * still byte-identical to v40 for 10-digit national numbers, 11-digit
 * NANP ("1…"), short codes and alphanumeric senders — the overwhelming
 * majority of every store — but Israeli national forms and CC-included
 * international forms now key differently, so rows PERSISTED under the old
 * rule need a re-key migration (scoped on the BACKLOG-2635 PR; v40 itself is
 * immutable and now floats on this helper for fresh upgrade paths).
 *
 * Behavioural changes adopted during consolidation (see PR description for audit):
 *   - `toE164("")` returns `""` (not `"+"` as the old phoneNormalization version did).
 *     The phoneUtils branch already had this guard; the bug was latent (no caller
 *     keyed off the `"+"` sentinel).
 */

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
 * The national-number conventions `toLookupKey` understands (BACKLOG-2635).
 *
 * The founder's book is US + Israeli, and the two regions' national shapes are
 * DISJOINT — a NANP number never begins with 0, an Israeli national form
 * always does — so both can be recognized at once without a per-call region
 * hint. The parameter exists so a caller with better knowledge can narrow the
 * assumption; every production caller uses the default.
 */
export type PhoneRegion = "US" | "IL";

/** The default-region assumption, explicit and overridable per call. */
export const DEFAULT_PHONE_REGIONS: readonly PhoneRegion[] = ["US", "IL"];

/**
 * Normalize a phone number to its JOIN/lookup key.
 *
 * BACKLOG-2635 REPLACED the v40 rule (≥10 digits → slice(-10), under 10 →
 * kept whole). That rule had two defects, both live in the founder's book
 * (61 values, 4.8%):
 *   1. A number stored domestically ("03-555-0121" → "035550121") and the
 *      same number stored E.164 ("+972 3 555 0121" → "7235550121") produced
 *      different keys — never linked, never flagged.
 *   2. slice(-10) dropped long country codes, so the E.164 key above was a
 *      fabrication that COLLIDED with the genuine NANP (723) 555-0121.
 *
 * The key is now a function of the DIGIT STRING alone (a "+" carries no
 * information the digits do not), which is what keeps the BACKLOG-2620
 * invariant `toLookupKey(formatPhoneNumber(p)) === toLookupKey(p)` true:
 * formatPhoneNumber never adds, drops or reorders digits. It is idempotent
 * (`toLookupKey(toLookupKey(x)) === toLookupKey(x)`) — stores re-normalize
 * already-normalized keys — and it agrees with the write path, which keys
 * from `phone_e164` while the matchers key from the raw string:
 * `toLookupKey(toE164(x)) === toLookupKey(x)` for every digit-bearing input.
 *
 * Semantics, by digit count after stripping non-digits:
 *   - 0 digits (alphanumeric senders like "VERIZON") → trimmed original;
 *     null / undefined / empty / whitespace-only → `""`        [unchanged]
 *   - 1–8 digits → kept whole (short codes, partials)          [unchanged]
 *   - 9 digits leading 0 → "972" + rest (IL national landline: trunk 0 +
 *     area + subscriber — keys with the "+972…" form)          [BACKLOG-2635]
 *   - 10 digits leading 05/07 → "972" + rest (IL mobile / VoIP)[BACKLOG-2635]
 *   - other 10-digit → kept whole (the NANP national population —
 *     byte-identical to the v40 backfill)                      [unchanged]
 *   - 11 digits leading 1 → the NANP country code is stripped and the
 *     remainder RE-interpreted — for a real US number that is the same last-10
 *     key as v40; for "+10525550123" (toE164 prepends "1" to ANY 10-digit
 *     input, including Israeli mobiles) the remainder takes the IL reading
 *   - other 11+ digits → kept whole, country code included     [BACKLOG-2635]
 *   - international exit prefixes "011" (NANP, ≥13 digits) and "00"
 *     (ITU, ≥12 digits) are stripped and the remainder re-read, so a number
 *     dialed "011 972 …" keys with its "+972 …" form
 *
 * A 7-digit local ("555-0121") stays AMBIGUOUS-NOT-EQUAL to any full form:
 * its area code is not in the input, and suffix-matching is forbidden (the
 * item's own rule — a shared 7-digit suffix across area codes is common).
 * Surfacing those as questions is BACKLOG-2630's job.
 *
 * PERSISTENCE: `contact_phones.phone_normalized`,
 * `external_contacts.phones_normalized_json` and `phone_last_message` hold
 * keys built with the OLD rule until the re-key migration scoped on the
 * BACKLOG-2635 PR lands. Fresh v40 upgrades backfill through this function
 * and get the new keys.
 *
 * @example
 * toLookupKey("+1 (415) 555-0109")  // "4155550109"
 * toLookupKey("03-555-0121")         // "97235550121"  (== toLookupKey("+972 3 555 0121"))
 * toLookupKey("+44 20 7946 0958")    // "442079460958" (country code kept)
 * toLookupKey("12345")               // "12345"
 * toLookupKey("VERIZON")             // "VERIZON"
 * toLookupKey(null)                  // ""
 */
export function toLookupKey(raw: string | null | undefined): string {
  return toLookupKeyForRegions(raw, DEFAULT_PHONE_REGIONS);
}

/**
 * `toLookupKey` with the region assumption overridden.
 *
 * A SEPARATE export rather than an optional second parameter on purpose:
 * `toLookupKey` is used as a bare callback (`phones.map(toLookupKey)`), and an
 * optional `regions` parameter would silently receive Array.map's INDEX — the
 * `map(parseInt)` trap. Keeping the canonical function unary makes that call
 * shape safe forever; callers with better region knowledge name their intent.
 */
export function toLookupKeyForRegions(
  raw: string | null | undefined,
  regions: readonly PhoneRegion[],
): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;
  return keyFromDigits(digits, regions);
}

/** The digit-shape rule behind `toLookupKey`. Recursion is bounded: every
 *  recursive call strictly shortens the string. */
function keyFromDigits(digits: string, regions: readonly PhoneRegion[]): string {
  // International exit prefixes fold onto the "+" form: "011 972 …" and
  // "00 972 …" must key like "+972 …". The length floors keep short runs
  // (which cannot be exit-prefixed full numbers) out of the strip.
  if (digits.length >= 13 && digits.startsWith("011")) {
    return keyFromDigits(digits.slice(3), regions);
  }
  if (digits.length >= 12 && digits.startsWith("00")) {
    return keyFromDigits(digits.slice(2), regions);
  }

  // NANP: country code "1" + 10-digit national number. The remainder is
  // RE-interpreted rather than returned, because toE164 prepends "1" to ANY
  // 10-digit input — "+10525550123" is an Israeli mobile wearing a US coat,
  // and its key must still reach the IL reading below.
  if (regions.includes("US") && digits.length === 11 && digits.startsWith("1")) {
    return keyFromDigits(digits.slice(1), regions);
  }

  // Israeli national forms: trunk "0" + subscriber. Disjoint from NANP, which
  // never begins with 0. Dropping the trunk and prepending the country code
  // lands on the same key as the E.164 form.
  if (regions.includes("IL")) {
    if (digits.length === 9 && digits.startsWith("0")) {
      return "972" + digits.slice(1);
    }
    if (digits.length === 10 && (digits.startsWith("05") || digits.startsWith("07"))) {
      return "972" + digits.slice(1);
    }
  }

  // Everything else keys as its full digit string: 10-digit NANP nationals
  // (byte-identical to v40), short codes, and CC-included international runs
  // (previously mangled by slice(-10)).
  return digits;
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
