/**
 * Email provider record (BACKLOG-3888)
 *
 * Records, in the cloud user_preferences bag, which mailbox providers a user
 * has ever connected:
 *
 *   preferences.emailProviders = ["outlook"] | ["gmail"] | ["outlook", "gmail"]
 *
 * It is a set: entries are deduplicated and NEVER removed (a disconnect leaves
 * the record in place). The renderer reads it at startup to tell a user who
 * chose email (and has since lost the mailbox — new PC, reset, disconnect)
 * apart from a texts-only user who never chose email.
 *
 * Failure policy: recording must never fail a connect. Every error is caught
 * and logged; the next successful connect recomputes the set and retries.
 *
 * @module services/emailProviderRecord
 */

import supabaseService from "./supabaseService";
import logService from "./logService";

/** The preferences key holding the set. */
export const EMAIL_PROVIDERS_PREFERENCE_KEY = "emailProviders";

/** Values stored in the set. */
export type RecordedEmailProvider = "outlook" | "gmail";

/** Maps the internal OAuth provider name to the recorded value. */
export function toRecordedEmailProvider(
  provider: "google" | "microsoft",
): RecordedEmailProvider {
  return provider === "microsoft" ? "outlook" : "gmail";
}

/**
 * Returns the set with `provider` added. Unknown entries already present are
 * kept as they are; a non-array existing value is treated as empty.
 */
export function addEmailProvider(
  existing: unknown,
  provider: RecordedEmailProvider,
): string[] {
  const current = Array.isArray(existing)
    ? existing.filter((v): v is string => typeof v === "string")
    : [];
  const deduped = Array.from(new Set(current));
  return deduped.includes(provider) ? deduped : [...deduped, provider];
}

/**
 * Adds `provider` to the user's recorded set in the cloud preferences.
 * Never throws. Skips the write when the provider is already recorded.
 *
 * @returns true when the provider is recorded after the call
 */
export async function recordEmailProvider(
  userId: string,
  provider: "google" | "microsoft",
): Promise<boolean> {
  const recorded = toRecordedEmailProvider(provider);
  try {
    const existing = (await supabaseService.getPreferences(userId)) ?? {};
    const before = existing[EMAIL_PROVIDERS_PREFERENCE_KEY];
    const next = addEmailProvider(before, recorded);
    if (
      Array.isArray(before) &&
      before.length === next.length &&
      before.every((v, i) => v === next[i])
    ) {
      return true;
    }
    await supabaseService.syncPreferences(userId, {
      ...existing,
      [EMAIL_PROVIDERS_PREFERENCE_KEY]: next,
    });
    return true;
  } catch (error) {
    await Promise.resolve()
      .then(() =>
        logService.warn(
          "[EmailProviderRecord] Could not record the connected email provider; will retry on the next connect",
          "EmailProviderRecord",
          {
            provider: recorded,
            error: error instanceof Error ? error.message : String(error),
          },
        ),
      )
      // Logging must not turn a swallowed failure into a rejection either.
      .catch(() => undefined);
    return false;
  }
}
