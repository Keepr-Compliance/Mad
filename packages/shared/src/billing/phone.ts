/**
 * Contact phone rule — BACKLOG-4007.
 *
 * Lives in @keepr/shared (BACKLOG-4007 PR-4) so the broker portal and the admin portal use ONE rule.
 *
 * MIRRORS the database function `public._billing_normalize_phone(p text)`. Keep the two identical:
 * anything accepted here must be accepted there, and the other way round.
 *
 *   v := strip every whitespace, '(', ')', '.', '-' from btrim(p)
 *   '^\+[1-9][0-9]{7,14}$'  -> v            (international, E.164)
 *   '^[2-9][0-9]{9}$'       -> '+1' || v    (US/CA, 10 digits)
 *   '^1[2-9][0-9]{9}$'      -> '+' || v     (US/CA with leading 1)
 *   anything else           -> NULL         (rejected)
 */

export const PHONE_ERROR = 'Enter a valid phone number, like (206) 555-0123.';

export function normalizeBillingPhone(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/[\s().-]/g, '');
  if (/^\+[1-9][0-9]{7,14}$/.test(v)) return v;
  if (/^[2-9][0-9]{9}$/.test(v)) return `+1${v}`;
  if (/^1[2-9][0-9]{9}$/.test(v)) return `+${v}`;
  return null;
}

export function isValidBillingPhone(raw: string | null | undefined): boolean {
  return normalizeBillingPhone(raw) !== null;
}

/**
 * Format as the user types: "2065550123" -> "(206) 555-0123", "12065550123" -> "1 (206) 555-0123".
 * Input with a "+", a letter or any other character is returned untouched so validation can see
 * exactly what was typed or pasted.
 */
export function formatBillingPhoneInput(raw: string): string {
  if (!/^[\d\s().-]*$/.test(raw)) return raw;
  let digits = raw.replace(/\D/g, '');
  let prefix = '';
  if (digits.startsWith('1') && digits.length > 1) {
    prefix = '1 ';
    digits = digits.slice(1);
  }
  const a = digits.slice(0, 3);
  const b = digits.slice(3, 6);
  const c = digits.slice(6);
  let out = a;
  if (digits.length > 3) out = `(${a}) ${b}`;
  if (digits.length > 6) out += `-${c}`;
  return prefix + out;
}
