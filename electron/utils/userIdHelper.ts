/**
 * User ID Helper Utility
 * BACKLOG-551: Provides robust user ID validation against the local database
 *
 * Problem: The renderer may pass a user ID from Supabase auth (auth.uid()) that
 * doesn't match what's in the local users_local table. This causes FK constraint
 * failures when inserting into tables with user_id foreign keys.
 *
 * Solution: Always validate the user ID exists in the local database before use.
 * For single-user apps, fall back to looking up any user in users_local.
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
 * This function handles cases where:
 * 1. The renderer passes an invalid/stale userId
 * 2. The renderer passes no userId (legacy bridge compatibility)
 * 3. The Supabase auth.uid() doesn't match local users_local.id
 *
 * @param providedUserId - User ID from the renderer (may be invalid)
 * @param context - Context string for logging (e.g., "MicrosoftAuth", "GoogleAuth")
 * @returns Valid user ID if found, null if no user exists in database
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
    logService.warn(
      `[${context}] Provided userId not found in local DB, looking up correct ID`,
      context,
      { providedId: providedUserId.substring(0, 8) + "..." },
    );
  }

  // Look up any user in the database (single-user app fallback)
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
    logService.warn(
      `[${context}] Provided userId not found in local DB, looking up correct ID`,
      context,
      { providedId: providedUserId.substring(0, 8) + "..." },
    );
  }

  // Look up any user in the database (single-user app fallback)
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
