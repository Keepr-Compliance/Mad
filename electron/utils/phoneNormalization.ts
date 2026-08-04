/**
 * Phone Number Normalization Utilities (consolidated module — BACKLOG-1729)
 *
 * Single source of truth for phone normalization across the Electron main process.
 * Replaces:
 *   - electron/utils/phoneUtils.ts (deleted)
 *   - electron/utils/phoneLookupKey.ts (reduced to 1-line shim — see migration v40 immutability note)
 *
 * Two canonical functions:
 *   - `toE164(raw)` → "+15551234567" form (used for display / contact storage / matching)
 *   - `toLookupKey(raw)` → "5551234567" (last 10 digits) (used as JOIN key against
 *     `phone_last_message.phone_normalized` / `contact_phones.phone_normalized` /
 *     `external_contacts.phones_normalized_json`)
 *
 * Output semantics for `toLookupKey` MUST stay byte-equivalent to the
 * pre-consolidation `normalizePhoneLookupKey` because production databases
 * are backfilled by migration v40 using that function.
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
 * toE164("(555) 123-4567")        // "+15551234567"
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
 * Normalize a phone number to its JOIN/lookup key — the byte-equivalent of the
 * BACKLOG-1727 writer in `messageDbService.backfillPhoneLastMessageTable`.
 *
 * Semantics (MUST stay stable — migration v40 backfilled with these):
 *   - Strip ALL non-digit characters
 *   - If ≥10 digits remain → keep last 10 (country-code-agnostic match)
 *   - If 1–9 digits → keep all (short-code path)
 *   - If 0 digits (alphanumeric senders like "VERIZON") → return trimmed original
 *   - Null / undefined / empty / whitespace-only input → `""`
 *
 * @example
 * toLookupKey("+1 (415) 555-1234")  // "4155551234"
 * toLookupKey("+44 20 7946 0958")    // "2079460958"
 * toLookupKey("12345")               // "12345"
 * toLookupKey("VERIZON")             // "VERIZON"
 * toLookupKey(null)                  // ""
 */
export function toLookupKey(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;
  if (digits.length >= 10) return digits.slice(-10);
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
 * phoneNumbersMatch("(555) 123-4567", "5551234567")     // true
 * phoneNumbersMatch("+44 20 7946 0958", "2079460958")    // true
 * phoneNumbersMatch("5551234567", "5559876543")          // false
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
