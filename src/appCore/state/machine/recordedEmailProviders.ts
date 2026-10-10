/**
 * Recorded email providers (BACKLOG-3888) — renderer side.
 *
 * Main records every mailbox provider an account has ever connected in the
 * cloud preferences bag as `preferences.emailProviders` (a deduplicated set,
 * e.g. ["outlook"] or ["outlook", "gmail"]; see
 * electron/services/emailProviderRecord.ts). It is never cleared on
 * disconnect, so it answers "did this user choose email?" on any computer.
 *
 * @module appCore/state/machine/recordedEmailProviders
 */

/** The preferences key. Mirrors EMAIL_PROVIDERS_PREFERENCE_KEY in main. */
export const EMAIL_PROVIDERS_PREFERENCE_KEY = "emailProviders";

/**
 * True when a `preferences:get` result records at least one email provider.
 * Anything malformed, absent or failed reads as false (no record).
 */
export function hasRecordedEmailProviderIn(prefsResult: unknown): boolean {
  if (!prefsResult || typeof prefsResult !== "object") return false;
  const preferences = (prefsResult as { preferences?: unknown }).preferences;
  if (!preferences || typeof preferences !== "object") return false;
  const value = (preferences as Record<string, unknown>)[EMAIL_PROVIDERS_PREFERENCE_KEY];
  return (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string" && entry.length > 0)
  );
}
