/**
 * Session Database Service
 * Handles all session-related database operations
 */

import crypto from "crypto";
import type { Session, User } from "../../types";
import { dbGet, dbRun } from "./core/dbConnection";
import logService from "../logService";

/**
 * Create a new session for a user
 */
export async function createSession(userId: string): Promise<string> {
  const id = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();

  // Sessions expire after 24 hours (security hardened)
  const expiresAt = new Date();
  expiresAt.setTime(expiresAt.getTime() + 24 * 60 * 60 * 1000);

  const sql = `
    INSERT INTO sessions (id, user_id, session_token, expires_at)
    VALUES (?, ?, ?, ?)
  `;

  dbRun(sql, [id, userId, sessionToken, expiresAt.toISOString()]);
  return sessionToken;
}

/**
 * Validate a session token
 */
export async function validateSession(
  sessionToken: string,
): Promise<(Session & User) | null> {
  // BACKLOG-2132: `sessions` and `users_local` collide on `id`, `created_at`,
  // and `updated_at`. A `SELECT s.*, u.*` flattens to one object keyed by
  // column name, so the LATER projection (`u.*`) silently overwrites the
  // session's own `id`/`created_at`. That fed the account-creation date into
  // the 24h age check and logged every returning user out on each login.
  //
  // Project `u.*` first, then expose the session's own columns under distinct
  // aliases so they cannot be clobbered, and remap them back onto the
  // `Session & User` contract before returning (callers are unchanged).
  const sql = `
    SELECT
      u.*,
      s.id               AS session_id,
      s.session_token    AS session_token,
      s.expires_at       AS expires_at,
      s.created_at       AS session_created_at,
      s.last_accessed_at AS session_last_accessed_at,
      s.user_id          AS user_id
    FROM sessions s
    JOIN users_local u ON s.user_id = u.id
    WHERE s.session_token = ?
  `;

  const row = dbGet<
    (Session & User) & {
      session_id: string;
      session_created_at: string;
      session_last_accessed_at: string;
    }
  >(sql, [sessionToken]);

  if (!row) {
    return null;
  }

  // Check if expired
  const expiresAt = new Date(row.expires_at);
  if (expiresAt < new Date()) {
    await deleteSession(sessionToken);
    return null;
  }

  // Update last accessed time
  dbRun(
    "UPDATE sessions SET last_accessed_at = CURRENT_TIMESTAMP WHERE session_token = ?",
    [sessionToken],
  );

  // Map the aliased session columns back onto the Session & User contract so
  // `id`/`created_at`/`last_accessed_at` reflect the SESSION row, not the
  // account. Strip the alias helper keys from the returned object.
  const {
    session_id,
    session_created_at,
    session_last_accessed_at,
    ...rest
  } = row;

  return {
    ...rest,
    id: session_id,
    created_at: session_created_at,
    last_accessed_at: session_last_accessed_at,
  };
}

/**
 * Delete a session (logout)
 */
export async function deleteSession(sessionToken: string): Promise<void> {
  const sql = "DELETE FROM sessions WHERE session_token = ?";
  dbRun(sql, [sessionToken]);
}

/**
 * Delete all sessions for a user
 */
export async function deleteAllUserSessions(userId: string): Promise<void> {
  const sql = "DELETE FROM sessions WHERE user_id = ?";
  dbRun(sql, [userId]);
}

/**
 * Clear all sessions (for session-only OAuth on app startup)
 * This forces all users to re-authenticate each app launch
 */
export async function clearAllSessions(): Promise<void> {
  const sql = "DELETE FROM sessions";
  dbRun(sql, []);
  logService.info("[SessionDbService] Cleared all sessions for session-only OAuth", "SessionDbService");
}
