/**
 * User ID Helper Utility
 * BACKLOG-551: Provides robust user ID validation against the local database
 *
 * Problem: The renderer may pass a user ID from Supabase auth (auth.uid()) that
 * doesn't match what's in the local users_local table. This causes FK constraint
 * failures when inserting into tables with user_id foreign keys.
 *
 * Solution: Always validate the user ID exists in the local database before use.
 *
 * ===========================================================================
 * BACKLOG-3254 — WHEN AN ID IS SUPPLIED, THE ANSWER IS THAT ID OR NOTHING
 * ===========================================================================
 * If a supplied id is not in `users_local`, both functions return null. They do
 * not resolve to a different id.
 *
 * The discovery lookup below still exists, and now runs ONLY when no id was
 * supplied at all. That path is a live contract, not dead code — see
 * `electron/preload/outlookBridge.ts`, whose channels invoke with no argument.
 * Closing it as well is BACKLOG-3254's follow-up F2, and it needs those
 * channels changed first.
 *
 * Callers: `null` means "no answer", and every call site already branches on
 * it. Do not treat it as "use whoever is there".
 *
 * Usage:
 * - Import getValidUserId from this module
 * - Call it with the provided user ID before any database operations
 * - If it returns null, handle the error (no user in database)
 */

import databaseService from "../services/databaseService";
import { LOCAL_USER_BY_ID_SQL, LOCAL_USER_ID_SQL } from "../services/db/localUserSql";
import logService from "../services/logService";

/**
 * Get a valid user ID that exists in the local database.
 *
 * Two shapes, and they answer differently:
 * 1. An id IS supplied — it is confirmed against `users_local` and returned, or
 *    null. Nothing else is returned.
 * 2. NO id is supplied (legacy bridge compatibility) — the local user is looked
 *    up. Unchanged by BACKLOG-3254; see the file header.
 *
 * @param providedUserId - User ID from the renderer (may be invalid)
 * @param context - Context string for logging (e.g., "MicrosoftAuth", "GoogleAuth")
 * @returns The supplied id once confirmed, the local user's id when none was
 *          supplied, or null
 */
export async function getValidUserId(
  providedUserId?: string,
  context: string = "UserIdHelper",
): Promise<string | null> {
  // If provided, verify it exists in the local database
  if (providedUserId) {
    const user = await databaseService.getUserById(providedUserId);
    if (user) {
      return providedUserId;
    }
    // BACKLOG-3254: this line and the `No user found in database` error below
    // are the whole field diagnosis, and they must stay distinguishable. THIS
    // one means a local user exists and is not the one the caller named. That
    // one means there is no local user at all. Neither costs an extra read.
    logService.warn(
      `[${context}] Provided userId is not present in users_local; returning null`,
      context,
      { providedId: providedUserId.substring(0, 8) + "..." },
    );
    return null;
  }

  // No id was supplied. Look up the local user (legacy bridge compatibility).
  const db = databaseService.getRawDatabase();
  const anyUser = db.prepare(LOCAL_USER_ID_SQL).get() as
    | { id: string }
    | undefined;

  if (anyUser) {
    logService.info(
      `[${context}] Using user ID from database`,
      context,
      { userId: anyUser.id.substring(0, 8) + "..." },
    );
    return anyUser.id;
  }

  logService.error(`[${context}] No user found in database`, context);
  return null;
}

/**
 * Get a valid user ID synchronously.
 * Use this only when async is not possible (e.g., in certain synchronous contexts).
 *
 * @param providedUserId - User ID from the renderer (may be invalid)
 * @param context - Context string for logging
 * @returns Valid user ID if found, null if no user exists or DB not initialized
 */
export function getValidUserIdSync(
  providedUserId?: string,
  context: string = "UserIdHelper",
): string | null {
  // Check if database is initialized
  if (!databaseService.isInitialized()) {
    // Database not initialized yet (early startup, tests)
    // Return the provided ID as-is if it looks like a valid UUID, otherwise null
    if (providedUserId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(providedUserId)) {
      return providedUserId;
    }
    return null;
  }

  const db = databaseService.getRawDatabase();

  // If provided, verify it exists
  if (providedUserId) {
    const user = db
      .prepare(LOCAL_USER_BY_ID_SQL)
      .get(providedUserId) as { id: string } | undefined;
    if (user) {
      return providedUserId;
    }
    // BACKLOG-3254: see the note on the async twin above. Same pair, same
    // reason to keep the two strings apart.
    logService.warn(
      `[${context}] Provided userId is not present in users_local; returning null`,
      context,
      { providedId: providedUserId.substring(0, 8) + "..." },
    );
    return null;
  }

  // No id was supplied. Look up the local user (legacy bridge compatibility).
  const anyUser = db.prepare(LOCAL_USER_ID_SQL).get() as
    | { id: string }
    | undefined;

  if (anyUser) {
    logService.info(
      `[${context}] Using user ID from database`,
      context,
      { userId: anyUser.id.substring(0, 8) + "..." },
    );
    return anyUser.id;
  }

  logService.error(`[${context}] No user found in database`, context);
  return null;
}
