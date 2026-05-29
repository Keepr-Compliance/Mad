/**
 * Phone Lookup Key Normalization (BACKLOG-1727)
 *
 * Canonical normalization used by `phone_last_message.phone_normalized`,
 * `contact_phones.phone_normalized`, and `external_contacts.phones_normalized_json`
 * so writer and reader sites agree on JOIN keys.
 *
 * Snapshot of the historical writer in `messageDbService.backfillPhoneLastMessageTable`:
 *  - Strip ALL non-digit characters
 *  - If 10+ digits remain, keep last 10 (country-code-agnostic match)
 *  - If 1-9 digits, keep all digits (preserve short codes)
 *  - If 0 digits (alphanumeric senders like "VERIZON"), return the trimmed original
 *  - Empty / null / whitespace input returns empty string
 *
 * Other phone utilities (`phoneUtils.normalizePhoneNumber`,
 * `phoneNormalization.normalizePhoneNumber`) produce a `+15551234567` E.164-ish
 * format used for display and contact resolution — this helper intentionally
 * differs because the lookup table predates that format.
 */
export function normalizePhoneLookupKey(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}
