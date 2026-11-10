/**
 * Shared Authentication Handlers
 * Handles cross-provider auth operations: mailbox disconnection and the
 * dev-only token and onboarding helpers
 */

import { ipcMain, BrowserWindow } from "electron";
import * as Sentry from "@sentry/electron/main";
import type {
  DisconnectMailboxResult,
  MailboxRevokeOutcome,
  MailboxRevokeReason,
} from "../types/ipc/window-api-auth";

// Import services
import databaseService from "../services/databaseService";
import googleAuthService from "../services/googleAuthService";
import microsoftAuthService from "../services/microsoftAuthService";
import auditService from "../services/auditService";
import logService from "../services/logService";

// Import validation utilities
import { getValidUserId } from "../utils/userIdHelper";

import { sendToMainWindow } from "../windowRegistry";
import { invalidateMailboxFetches } from "../services/mailboxFetchGeneration";

/**
 * Disconnect mailbox: end the provider's grant, then remove the local OAuth
 * token row.
 *
 * BACKLOG-3206: this used to delete the row and stop. Deleting the row stops
 * Keepr reading the mailbox from this computer, but the grant the user gave at
 * the provider stays live — so the app still holds access the user believes
 * they just took away. The disconnect now asks the provider to end that grant.
 *
 * ORDER: revoke first, delete in a `finally`.
 *
 * The handler has to await the revoke either way, because it reports the
 * outcome — so deleting first would return no sooner and would shorten no
 * window. It would change only which artifact survives a crash mid-operation,
 * and delete-first leaves the worst one: row gone, grant alive, nothing left to
 * retry from. Revoke-first is self-healing — press Disconnect again and the
 * second revoke gets `invalid_token`, which is `already-invalid`, and the
 * delete completes.
 *
 * The delete is in a `finally` so it runs whatever the revoke does. A user who
 * pressed Disconnect gets the local row deleted; whether the provider answered
 * is a separate fact, reported separately as `revokeOutcome`.
 */
