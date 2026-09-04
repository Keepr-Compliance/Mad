/**
 * OAuth Token Database Service
 * Handles all OAuth token-related database operations
 */

import crypto from "crypto";
import type { OAuthToken, OAuthProvider, OAuthPurpose } from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import {
  validateFields,
  type ColumnOf,
  type FieldExpression,
} from "../../utils/sqlFieldWhitelist";
import logService from "../logService";
import { assignmentList } from "./core/columnSql";

/**
 * Save OAuth token (encrypted)
 */
export async function saveOAuthToken(
  userId: string,
  provider: OAuthProvider,
  purpose: OAuthPurpose,
  tokenData: Partial<OAuthToken>,
): Promise<string> {
  const id = crypto.randomUUID();

  const statement = sql`
    INSERT INTO oauth_tokens (
      id, user_id, provider, purpose,
      access_token, refresh_token, token_expires_at, scopes_granted,
      connected_email_address, mailbox_connected, permissions_granted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider, purpose) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at,
      scopes_granted = excluded.scopes_granted,
      connected_email_address = excluded.connected_email_address,
      mailbox_connected = excluded.mailbox_connected,
      permissions_granted_at = excluded.permissions_granted_at,
      is_active = 1,
      token_last_refreshed_at = CURRENT_TIMESTAMP
  `;

  const params = [
    id,
    userId,
    provider,
    purpose,
    tokenData.access_token || null,
    tokenData.refresh_token || null,
    tokenData.token_expires_at || null,
    tokenData.scopes_granted ? JSON.stringify(tokenData.scopes_granted) : null,
    tokenData.connected_email_address || null,
    tokenData.mailbox_connected ? 1 : 0,
    tokenData.permissions_granted_at || new Date().toISOString(),
  ];

  dbRun(statement, params);
  return id;
}

/**
 * Get OAuth token
 */
export async function getOAuthToken(
  userId: string,
  provider: OAuthProvider,
  purpose: OAuthPurpose,
): Promise<OAuthToken | null> {
  const statement = sql`
    SELECT * FROM oauth_tokens
    WHERE user_id = ? AND provider = ? AND purpose = ? AND is_active = 1
  `;
  const token = dbGet<OAuthToken & { scopes_granted?: string }>(statement, [
    userId,
    provider,
    purpose,
  ]);

  if (token && token.scopes_granted && typeof token.scopes_granted === "string") {
    (token as OAuthToken).scopes_granted = JSON.parse(token.scopes_granted);
  }

  return token || null;
}

/**
 * Update OAuth token
 */
export async function updateOAuthToken(
  tokenId: string,
  updates: Partial<OAuthToken>,
): Promise<void> {
  const allowedFields: readonly ColumnOf<"oauth_tokens">[] = [
    "access_token",
    "refresh_token",
    "token_expires_at",
    "scopes_granted",
    "connected_email_address",
    "mailbox_connected",
    "token_last_refreshed_at",
    "token_refresh_failed_count",
    "last_sync_at",
    "last_sync_error",
    "is_active",
  ];

  const columns: ColumnOf<"oauth_tokens">[] = [];
  const values: unknown[] = [];

  Object.keys(updates).forEach((key) => {
    const column = allowedFields.find((allowed) => allowed === key);
    if (column) {
      let value = (updates as Record<string, unknown>)[key];
      if (column === "scopes_granted" && Array.isArray(value)) {
        value = JSON.stringify(value);
      }
      columns.push(column);
      values.push(value);
    }
  });

  if (columns.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Validate column names against the whitelist before SQL construction.
  //
  // BACKLOG-3085 retires the BACKLOG-2739 Phase 1 seam cast that used to sit
  // here. `columns` is now the column UNION rather than `string[]`, because the
  // SET clause is built by `assignmentList` from the enumerated column
  // fragments — so there is nothing left to cast. The runtime check stays: it
  // is for names that arrive from outside the type system, which the types
  // cannot see. See `sqlFieldWhitelist.ts`'s own header.
  validateFields("oauth_tokens", columns);

  values.push(tokenId);

  const statement = sql`UPDATE oauth_tokens SET ${assignmentList(columns)} WHERE id = ?`;
  dbRun(statement, values);
}

/**
 * Delete OAuth token
 */
export async function deleteOAuthToken(
  userId: string,
  provider: OAuthProvider,
  purpose: OAuthPurpose,
): Promise<void> {
  const statement =
    sql`DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ? AND purpose = ?`;
  dbRun(statement, [userId, provider, purpose]);
}

/**
 * Clear all OAuth tokens (for session-only OAuth on app startup)
 * This forces all users to re-authenticate each app launch
 */
export async function clearAllOAuthTokens(): Promise<void> {
  const statement = sql`DELETE FROM oauth_tokens`;
  dbRun(statement, []);
  logService.info("[OAuthTokenDbService] Cleared all OAuth tokens for session-only OAuth", "OAuthTokenDbService");
}

/**
 * Get the last sync timestamp for an OAuth token
 * Used for incremental email fetching
 * @param userId - User ID
 * @param provider - OAuth provider (google | microsoft)
 * @returns Date of last sync, or null if never synced
 */
export async function getOAuthTokenSyncTime(
  userId: string,
  provider: OAuthProvider,
): Promise<Date | null> {
  const statement = sql`
    SELECT last_sync_at FROM oauth_tokens
    WHERE user_id = ? AND provider = ? AND purpose = 'mailbox' AND is_active = 1
  `;
  const row = dbGet<{ last_sync_at?: string }>(statement, [userId, provider]);

  if (row?.last_sync_at) {
    return new Date(row.last_sync_at);
  }
  return null;
}

/**
 * Update the last sync timestamp for an OAuth token
 * Should only be called AFTER successful email storage
 * @param userId - User ID
 * @param provider - OAuth provider (google | microsoft)
 * @param syncTime - Timestamp of the sync
 */
export async function updateOAuthTokenSyncTime(
  userId: string,
  provider: OAuthProvider,
  syncTime: Date,
): Promise<void> {
  const statement = sql`
    UPDATE oauth_tokens
    SET last_sync_at = ?
    WHERE user_id = ? AND provider = ? AND purpose = 'mailbox' AND is_active = 1
  `;
  dbRun(statement, [syncTime.toISOString(), userId, provider]);
  logService.info(
    `[OAuthTokenDbService] Updated last_sync_at for ${provider} to ${syncTime.toISOString()}`,
    "OAuthTokenDbService",
  );
}
