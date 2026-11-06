/**
 * Google Authentication Handlers
 * Handles Gmail mailbox connection flows (sign-in is the browser deep link)
 */

import { ipcMain, BrowserWindow } from "electron";

// Import services
import databaseService from "../services/databaseService";
import googleAuthService from "../services/googleAuthService";
import auditService from "../services/auditService";
import { recordEmailProvider } from "../services/emailProviderRecord";
import logService from "../services/logService";
import { importEnabledEmptyContactSources } from "../services/postConnectContactImport";

// Import validation utilities
import { ValidationError } from "../utils/validation";
import { getValidUserId } from "../utils/userIdHelper";
import { bringAppToFront } from "../utils/bringAppToFront";

import { sendToMainWindow, getMainWindow } from "../windowRegistry";

// Module-level storage for PKCE code verifiers between split IPC handlers
// Key: flow type ("mailbox"), Value: codeVerifier
const pendingCodeVerifiers = new Map<string, string>();

// Type definitions
interface AuthResponse {
  success: boolean;
  error?: string;
}

interface MailboxConnectionResponse extends AuthResponse {
  authUrl?: string;
  scopes?: string[];
}

/**
 * Google Auth: Connect mailbox (Gmail access)
 */
export async function handleGoogleConnectMailbox(
  _mainWindow: BrowserWindow | null,
  userId: string
): Promise<MailboxConnectionResponse> {
  try {
    await logService.info(
      "Starting Google mailbox connection with redirect",
      "AuthHandlers"
    );

    // BACKLOG-551: Validate user ID exists in local DB (handles Supabase auth.uid() mismatch)
    const validatedUserId = await getValidUserId(userId, "GoogleAuth");
    if (!validatedUserId) {
      return {
        success: false,
        error: "No user found in database. Please log in first.",
      };
    }

    // Get user info to use as login hint
    const user = await databaseService.getUserById(validatedUserId);
    const loginHint = user?.email ?? undefined;

    // Start auth flow
    const { authUrl, codePromise, codeVerifier, scopes } =
      await googleAuthService.authenticateForMailbox(loginHint);

    // Store codeVerifier for the setTimeout completion below
    pendingCodeVerifiers.set("mailbox", codeVerifier);

    await logService.info(
      "Opening Google mailbox auth URL in popup window",
      "AuthHandlers"
    );

    // BACKLOG-1570: Use system browser instead of BrowserWindow popup.
    // The system browser has the user's existing Google session from login,
    // so they won't need to re-enter their password (RFC 8252 best practice).
    // The local server (startLocalServer) catches the redirect callback.
    const { shell } = await import("electron");
    shell.openExternal(authUrl);

    // With system browser, the local server handles the callback directly.
    // No BrowserWindow navigation interception needed.

    // Process in background
    const processLoginInBackground = async () => {
      try {
        const code = await codePromise;
        await logService.info(
          "Received Gmail authorization code",
          "AuthHandlers"
        );

        // Retrieve and clear the PKCE code verifier
        const storedCodeVerifier = pendingCodeVerifiers.get("mailbox");
        pendingCodeVerifiers.delete("mailbox");

        // Exchange code for tokens (PKCE: codeVerifier required)
        const { tokens } = await googleAuthService.exchangeCodeForTokens(code, storedCodeVerifier);

        const accessToken = tokens.access_token;
        const refreshToken = tokens.refresh_token || null;

        // Get user's email
        const userInfo = await googleAuthService.getUserInfo(
          tokens.access_token
        );

        // Save mailbox token - handle errors explicitly to prevent white screen
        try {
          await databaseService.saveOAuthToken(validatedUserId, "google", "mailbox", {
            access_token: accessToken,
            refresh_token: refreshToken ?? undefined,
            token_expires_at: tokens.expires_at ?? undefined,
            scopes_granted: Array.isArray(tokens.scopes)
              ? tokens.scopes.join(" ")
              : tokens.scopes,
            connected_email_address: userInfo.email,
            mailbox_connected: true,
          });
        } catch (saveError) {
          await logService.error(
            "Failed to save Google mailbox OAuth token",
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
            metadata: { provider: "google", error: "token_save_failed" },
            success: false,
            errorMessage: saveError instanceof Error ? saveError.message : "Failed to save credentials",
          });

          sendToMainWindow("google:mailbox-connected", {
            success: false,
            error: "Failed to save credentials. Please try logging in again.",
          });
          return;
        }

        await logService.info(
          "Google mailbox connection completed",
          "AuthHandlers",
          { userId: validatedUserId, email: userInfo.email }
        );

        // Audit log
        await auditService.log({
          userId: validatedUserId,
          action: "MAILBOX_CONNECT",
          resourceType: "MAILBOX",
          metadata: { provider: "google", email: userInfo.email },
          success: true,
        });

        // BACKLOG-3888: remember that this account chose this mailbox provider
        // (cloud preferences.emailProviders). Never blocks or fails the connect.
        void recordEmailProvider(validatedUserId, "google");

        // BACKLOG-3394: bring the app forward OURSELVES. The user is looking at
        // a browser tab; before this the served page asked them to click
        // "Return to Application", which fired `keepr://focus` and made the
        // browser prompt for permission — from a `listen(0)` origin that is
        // different on every connect, so "Always allow" never stuck.
        //
        // Focus FIRST, then notify; the order is pinned by an assertion. It is
        // pinned because it is free and directionally right, NOT because it is
        // known to fix delivery. `app.focus({ steal: true })` is an
        // ASYNCHRONOUS OS activation request, so this ordering does not
        // establish that the renderer is foreground when the send happens, and
        // no unit test here can establish it.
        //
        // UNTRACED LEAD — do not build on it. Whether focusing first affects
        // BACKLOG-1709's lost success event is unproven: 1709's pass 2 wrote
        // the backgrounded-webContents candidate down as "Offered as a lead,
        // not a finding … n = 3. Do not build on it." (pm_comments 7ae840b3).
        // It cannot touch 1709's lost-REPLY branch at all — this code runs
        // inside processLoginInBackground, after codePromise resolves, while
        // the invoke reply was already dispatched at the `return` below,
        // before codePromise had resolved.
        //
        // Only this branch focuses. A failed connect must not steal the user's
        // browser out from under them.
        // BACKLOG-3454: the live window, not the one captured at registration —
        // after a Dock reopen the captured one is destroyed and nothing focuses.
        bringAppToFront(getMainWindow());

        // Notify renderer
        sendToMainWindow("google:mailbox-connected", {
          success: true,
          email: userInfo.email,
        });

        // BACKLOG-1759: Now that the Google mailbox is connected, re-fire the
        // Google contact import for users who enabled it but have no Google
        // contacts yet. Fire-and-forget: this MUST NOT be awaited — an import
        // error must never surface as a failed connect. Google contacts also
        // require the contacts.readonly scope; syncProvider.canSync gates that
        // and reports reconnectRequired without throwing.
        void importEnabledEmptyContactSources(validatedUserId, ["google_contacts"])
          .then((importResults) => {
            const importedAny = importResults.some((r) => r.imported > 0);
            if (importedAny) {
              // Refresh any open contact picker so the newly imported contacts appear.
              sendToMainWindow("contacts:external-sync-complete");
            }
          })
          .catch((importError) => {
            logService.error(
              "Post-connect Google contact import failed",
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
        await logService.error(
          "Google mailbox connection failed",
          "AuthHandlers",
          {
            userId: validatedUserId,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        );

        await auditService.log({
          userId: validatedUserId,
          action: "MAILBOX_CONNECT",
          resourceType: "MAILBOX",
          metadata: { provider: "google" },
          success: false,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        });

        sendToMainWindow("google:mailbox-connected", {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };
    setTimeout(() => {
      void processLoginInBackground();
    }, 0);

    return {
      success: true,
      authUrl,
      scopes,
    };
  } catch (error) {
    await logService.error(
      "Google mailbox connection failed",
      "AuthHandlers",
      {
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: `Validation error: ${error.message}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Register all Google authentication handlers
 */
export function registerGoogleAuthHandlers(
  _mainWindow: BrowserWindow | null
): void {
  // Google Auth - Mailbox Connection
  ipcMain.handle("auth:google:connect-mailbox", (_event, userId: string) =>
    handleGoogleConnectMailbox(_mainWindow, userId)
  );
}