export async function handleDisconnectMailbox(
  _mainWindow: BrowserWindow | null,
  userId: string,
  provider: "google" | "microsoft"
): Promise<DisconnectMailboxResult> {
  try {
    await logService.info(
      `Starting ${provider} mailbox disconnect`,
      "AuthHandlers",
      { userId }
    );

    // BACKLOG-551: Validate user ID exists in local DB (handles Supabase auth.uid() mismatch)
    const validatedUserId = await getValidUserId(userId, "SharedAuth");
    if (!validatedUserId) {
      return {
        success: false,
        error: "No user found in database. Please log in first.",
      };
    }

    // BACKLOG-3903: stop every in-flight fetch for this provider's mailbox
    // FIRST — before the revoke and the token delete — so nothing it has
    // fetched, or fetches from here on, is written after the user pressed
    // Disconnect. Synchronous, so no write can slip in between.
    invalidateMailboxFetches(provider);

    let revokeOutcome: MailboxRevokeOutcome;
    let revokeReason: MailboxRevokeReason | undefined;
    // True only while the Google token read is in flight. It is what tells the
    // catch below which half threw, and it is why `read-failed` is Google-only
    // by construction rather than by a copy check: the Microsoft branch never
    // sets it because it never reaches the read.
    let readingTokenRow = false;

    try {
      if (provider === "microsoft") {
        // Short-circuit BEFORE the token read. Microsoft publishes no
        // revocation endpoint, so reading the row would buy a database call
        // that nothing can use.
        revokeOutcome = (await microsoftAuthService.revokeToken()).outcome;
      } else {
        readingTokenRow = true;
        const tokenRow = await databaseService.getOAuthToken(
          validatedUserId,
          provider,
          "mailbox"
        );
        readingTokenRow = false;

        // Google's endpoint accepts either token, and revoking an access token
        // cascades to the refresh token it belongs to. Prefer the refresh
        // token: it is the one that is still alive.
        //
        // KNOWN LIMIT: `refresh_token` is nullable
        // (`oauthTokenDbService.ts:50` writes `tokenData.refresh_token ||
        // null`), and a reconnect over a live grant can come back without one.
        // In that state this falls back to a probably-expired access token, and
        // a revoke of an expired token revokes nothing. Recorded, not fixed
        // here.
        const tokenToRevoke =
          tokenRow?.refresh_token || tokenRow?.access_token;

        if (!tokenToRevoke) {
          revokeOutcome = "no-token";
        } else {
          const revokeResult =
            await googleAuthService.revokeToken(tokenToRevoke);
          revokeOutcome = revokeResult.outcome;
          revokeReason = revokeResult.reason;
        }
      }
    } catch (revokeError) {
      // A read we could not perform is NOT "there was no token". There may
      // well have been one; we could not see it, and the `finally` below is
      // about to delete the row regardless. Calling that `no-token` would
      // report silence to the user about a grant that is probably still live.
      revokeOutcome = readingTokenRow ? "read-failed" : "failed";

      await logService.error(
        `${provider} mailbox revoke step failed`,
        "AuthHandlers",
        {
          userId: validatedUserId,
          revokeOutcome,
          error:
            revokeError instanceof Error
              ? revokeError.message
              : "Unknown error",
        }
      );
    } finally {
      // Unconditional. Do not move this into the `try` — a throwing read would
      // then skip it and the user would press Disconnect and stay connected.
      await databaseService.deleteOAuthToken(
        validatedUserId,
        provider,
        "mailbox"
      );
    }

    await logService.info(
      `${provider} mailbox disconnected successfully`,
      "AuthHandlers",
      { userId: validatedUserId }
    );

    await logService.info(
      `${provider} mailbox revoke outcome: ${revokeOutcome}`,
      "AuthHandlers",
      { userId: validatedUserId, revokeOutcome, revokeReason }
    );

    await auditService.log({
      userId: validatedUserId,
      action: "MAILBOX_DISCONNECT",
      resourceType: "MAILBOX",
      metadata: { provider, revokeOutcome, revokeReason },
      success: true,
    });

    sendToMainWindow(`${provider}:mailbox-disconnected`, {
      success: true,
    });

    return { success: true, revokeOutcome, revokeReason };
  } catch (error) {
    await logService.error(
      `${provider} mailbox disconnect failed`,
      "AuthHandlers",
      {
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    Sentry.captureException(error, {
      tags: { service: "shared-auth-handlers", operation: "disconnectMailbox" },
    });

    // Use original userId for error logging since validatedUserId may not exist
    await auditService.log({
      userId: userId || "unknown",
      action: "MAILBOX_DISCONNECT",
      resourceType: "MAILBOX",
      metadata: { provider },
      success: false,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Register shared auth handlers
 */
export function registerSharedAuthHandlers(
  _mainWindow: BrowserWindow | null
): void {
  ipcMain.handle("auth:google:disconnect-mailbox", (event, userId: string) =>
    handleDisconnectMailbox(_mainWindow, userId, "google")
  );

  ipcMain.handle("auth:microsoft:disconnect-mailbox", (event, userId: string) =>
    handleDisconnectMailbox(_mainWindow, userId, "microsoft")
  );

  // DEV ONLY: Expire a mailbox token for testing Connection Issue state
  // This invalidates both access and refresh tokens to prevent auto-refresh
  ipcMain.handle(
    "auth:dev:expire-mailbox-token",
    async (_event, userId: string, provider: "google" | "microsoft") => {
      try {
        const token = await databaseService.getOAuthToken(userId, provider, "mailbox");
        if (!token) {
          return { success: false, error: "No token found" };
        }
        // Set expiry to 1 hour ago and clear refresh token to prevent auto-refresh
        const expiredTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await databaseService.updateOAuthToken(token.id, {
          token_expires_at: expiredTime,
          refresh_token: "INVALIDATED_FOR_TESTING",
          access_token: "EXPIRED_FOR_TESTING",
        });
        await logService.info(
          `[DEV] Expired ${provider} mailbox token for testing (refresh invalidated)`,
          "SharedAuthHandlers",
          { userId, expiredTime }
        );
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }
  );

  // DEV ONLY: Reset onboarding for testing the onboarding flow
  // This clears email_onboarding_completed_at and mobile_phone_type
  ipcMain.handle(
    "auth:dev:reset-onboarding",
    async (_event, userId: string) => {
      try {
        await logService.info(
          `[Auth] DEV: Resetting onboarding for user ${userId}`,
          "AuthHandlers"
        );

        // Use raw SQL to set fields to NULL (updateUser doesn't support null values)
        const db = databaseService.getRawDatabase();
        db.prepare(
          "UPDATE users_local SET email_onboarding_completed_at = NULL, mobile_phone_type = NULL WHERE id = ?"
        ).run(userId);

        await logService.info(
          `[Auth] DEV: Onboarding reset complete for user ${userId}`,
          "AuthHandlers"
        );

        return { success: true };
      } catch (error) {
        await logService.error(
          "[Auth] DEV: Failed to reset onboarding",
          "AuthHandlers",
          { error: String(error) }
        );
        return { success: false, error: String(error) };
      }
    }
  );
}
