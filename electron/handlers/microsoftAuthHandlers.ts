/**
 * Microsoft Authentication Handlers
 * Handles Outlook mailbox connection flows (sign-in is the browser deep link)
 */

import { ipcMain, BrowserWindow } from "electron";

// Import services
import databaseService from "../services/databaseService";
import microsoftAuthService from "../services/microsoftAuthService";
import auditService from "../services/auditService";
import { recordEmailProvider } from "../services/emailProviderRecord";
import logService from "../services/logService";
import { importEnabledEmptyContactSources } from "../services/postConnectContactImport";
import { isAdminConsentError } from "../utils/adminConsent";

// Import validation utilities
import { getValidUserId } from "../utils/userIdHelper";
import { bringAppToFront } from "../utils/bringAppToFront";

import { sendToMainWindow, getMainWindow } from "../windowRegistry";
import { isAuthAttemptSuperseded } from "../services/authAttemptSuperseded";

// Type definitions
interface AuthResponse {
  success: boolean;
  error?: string;
}

interface LoginStartResponse extends AuthResponse {
  authUrl?: string;
  scopes?: string[];
}

/**
 * Microsoft Auth: Connect mailbox (Outlook/Mail access)
 */
export async function handleMicrosoftConnectMailbox(
  _mainWindow: BrowserWindow | null,
  userId: string
): Promise<LoginStartResponse> {
  try {
    await logService.info(
      "Starting Microsoft mailbox connection",
      "AuthHandlers"
    );

    // BACKLOG-551: Validate user ID exists in local DB (handles Supabase auth.uid() mismatch)
    const validatedUserId = await getValidUserId(userId, "MicrosoftAuth");
    if (!validatedUserId) {
      return {
        success: false,
        error: "No user found in database. Please log in first.",
      };
    }

    const user = await databaseService.getUserById(validatedUserId);
    const loginHint = user?.email ?? undefined;

    const { authUrl, codePromise, codeVerifier, scopes } =
      await microsoftAuthService.authenticateForMailbox(loginHint);

    // BACKLOG-1570: Use system browser instead of BrowserWindow popup.
    // The system browser has the user's existing Microsoft session from login,
    // so they won't need to re-enter their password (RFC 8252 best practice).
    // The local server (startLocalServer) catches the redirect callback.
    const { shell } = await import("electron");
    shell.openExternal(authUrl);

    // With system browser, the local server handles the callback directly.
    // No BrowserWindow navigation interception needed.

    const processAuthInBackground = async () => {
      try {
        const timeoutMs = 120000;
        const codeWithTimeout = Promise.race([
          codePromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Mailbox authentication timed out")),
              timeoutMs
            )
          ),
        ]);

        const code = await codeWithTimeout;

        const tokens = await microsoftAuthService.exchangeCodeForTokens(
          code,
          codeVerifier
        );

        const userInfo = await microsoftAuthService.getUserInfo(
          tokens.access_token
        );

        const accessToken = tokens.access_token;
        const refreshToken = tokens.refresh_token || null;

        const expiresAt = new Date(
          Date.now() + tokens.expires_in * 1000
        ).toISOString();

        // Save mailbox token - handle errors explicitly to prevent white screen
        try {
          await databaseService.saveOAuthToken(validatedUserId, "microsoft", "mailbox", {
            access_token: accessToken,
            refresh_token: refreshToken ?? undefined,
            token_expires_at: expiresAt,
            scopes_granted: tokens.scope,
            connected_email_address: userInfo.email,
            mailbox_connected: true,
          });
        } catch (saveError) {
          await logService.error(
            "Failed to save Microsoft mailbox OAuth token",
            "AuthHandlers",
            {
              userId: validatedUserId,
              error: saveError instanceof Error ? saveError.message : "Unknown error",
            }
          );

          await auditService.log({
            userId: validatedUserId,
            action: "MAILBOX_CONNECT",
            resourceType: "MAILBOX",
            metadata: { provider: "microsoft", error: "token_save_failed" },
            success: false,
            errorMessage: saveError instanceof Error ? saveError.message : "Failed to save credentials",
          });

          sendToMainWindow("microsoft:mailbox-connected", {
            success: false,
            error: "Failed to save credentials. Please try logging in again.",
          });
          return;
        }

        await logService.info(
          "Microsoft mailbox connection completed",
          "AuthHandlers",
          { userId: validatedUserId, email: userInfo.email }
        );

        await auditService.log({
          userId: validatedUserId,
          action: "MAILBOX_CONNECT",
          resourceType: "MAILBOX",
          metadata: { provider: "microsoft", email: userInfo.email },
          success: true,
        });

        // BACKLOG-3888: remember that this account chose this mailbox provider
        // (cloud preferences.emailProviders). Never blocks or fails the connect.
        void recordEmailProvider(validatedUserId, "microsoft");

        // BACKLOG-3394: bring the app forward OURSELVES — see the matching
        // comment in googleAuthHandlers.ts, including why the focus ordering is
        // an UNTRACED LEAD rather than a known fix for BACKLOG-1709's lost
        // success event. Focus FIRST, then notify; the order is asserted
        // because it is free and directionally right, not because it is known
        // to affect delivery. Only this branch focuses: a failed connect must
        // not steal the user's browser out from under them.
        // BACKLOG-3454: the live window, not the one captured at registration —
        // after a Dock reopen the captured one is destroyed and nothing focuses.
        bringAppToFront(getMainWindow());

        sendToMainWindow("microsoft:mailbox-connected", {
          success: true,
          email: userInfo.email,
        });

        // BACKLOG-1759: Now that the Microsoft mailbox is connected, re-fire the
        // Outlook contact import for users who enabled it (e.g. during onboarding)
        // but have no Outlook contacts yet. Fire-and-forget: this MUST NOT be
        // awaited — an import error must never surface as a failed connect.
        void importEnabledEmptyContactSources(validatedUserId, ["outlook"])
          .then((importResults) => {
            const importedAny = importResults.some((r) => r.imported > 0);
            if (importedAny) {
              // Refresh any open contact picker so the newly imported contacts appear.
              sendToMainWindow("contacts:external-sync-complete");
            }
          })
          .catch((importError) => {
            logService.error(
              "Post-connect Outlook contact import failed",
              "AuthHandlers",
              {
                userId: validatedUserId,
                error:
                  importError instanceof Error
                    ? importError.message
                    : "Unknown error",
              }
            );
          });
      } catch (error) {
        // BACKLOG-3283 Path 3: a newer connect replaced this one. Say nothing to
        // the renderer — its listener belongs to the newer attempt now.
        if (isAuthAttemptSuperseded(error)) {
          await logService.info("Microsoft mailbox connect superseded by a newer attempt", "AuthHandlers");
          return;
        }
        // BACKLOG-2007: An org tenant admin-consent block arrives here as an
        // AADSTS error (the OAuth redirect's error_description rejects the code
        // promise in microsoftAuthService's local server). Classify it so the
        // renderer can offer a targeted "Request IT approval" flow instead of a
        // dead-end generic failure. Distinct from token-expiry classification.
        const adminConsentRequired = isAdminConsentError(error);

        await logService.error(
          "Microsoft mailbox connection failed",
          "AuthHandlers",
          {
            userId: validatedUserId,
            error: error instanceof Error ? error.message : "Unknown error",
            adminConsentRequired,
          }
        );

        await auditService.log({
          userId: validatedUserId,
          action: "MAILBOX_CONNECT",
          resourceType: "MAILBOX",
          metadata: { provider: "microsoft", adminConsentRequired },
          success: false,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        });

        sendToMainWindow("microsoft:mailbox-connected", {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          adminConsentRequired,
        });
      }
    };
    setTimeout(() => {
      void processAuthInBackground();
    }, 0);

    return { success: true, authUrl, scopes };
  } catch (error) {
    await logService.error(
      "Microsoft mailbox connection failed",
      "AuthHandlers",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Register all Microsoft auth handlers
 */
export function registerMicrosoftAuthHandlers(
  _mainWindow: BrowserWindow | null
): void {
  ipcMain.handle("auth:microsoft:connect-mailbox", (event, userId: string) =>
    handleMicrosoftConnectMailbox(_mainWindow, userId)
  );
}
