/**
 * Admin-consent block detection (BACKLOG-2007)
 *
 * When a user on an organization-managed Microsoft 365 tenant tries to connect
 * their mailbox during onboarding, the tenant admin may not have granted
 * consent for Keepr. Microsoft Entra ID (Azure AD) returns an AADSTS error in
 * the OAuth redirect (`error`/`error_description`), which our local redirect
 * server surfaces as a rejected code promise — landing in the mailbox-connect
 * handler's catch as a plain error string.
 *
 * This module classifies those errors so the UI can show a targeted
 * "Request IT approval" flow instead of a generic failure the user cannot act
 * on.
 *
 * IMPORTANT: this is DISTINCT from token-expiry classification
 * (`emailSyncService.isTokenExpiryError`), which matches ANY `aadsts\d+`. Admin
 * consent must be detected by its SPECIFIC codes so a plain expired-token
 * error is never mislabelled as an admin-consent block (and vice-versa).
 *
 * @module utils/adminConsent
 */

/**
 * AADSTS codes that specifically indicate the org/tenant administrator must
 * grant (or has not granted) consent for the application.
 *
 * - AADSTS65001: The user or administrator has not consented to use the
 *   application. Send an interactive authorization request / admin consent.
 * - AADSTS90094: The grant requires administrator permissions. An admin must
 *   consent on behalf of the organization (classic "admin consent required").
 * - AADSTS90093: Insufficient privileges — the granting account needs admin
 *   rights to consent to the requested scopes.
 *
 * NOTE: AADSTS900971 ("No reply address is registered for the application") is
 * deliberately EXCLUDED — that is a redirect-URI / reply-URL misconfiguration
 * on our app registration, NOT an org admin-consent block. An IT admin cannot
 * resolve it, so routing it to the "Request IT approval" flow would be a dead
 * path. (Filed separately: it belongs to app-registration config, not consent.)
 */
const ADMIN_CONSENT_AADSTS_CODES = [
  "aadsts65001",
  "aadsts90094",
  "aadsts90093",
] as const;

/**
 * Textual fallbacks for admin-consent conditions that may appear without (or
 * alongside) an AADSTS code. Kept narrow to avoid false positives against
 * unrelated errors.
 */
const ADMIN_CONSENT_TEXT_PATTERNS = [
  "admin consent",
  "administrator has not consented",
  "administrator consent",
  "requires admin",
  "admin approval",
  "consent_required",
  "admin_consent_required",
] as const;

/**
 * Extract a lowercase message string from an unknown error shape.
 */
function toLowerMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (error as { message?: string })?.message ?? "";
  return message.toLowerCase();
}

/**
 * Returns true if the given error indicates an organization admin-consent block
 * (the tenant administrator must approve the application before the user can
 * connect their mailbox).
 *
 * Only matches the SPECIFIC admin-consent AADSTS codes and narrow textual
 * patterns — a generic expired-token AADSTS error (e.g. AADSTS50173,
 * AADSTS700082) will NOT match.
 *
 * @param error - An Error, string, or object with a `message` field.
 */
export function isAdminConsentError(error: unknown): boolean {
  const lower = toLowerMessage(error);
  if (!lower) return false;

  if (ADMIN_CONSENT_AADSTS_CODES.some((code) => lower.includes(code))) {
    return true;
  }

  return ADMIN_CONSENT_TEXT_PATTERNS.some((pattern) => lower.includes(pattern));
}
