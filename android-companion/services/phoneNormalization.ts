/**
 * Phone Number Normalization (Android Companion)
 * Normalizes raw phone numbers to a consistent format for matching.
 *
 * TASK-1430: SMS BroadcastReceiver + background sync service
 * BACKLOG-1493/1495: Data parsing specification
 *
 * The Electron desktop side (messageMatchingService.ts) does its own
 * normalization, so we aim for a best-effort E.164-ish format here.
 *
 * ## Phone Number Categories (BACKLOG-1495 Data Parsing Spec)
 *
 * 1. International format: "+1..." or "+44..." — kept as +digits
 * 2. US/Canada 10-digit: "5555550112" — normalized to "+15555550112"
 * 3. US/Canada 11-digit: "15555550112" — normalized to "+15555550112"
 * 4. Short codes (5-6 digits): "72645", "227263" — returned as-is (digits only)
 *    These are carrier/marketing SMS short codes and must NOT be filtered out.
 * 5. Alphanumeric senders: "T-Mobile", "BANK OF AMERICA" — returned as-is (trimmed)
 *    These are carrier alerts, marketing, or service messages with non-numeric senders.
 *    Stripping non-digits would produce empty string, hiding these messages entirely.
 */

/**
 * Normalize a phone number to a consistent format.
 *
 * - For numeric phone numbers: strips formatting, adds country code
 * - For alphanumeric senders (carrier names, service IDs): returns trimmed original
 * - For short codes (< 7 digits): returns digits as-is (no country code)
 *
 * @param raw - The raw phone number or sender string from Android SMS content provider
 * @returns Normalized sender string — never empty for non-empty input
 */
export function normalizePhoneNumber(raw: string): string {
  if (!raw || raw.trim().length === 0) {
    return raw;
  }

  const trimmed = raw.trim();

  // Strip everything except digits to check if this is a numeric sender
  const digits = trimmed.replace(/\D/g, "");

  // BACKLOG-1493: If stripping non-digits produces empty string, this is an
  // alphanumeric sender (e.g., "T-Mobile", "BANK OF AMERICA", "MyService").
  // Return the trimmed original to preserve the sender identity.
  if (digits.length === 0) {
    return trimmed;
  }

  // BACKLOG-1493: Short codes (typically 5-6 digits) — return digits only.
  // These are carrier/marketing SMS codes and must be preserved, not filtered.
  // We treat anything with fewer than 7 digits as a short code.
  if (digits.length < 7) {
    return digits;
  }

  // Check if it starts with + (international format)
  const hasPlus = trimmed.startsWith("+");

  // Already has country code with + prefix
  if (hasPlus) {
    return `+${digits}`;
  }

  // 11 digits starting with 1 — US/Canada with country code but no +
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  // 10 digits — assume US/Canada, prepend +1
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // 7 digits — local number, cannot reliably add country code
  if (digits.length === 7) {
    return digits;
  }

  // For anything else (international numbers without +), return with +
  // This handles cases like "44xxxxxxxxxx" (UK) etc.
  if (digits.length > 10) {
    return `+${digits}`;
  }

  // Fallback — return digits only
  return digits;
}
