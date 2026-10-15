/**
 * Recorded email providers (BACKLOG-3888) — renderer side.
 *
 * Main records every mailbox provider an account has ever connected in the
 * cloud preferences bag as `preferences.emailProviders` (a deduplicated set,
 * e.g. ["outlook"] or ["outlook", "gmail"]; see
 * electron/services/emailProviderRecord.ts). It is never cleared on
 * disconnect, so it answers "did this user choose email?" on any computer.
 *
 * It reaches the renderer through `user:get-account-setup`
 * (accountSetupHandlers.ts), which reads the same bag under the 8 s timeout.
 *
 * @module appCore/state/machine/recordedEmailProviders
 */

/** The preferences key. Mirrors EMAIL_PROVIDERS_PREFERENCE_KEY in main. */
export const EMAIL_PROVIDERS_PREFERENCE_KEY = "emailProviders";

/**
 * True when `value` (the `emailProviders` field of the account-setup read)
 * records at least one provider. Anything malformed or absent reads as false.
 */
export function hasRecordedEmailProvider(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string" && entry.length > 0)
  );
}
