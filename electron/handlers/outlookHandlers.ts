// ============================================
// OUTLOOK INTEGRATION IPC HANDLERS
// Extracted from main.ts for modularity
// Handles: Outlook OAuth, email export, authentication
// ============================================

import { ipcMain, shell, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";

// Import services
import databaseService from "../services/databaseService";
import microsoftAuthService from "../services/microsoftAuthService";
import OutlookService from "../outlookService";
import logService from "../services/logService";
import { getValidUserId } from "../utils/userIdHelper";

// Track registration to prevent duplicate handlers
let handlersRegistered = false;

// Outlook service instance - shared across handlers
let outlookService: OutlookService | null = null;

// Note: getValidUserId imported from ../utils/userIdHelper (BACKLOG-615: removed duplicate)

/**
 * Register Outlook integration IPC handlers
 */
export function registerOutlookHandlers(_mainWindow: BrowserWindow): void {
  // Prevent double registration
  if (handlersRegistered) {
    logService.warn(
      "Handlers already registered, skipping duplicate registration",
      "OutlookHandlers"
    );
    return;
  }
  handlersRegistered = true;

  // Initialize outlook service
  outlookService = new OutlookService();

  // ===== OUTLOOK INTEGRATION IPC HANDLERS =====
  // Now using redirect-based OAuth (no device code required!)

  // Initialize Outlook service (no-op now, kept for compatibility)
  ipcMain.handle("outlook-initialize", async () => {
    return { success: true };
  });

  // Authenticate with Outlook using redirect-based OAuth
  ipcMain.handle(
    "outlook-authenticate",
    async (event: IpcMainInvokeEvent, providedUserId?: string) => {
      try {
        logService.info("Starting Outlook authentication with redirect flow", "OutlookHandlers");

        // BACKLOG-551: Get valid user ID (handles missing/stale IDs)
        const userId = await getValidUserId(providedUserId);
        if (!userId) {
          return { success: false, error: "No user found in database" };
        }

        // Get user info to use as login hint
        let loginHint: string | undefined = undefined;
        const user = await databaseService.getUserById(userId);
        if (user) {
          loginHint = user.email;
        }

        // Start auth flow - returns authUrl and a promise for the code
        const {
          authUrl,
          codePromise,
          codeVerifier,
          scopes: _scopes,
        } = await microsoftAuthService.authenticateForMailbox(loginHint);

        // Open browser with auth URL
        await shell.openExternal(authUrl);

        // Wait for user to complete auth in browser (local server will catch redirect)
        const code = await codePromise;
        logService.info("Received authorization code from redirect", "OutlookHandlers");

        // Exchange code for tokens
        const tokens = await microsoftAuthService.exchangeCodeForTokens(
          code,
          codeVerifier
        );

        // Get user info
        const userInfo = await microsoftAuthService.getUserInfo(
          tokens.access_token
        );

        // Session-only OAuth: no token encryption needed (database is already encrypted)
        const accessToken = tokens.access_token;
        const refreshToken = tokens.refresh_token || undefined;

        // Save mailbox token to database
        const expiresAt = new Date(
          Date.now() + tokens.expires_in * 1000
        ).toISOString();

        await databaseService.saveOAuthToken(userId, "microsoft", "mailbox", {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_expires_at: expiresAt,
          scopes_granted: tokens.scope,
          connected_email_address: userInfo.email,
        });

        logService.info("Outlook authentication completed successfully", "OutlookHandlers");

        return {
          success: true,
          userInfo: {
            username: userInfo.email,
            name: userInfo.name,
          },
        };
      } catch (error) {
        logService.error("Outlook authentication failed", "OutlookHandlers", { error });
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    }
  );

  // Check if authenticated
  ipcMain.handle(
    "outlook-is-authenticated",
    async (event: IpcMainInvokeEvent, providedUserId?: string) => {
      try {
        // BACKLOG-551: Get valid user ID (handles missing/stale IDs)
        const userId = await getValidUserId(providedUserId);
        if (!userId) return false;

        const token = await databaseService.getOAuthToken(
          userId,
          "microsoft",
          "mailbox"
        );
        if (!token || !token.access_token || !token.token_expires_at)
          return false;

        // Check if token is expired
        const tokenExpiry = new Date(token.token_expires_at);
        const now = new Date();

        return tokenExpiry > now;
      } catch (error) {
        logService.error("Error checking Outlook authentication", "OutlookHandlers", { error });
        return false;
      }
    }
  );

  // Get user email
  ipcMain.handle(
    "outlook-get-user-email",
    async (event: IpcMainInvokeEvent, providedUserId?: string) => {
      try {
        // BACKLOG-551: Get valid user ID (handles missing/stale IDs)
        const userId = await getValidUserId(providedUserId);
        if (!userId) {
          return {
            success: false,
            error: "No user found in database",
          };
        }

        const token = await databaseService.getOAuthToken(
          userId,
          "microsoft",
          "mailbox"
        );
        if (!token || !token.connected_email_address) {
          return {
            success: false,
            error: "Not authenticated",
          };
        }

        return {
          success: true,
          email: token.connected_email_address,
        };
      } catch (error) {
        logService.error("Error getting user email", "OutlookHandlers", { error });
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    }
  );

  // Sign out from Outlook
  ipcMain.handle("outlook-signout", async () => {
    try {
      if (outlookService) {
        await outlookService.signOut();
      }
      return { success: true };
    } catch (error) {
      logService.error("Error signing out", "OutlookHandlers", { error });
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });
}

/**
 * Get the Outlook service instance (for use by other handlers if needed)
 */
export function getOutlookService(): OutlookService | null {
  return outlookService;
}
