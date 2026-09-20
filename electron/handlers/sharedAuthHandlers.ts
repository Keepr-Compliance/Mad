/**
 * Shared Authentication Handlers
 * Handles cross-provider auth operations like pending login completion,
 * mailbox token management, and disconnection
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from "electron";
import os from "os";
import crypto from "crypto";
import { app } from "electron";
import * as Sentry from "@sentry/electron/main";
import type {
  User,
  Subscription,
  SubscriptionTier,
  SubscriptionStatus,
} from "../types/models";
import type {
  DisconnectMailboxResult,
  MailboxRevokeOutcome,
  MailboxRevokeReason,
} from "../types/ipc/window-api-auth";

// Import services
import databaseService from "../services/databaseService";
import googleAuthService from "../services/googleAuthService";
import microsoftAuthService from "../services/microsoftAuthService";
import supabaseService from "../services/supabaseService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import sessionService from "../services/sessionService";
import { provisionLogin } from "../services/loginProvisioningService";
import { setSyncUserId } from "./syncHandlers";

// Import validation utilities
import { getValidUserId } from "../utils/userIdHelper";

// Import constants
import {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
} from "../constants/legalVersions";

import { sendToMainWindow } from "../windowRegistry";

// Type definitions
interface AuthResponse {
  success: boolean;
  error?: string;
}

/**
 * The pending-login payload, as a NAMED type rather than an inline object type
 * in the parameter list.
 *
 * That is not cosmetic. `writeAtomicity.guard.test.ts` brace-matches a function
 * body from its DECLARATION line, so an inline object type in the parameter list
 * closes the capture before the body opens and the function reads as having no
 * body at all — zero writes, zero transaction, invisible. This function is the
 * primary login path, so it should not be invisible. Filed as BACKLOG-3225 for
 * the general fix; this hoist lifts one function out of it.
 */
interface PendingLoginPayload {
  provider: "google" | "microsoft";
  userInfo: {
    id: string;
    email: string;
    given_name?: string;
    family_name?: string;
    name?: string;
    picture?: string;
  };
  tokens: {
    access_token: string;
    refresh_token: string | null;
    expires_at?: string;
    expires_in?: number;
    scopes?: string[];
    scope?: string;
  };
  cloudUser: {
    id: string;
    subscription_tier?: SubscriptionTier;
    subscription_status?: SubscriptionStatus;
    trial_ends_at?: string;
    terms_accepted_at?: string;
    privacy_policy_accepted_at?: string;
    terms_version_accepted?: string;
    privacy_policy_version_accepted?: string;
    email_onboarding_completed_at?: string;
  };
  subscription?: Subscription;
}

interface LoginCompleteResponse extends AuthResponse {
  user?: User;
  sessionToken?: string;
  subscription?: Subscription;
  isNewUser?: boolean;
}

/**
 * Check if user needs to accept or re-accept terms
 * BACKLOG-546: Copied from sessionHandlers.ts to determine isNewUser correctly
 */
function needsToAcceptTerms(user: User): boolean {
  if (!user.terms_accepted_at) {
    return true;
  }

  if (!user.terms_version_accepted && !user.privacy_policy_version_accepted) {
    return false;
  }

  if (
    user.terms_version_accepted &&
    user.terms_version_accepted !== CURRENT_TERMS_VERSION
  ) {
    return true;
  }

  if (
    user.privacy_policy_version_accepted &&
    user.privacy_policy_version_accepted !== CURRENT_PRIVACY_POLICY_VERSION
  ) {
    return true;
  }

  return false;
}

/**
 * Complete a pending login after keychain setup
 */
