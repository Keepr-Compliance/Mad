/**
 * Microsoft Authentication Handlers
 * Handles Microsoft OAuth login and Outlook mailbox connection flows
 */

import { devToolsPreference } from "../bootstrap/appMenu";
import { ipcMain, BrowserWindow, Event as ElectronEvent } from "electron";
import type {
  OnHeadersReceivedListenerDetails,
  HeadersReceivedResponse,
} from "electron";

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
 * Pre-DB Microsoft mailbox connection (returns tokens instead of saving to DB)
 */
export async function handleMicrosoftConnectMailboxPending(
  _mainWindow: BrowserWindow | null,
  emailHint?: string
): Promise<LoginStartResponse> {
  try {
    await logService.info(
      "Starting Microsoft mailbox connection (pre-DB mode)",
      "AuthHandlers"
    );

    const { authUrl, codePromise, codeVerifier, scopes: _scopes } =
      await microsoftAuthService.authenticateForMailbox(emailHint);

    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: true,
      webPreferences: {
        devTools: devToolsPreference(), // BACKLOG-3830
        nodeIntegration: false,
        contextIsolation: true,
        // webSecurity defaults to true - do not disable
      },
      autoHideMenuBar: true,
      title: "Connect Microsoft Mailbox",
    });

    authWindow.show();
    authWindow.focus();

    const filter = {
      urls: [
        "*://*.microsoftonline.com/*",
        "*://*.msauth.net/*",
        "*://*.msftauth.net/*",
      ],
    };
    authWindow.webContents.session.webRequest.onHeadersReceived(
      filter,
      (
        details: OnHeadersReceivedListenerDetails,
        callback: (response: HeadersReceivedResponse) => void
      ) => {
        const responseHeaders = details.responseHeaders || {};
        delete responseHeaders["content-security-policy"];
        delete responseHeaders["content-security-policy-report-only"];
        delete responseHeaders["x-content-security-policy"];
        callback({ responseHeaders });
      }
    );

    authWindow.loadURL(authUrl);

    let authCompleted = false;

    authWindow.on("closed", () => {
      if (!authCompleted) {
        microsoftAuthService.stopLocalServer();
        sendToMainWindow("microsoft:mailbox-pending-cancelled");
      }
    });

    const handleCallbackUrl = (callbackUrl: string) => {
      const parsedUrl = new URL(callbackUrl);
      const code = parsedUrl.searchParams.get("code");
      const error = parsedUrl.searchParams.get("error");
      const errorDescription = parsedUrl.searchParams.get("error_description");

      if (error) {
        microsoftAuthService.rejectCodeDirectly(errorDescription || error);
        authCompleted = true;
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
      } else if (code) {
        microsoftAuthService.resolveCodeDirectly(code);
        authCompleted = true;
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
      }
    };

    authWindow.webContents.on(
      "will-navigate",
      (event: ElectronEvent, url: string) => {
        if (url.startsWith("http://localhost:3000/callback")) {
          event.preventDefault();
          handleCallbackUrl(url);
        }
      }
    );

    authWindow.webContents.on(
      "will-redirect",
      (event: ElectronEvent, url: string) => {
        if (url.startsWith("http://localhost:3000/callback")) {
          event.preventDefault();
          handleCallbackUrl(url);
        }
      }
    );

    const processAuthInBackground = async () => {
      try {
        const timeoutMs = 120000;
        const codeWithTimeout = Promise.race([
          codePromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Authentication timed out")),
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

        const expiresAt = new Date(
          Date.now() + tokens.expires_in * 1000
        ).toISOString();

        await logService.info(
          "Microsoft mailbox connection completed (pre-DB mode)",
          "AuthHandlers",
          { email: userInfo.email }
        );

        sendToMainWindow("microsoft:mailbox-pending-connected", {
          success: true,
          email: userInfo.email,
          tokens: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || null,
            expires_at: expiresAt,
            scopes: tokens.scope,
          },
        });
      } catch (error) {
        await logService.error(
          "Microsoft mailbox connection failed (pre-DB mode)",
          "AuthHandlers",
          { error: error instanceof Error ? error.message : "Unknown error" }
        );

        sendToMainWindow("microsoft:mailbox-pending-connected", {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };
    setTimeout(() => {
      void processAuthInBackground();
    }, 0);

    return { success: true };
  } catch (error) {
    await logService.error(
      "Microsoft mailbox connection failed (pre-DB mode)",
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

  ipcMain.handle(
    "auth:microsoft:connect-mailbox-pending",
    (event, emailHint?: string) =>
      handleMicrosoftConnectMailboxPending(_mainWindow, emailHint)
  );
}
