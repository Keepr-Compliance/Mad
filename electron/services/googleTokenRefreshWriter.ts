/**
 * Saves the tokens a Google OAuth2 client emits on its "tokens" event after a
 * refresh (BACKLOG-3306). Shared by gmailFetchService and googleContactProvider.
 *
 * One UPDATE, so a failure leaves the row as it was instead of one token
 * column new and the other stale. A failed write is logged, not left as an
 * unhandled rejection on the main process.
 */
import databaseService from "./databaseService";
import logService from "./logService";
import type { OAuthToken } from "../types/models";

/** The fields of google-auth-library's `Credentials` this writer reads. */
export interface RefreshedGoogleTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  /** Absolute time in epoch ms, already computed by the library from expires_in. */
  expiry_date?: number | null;
}

export function persistRefreshedGoogleTokens(
  tokenRecordId: string,
  tokens: RefreshedGoogleTokens,
  logContext: string,
): Promise<void> {
  // Build `updates` SYNCHRONOUSLY, before any await. After emitting "tokens",
  // google-auth-library overwrites `tokens.refresh_token` on this same object
  // with the refresh token it already held, so reading it later would drop a
  // rotated refresh token.
  //
  // Set a key only when there is a value. updateOAuthToken writes every key
  // present, and an `undefined` value is stored as NULL: setting
  // `refresh_token: undefined` on a normal refresh would erase the refresh
  // token.
  const updates: Partial<OAuthToken> = {};
  if (tokens.access_token) {
    updates.access_token = tokens.access_token;
    if (tokens.expiry_date) {
      updates.token_expires_at = new Date(tokens.expiry_date).toISOString();
    }
  }
  if (tokens.refresh_token) {
    updates.refresh_token = tokens.refresh_token;
  }
  if (Object.keys(updates).length === 0) {
    return Promise.resolve();
  }

  return databaseService
    .updateOAuthToken(tokenRecordId, updates)
    .catch((error: unknown) => {
      void logService.error("Failed to save refreshed Google tokens", logContext, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