export async function handleCompletePendingLogin(
  _event: IpcMainInvokeEvent,
  oauthData: PendingLoginPayload
): Promise<LoginCompleteResponse> {
  try {
    await logService.info(
      `Completing pending ${oauthData.provider} login after keychain setup`,
      "AuthHandlers"
    );

    const { provider, userInfo, tokens, cloudUser, subscription } = oauthData;

    const expiresAt = tokens.expires_at
      ? tokens.expires_at
      : tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString();

    // BACKLOG-2546: the user row, the token row and the session row commit as
    // ONE unit. Before this they autocommitted separately, and a failure part
    // way through left an account that existed but could never log in — the
    // next attempt takes the update branch and never re-runs provisioning.
    const provisioned = provisionLogin({
      provider,
      oauthId: userInfo.id,
      create: {
        // TASK-1507G: Use Supabase Auth UUID as local user ID for unified IDs
        id: cloudUser.id,
        email: userInfo.email,
        first_name: userInfo.given_name,
        last_name: userInfo.family_name,
        display_name: userInfo.name,
        avatar_url: userInfo.picture,
        oauth_provider: provider,
        oauth_id: userInfo.id,
        subscription_tier: cloudUser.subscription_tier ?? "free",
        subscription_status: cloudUser.subscription_status ?? "trial",
        trial_ends_at: cloudUser.trial_ends_at,
        is_active: true,
      },
      // BACKLOG-546: Sync terms data from cloud if user has already accepted
      updateOnCreate: cloudUser.terms_accepted_at
        ? {
            terms_accepted_at: cloudUser.terms_accepted_at,
            terms_version_accepted: cloudUser.terms_version_accepted,
            privacy_policy_accepted_at: cloudUser.privacy_policy_accepted_at,
            privacy_policy_version_accepted:
              cloudUser.privacy_policy_version_accepted,
          }
        : undefined,
      updateExisting: {
        email: userInfo.email,
        first_name: userInfo.given_name,
        last_name: userInfo.family_name,
        display_name: userInfo.name,
        avatar_url: userInfo.picture,
        ...(cloudUser.terms_accepted_at && {
          terms_accepted_at: cloudUser.terms_accepted_at,
          terms_version_accepted: cloudUser.terms_version_accepted,
        }),
        ...(cloudUser.privacy_policy_accepted_at && {
          privacy_policy_accepted_at: cloudUser.privacy_policy_accepted_at,
          privacy_policy_version_accepted:
            cloudUser.privacy_policy_version_accepted,
        }),
        ...(cloudUser.email_onboarding_completed_at && {
          email_onboarding_completed_at:
            cloudUser.email_onboarding_completed_at,
        }),
        subscription_tier: cloudUser.subscription_tier ?? "free",
        subscription_status: cloudUser.subscription_status ?? "trial",
      },
      touchLastLogin: true,
      token: {
        purpose: "authentication",
        data: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? undefined,
          token_expires_at: expiresAt,
          scopes_granted: tokens.scopes
            ? tokens.scopes.join(" ")
            : tokens.scope || "",
        },
      },
    });

    const localUser = provisioned.user;
    const sessionToken = provisioned.sessionToken;
    const isNewUser = provisioned.isNewUser;

    // Bidirectional sync — a NETWORK call, so it runs after the commit rather
    // than in the middle of the write chain. It reads `existingBefore`, the
    // pre-update snapshot, because that is what the pre-BACKLOG-2546 code read:
    // `localUser` was bound before `updateUser` ran and was never reassigned
    // before this call. Using `provisioned.user` here would send different
    // values to the cloud.
    const beforeUpdate = provisioned.existingBefore;
    if (
      beforeUpdate?.terms_accepted_at &&
      !cloudUser.terms_accepted_at
    ) {
      try {
        await supabaseService.syncTermsAcceptance(
          cloudUser.id,
          beforeUpdate.terms_version_accepted || CURRENT_TERMS_VERSION,
          beforeUpdate.privacy_policy_version_accepted ||
            CURRENT_PRIVACY_POLICY_VERSION
        );
      } catch (syncError) {
        await logService.error(
          "Failed to sync local terms to cloud",
          "AuthHandlers",
          {
            error:
              syncError instanceof Error
                ? syncError.message
                : "Unknown error",
          }
        );
        Sentry.captureException(syncError, {
          tags: { service: "shared-auth-handlers", operation: "completePendingLogin.syncTerms" },
        });
      }
    }

    // Save session to file for persistence across app restarts.
    //
    // BACKLOG-3299: `saveSession` REPORTS failure, it does not throw — a session
    // that cannot be encrypted or cannot be written resolves `false`. Discarding
    // that boolean returned `success: true` with no session file, and the user
    // landed on a dashboard that was signed out again on the next launch.
    //
    // The database commit STANDS. There is no compensating delete: the rows are a
    // complete, usable account, `provisionLogin` is idempotent, and the next
    // attempt takes the update branch and writes a fresh session. Deleting them
    // would recreate the ghost account this whole item exists to remove.
    //
    // Device registration, the login audit entry and `setSyncUserId` are all
    // deliberately skipped below — this login did not succeed, so nothing may
    // record that it did.
    const sessionSaved = await sessionService.saveSession({
      user: localUser,
      sessionToken,
      provider,
      subscription,
      expiresAt: Date.now() + sessionService.getSessionExpirationMs(),
      createdAt: Date.now(),
    });

    if (!sessionSaved) {
      await logService.error(
        "Pending login completed in the database but the session could not be saved",
        "AuthHandlers",
        { userId: localUser.id, provider }
      );
      await auditService.log({
        userId: localUser.id,
        action: "LOGIN_FAILED",
        resourceType: "SESSION",
        resourceId: sessionToken,
        metadata: { provider, pendingLogin: true, reason: "session-not-saved" },
        success: false,
        errorMessage: "Session could not be saved",
      });
      return {
        success: false,
        error: "Could not save your session. Please try signing in again.",
      };
    }

    const deviceInfo = {
      device_id: crypto.randomUUID(),
      device_name: os.hostname(),
      os: os.platform() + " " + os.release(),
      app_version: app.getVersion(),
    };
    await supabaseService.registerDevice(cloudUser.id, deviceInfo);

    await supabaseService.trackEvent(
      cloudUser.id,
      "user_login",
      { provider },
      deviceInfo.device_id,
      app.getVersion()
    );

    await auditService.log({
      userId: localUser.id,
      action: "LOGIN",
      resourceType: "SESSION",
      resourceId: sessionToken,
      metadata: { provider, isNewUser, pendingLogin: true },
      success: true,
    });

    await logService.info(
      `Pending ${provider} login completed successfully`,
      "AuthHandlers",
      { userId: localUser.id }
    );

    setSyncUserId(localUser.id);

    // BACKLOG-546: Use needsToAcceptTerms instead of isNewUser to determine if T&C screen needed
    return {
      success: true,
      user: localUser,
      sessionToken,
      subscription,
      isNewUser: needsToAcceptTerms(localUser),
    };
  } catch (error) {
    await logService.error("Failed to complete pending login", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "shared-auth-handlers", operation: "completePendingLogin" },
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Save pending mailbox tokens after database is initialized
 */
export async function handleSavePendingMailboxTokens(
  _event: IpcMainInvokeEvent,
  data: {
    userId: string;
    provider: "google" | "microsoft";
    email: string;
    tokens: {
      access_token: string;
      refresh_token: string | null;
      expires_at: string;
      scopes: string;
    };
  }
): Promise<AuthResponse> {
  try {
    await logService.info(
      `Saving pending ${data.provider} mailbox tokens`,
      "AuthHandlers",
      { userId: data.userId, email: data.email }
    );

    // BACKLOG-551: Validate user ID exists in local DB (handles Supabase auth.uid() mismatch)
    const validatedUserId = await getValidUserId(data.userId, "SharedAuth");
    if (!validatedUserId) {
      return {
        success: false,
        error: "No user found in database. Please log in first.",
      };
    }

    await databaseService.saveOAuthToken(
      validatedUserId,
      data.provider,
      "mailbox",
      {
        access_token: data.tokens.access_token,
        refresh_token: data.tokens.refresh_token ?? undefined,
        token_expires_at: data.tokens.expires_at,
        scopes_granted: data.tokens.scopes,
        connected_email_address: data.email,
        mailbox_connected: true,
      }
    );

    await logService.info(
      `Pending ${data.provider} mailbox tokens saved`,
      "AuthHandlers",
      { userId: validatedUserId }
    );

    await auditService.log({
      userId: validatedUserId,
      action: "MAILBOX_CONNECT",
      resourceType: "MAILBOX",
      metadata: { provider: data.provider, email: data.email, pending: true },
      success: true,
    });

    return { success: true };
  } catch (error) {
    await logService.error(
      "Failed to save pending mailbox tokens",
      "AuthHandlers",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    Sentry.captureException(error, {
      tags: { service: "shared-auth-handlers", operation: "savePendingMailboxTokens" },
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

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
  ipcMain.handle("auth:complete-pending-login", handleCompletePendingLogin);
  ipcMain.handle("auth:save-pending-mailbox-tokens", handleSavePendingMailboxTokens);

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
