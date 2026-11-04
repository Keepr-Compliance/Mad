/**
 * BACKLOG-2824: a local copy of the user's cloud preferences bag.
 *
 * The bag lives in Supabase (`user_preferences`). Without a local copy every
 * offline launch fails the `preferences:get` read. This module keeps the last
 * bag the cloud returned (or accepted) inside the encrypted session file, and
 * hands it back when the cloud cannot be read.
 *
 * Rules:
 * - Written only after a successful cloud read or a successful cloud save
 *   (supabaseService.getPreferences / syncPreferences). A failed read never
 *   writes. The cloud wins on every successful read: the copy is replaced,
 *   never merged.
 * - Stored verbatim. Nothing here fills in a default or normalises a value;
 *   readers apply their own rules (BACKLOG-3418, BACKLOG-3749) as they do for
 *   the cloud bag. An empty bag `{}` is a real answer and is copied too.
 * - Served only by the `preferences:get` handler. supabaseService.getPreferences
 *   still throws when the cloud read fails.
 * - A copy that does not parse, or belongs to another user id, is treated as
 *   no copy.
 * - Session-file based (as the BACKLOG-3673 account-setup cache), so it is
 *   readable before the local database is open and is cleared on sign-out.
 */

import sessionService, { type PreferencesCopy } from "./sessionService";
import logService from "./logService";

const MODULE = "Preferences";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Key of the last copy handed to the session file: session generation, user id
 * and the serialized bag. Set BEFORE the write so the many reads that run at
 * launch do not each queue a session-file write for the same bag.
 */
let lastWrittenKey: string | null = null;

/**
 * Store `preferences` as the copy for `userId`. Skipped (resolves false) unless
 * `userId` is the signed-in Supabase user. Skipped (resolves true) when the same
 * bag was already written into this session file. Never throws or rejects.
 *
 * Everything before the session write runs synchronously, so copies reach the
 * session file's write queue in the order this is called.
 */
export function writePreferencesCopy(
  userId: string,
  preferences: unknown,
  authUserId: string | null,
): Promise<boolean> {
  try {
    if (!userId || authUserId !== userId || !isPlainObject(preferences)) {
      return Promise.resolve(false);
    }
    const json = JSON.stringify(preferences);
    const key = `${sessionService.getGeneration()}\u0000${userId}\u0000${json}`;
    if (key === lastWrittenKey) return Promise.resolve(true);
    lastWrittenKey = key;

    const copy: PreferencesCopy = {
      userId,
      preferences: JSON.parse(json) as Record<string, unknown>,
      copiedAt: new Date().toISOString(),
    };
    return sessionService.updateSession({ preferencesCopy: copy }).then(
      (ok) => {
        // No session yet (sign-in still running) or a failed write: let the
        // next successful read try again.
        if (!ok && lastWrittenKey === key) lastWrittenKey = null;
        return ok;
      },
      (error: unknown) => {
        if (lastWrittenKey === key) lastWrittenKey = null;
        logService.warn("[Preferences] Could not store the local preferences copy", MODULE, {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      },
    );
  } catch (error) {
    logService.warn("[Preferences] Could not store the local preferences copy", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
    return Promise.resolve(false);
  }
}

/**
 * The stored copy for `userId`, or null when there is none, it does not parse,
 * or it belongs to another user. Never throws.
 */
export async function readPreferencesCopy(userId: string): Promise<PreferencesCopy | null> {
  try {
    const session = await sessionService.loadSession();
    const copy: unknown = session?.preferencesCopy;
    if (!isPlainObject(copy)) return null;
    if (typeof copy.userId !== "string" || copy.userId !== userId) return null;
    if (!isPlainObject(copy.preferences)) return null;
    if (typeof copy.copiedAt !== "string" || Number.isNaN(Date.parse(copy.copiedAt))) {
      return null;
    }
    return { userId: copy.userId, preferences: copy.preferences, copiedAt: copy.copiedAt };
  } catch (error) {
    logService.warn("[Preferences] Could not read the local preferences copy", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Tests only. */
export function resetPreferencesCopyMemoForTests(): void {
  lastWrittenKey = null;
}
