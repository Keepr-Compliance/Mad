/**
 * OAuth Token Database Service
 * Handles all OAuth token-related database operations
 */

import crypto from "crypto";
import type { OAuthToken, OAuthProvider, OAuthPurpose } from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbRun } from "./core/dbConnection";
import {
  validateFields,
  type ColumnOf,
  type FieldExpression,
} from "../../utils/sqlFieldWhitelist";
import logService from "../logService";

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

  const sql = `
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

  dbRun(sql, params);
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
  const sql = `
    SELECT * FROM oauth_tokens
    WHERE user_id = ? AND provider = ? AND purpose = ? AND is_active = 1
  `;
  const token = dbGet<OAuthToken & { scopes_granted?: string }>(sql, [
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
  const allowedFields = [
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

  const fields: string[] = [];
  const values: unknown[] = [];

  Object.keys(updates).forEach((key) => {
    if (allowedFields.includes(key)) {
      let value = (updates as Record<string, unknown>)[key];
      if (key === "scopes_granted" && Array.isArray(value)) {
        value = JSON.stringify(value);
      }
      fields.push(`${key} = ?`);
      values.push(value);
    }
  });

  if (fields.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Validate fields against whitelist before SQL construction.
  //
  // BACKLOG-2739 PHASE 1 SEAM — the cast is the finding, not the fix.
  // `fields` is built above as `${column} = ?` from plain strings, so it is
  // `string[]` and cannot satisfy the column union `validateFields` now takes.
  // The cast keeps the build green WITHOUT touching this writer's field list,
  // which is deliberately Phase 2 (BACKLOG-2738): the writer must declare an
  // exhaustive `Record<Column, Decision>` so an OMITTED column is a build
  // error. Until then a wrong name here is still only caught at runtime.
  validateFields(
    "oauth_tokens",
    fields as ReadonlyArray<FieldExpression<ColumnOf<"oauth_tokens">>>,
  );

  values.push(tokenId);

  const sql = `UPDATE oauth_tokens SET ${fields.join(", ")} WHERE id = ?`;
  dbRun(sql, values);
}

/**
 * Delete OAuth token
 */
export async function deleteOAuthToken(
  userId: string,
  provider: OAuthProvider,
  purpose: OAuthPurpose,
): Promise<void> {
  const sql =
    "DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ? AND purpose = ?";
  dbRun(sql, [userId, provider, purpose]);
}

/**
 * Clear all OAuth tokens (for session-only OAuth on app startup)
 * This forces all users to re-authenticate each app launch
 */
export async function clearAllOAuthTokens(): Promise<void> {
  const sql = "DELETE FROM oauth_tokens";
  dbRun(sql, []);
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
  const sql = `
    SELECT last_sync_at FROM oauth_tokens
    WHERE user_id = ? AND provider = ? AND purpose = 'mailbox' AND is_active = 1
  `;
  const row = dbGet<{ last_sync_at?: string }>(sql, [userId, provider]);

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
  const sql = `
    UPDATE oauth_tokens
    SET last_sync_at = ?
    WHERE user_id = ? AND provider = ? AND purpose = 'mailbox' AND is_active = 1
  `;
  dbRun(sql, [syncTime.toISOString(), userId, provider]);
  logService.info(
    `[OAuthTokenDbService] Updated last_sync_at for ${provider} to ${syncTime.toISOString()}`,
    "OAuthTokenDbService",
  );
}
