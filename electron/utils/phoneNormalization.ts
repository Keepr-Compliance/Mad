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
 * - Otherwise returns the cleaned digit string, or the original if cleaning
 *   yields empty.
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
  return cleaned || phone;
}
