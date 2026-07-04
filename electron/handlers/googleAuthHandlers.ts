/**
 * Google Authentication Handlers
 * Handles Google OAuth login and Gmail mailbox connection flows
 */

import { ipcMain, BrowserWindow, Event as ElectronEvent } from "electron";
import os from "os";
import crypto from "crypto";
import type {
  OnHeadersReceivedListenerDetails,
  HeadersReceivedResponse,
} from "electron";
import { app } from "electron";

// Import services
import databaseService from "../services/databaseService";
import googleAuthService from "../services/googleAuthService";
import supabaseService from "../services/supabaseService";
import sessionService from "../services/sessionService";
import rateLimitService from "../services/rateLimitService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import { importEnabledEmptyContactSources } from "../services/postConnectContactImport";

// Import validation utilities
import { ValidationError, validateAuthCode } from "../utils/validation";
import { getValidUserId } from "../utils/userIdHelper";

// Import constants
import {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
} from "../constants/legalVersions";

// Module-level storage for PKCE code verifiers between split IPC handlers
// Key: flow type ("login" | "mailbox" | "mailbox-pending"), Value: codeVerifier
const pendingCodeVerifiers = new Map<string, string>();

// Type definitions
interface AuthResponse {
  success: boolean;
  error?: string;
}

interface LoginStartResponse extends AuthResponse {
  authUrl?: string;
  scopes?: string[];
}

interface LoginCompleteResponse extends AuthResponse {
  user?: import("../types/models").User;
  sessionToken?: string;
  subscription?: import("../types/models").Subscription;
  isNewUser?: boolean;
  rateLimited?: boolean;
  lockedUntil?: string;
  remainingAttempts?: number;
}

interface MailboxConnectionResponse extends AuthResponse {
  authUrl?: string;
  scopes?: string[];
}

interface PendingMailboxTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopesGranted?: string;
  connectedEmailAddress?: string;
  provider: "google" | "microsoft";
}

interface PendingMailboxResponse extends AuthResponse {
  tokens?: PendingMailboxTokens;
}

/**
 * Check if user needs to accept or re-accept terms
 * Returns true if user hasn't accepted OR if the accepted versions are outdated
 */
function needsToAcceptTerms(user: import("../types/models").User): boolean {
  // User hasn't accepted terms at all (truly new user)
  if (!user.terms_accepted_at) {
    return true;
  }

  // Backward compatibility: If user accepted before we added version tracking,
  // don't force them to re-accept (version fields will be null/undefined)
  if (!user.terms_version_accepted && !user.privacy_policy_version_accepted) {
    // User accepted in old system, consider them accepted
    return false;
  }

  // Check if versions have been updated since user last accepted
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
 * Google Auth: Start login flow (uses popup window)
 */
export async function handleGoogleLogin(
  mainWindow: BrowserWindow | null
): Promise<LoginStartResponse> {
  try {
    await logService.info(
      "Starting Google login flow with redirect",
      "AuthHandlers"
    );

    // Start auth flow - returns authUrl, codePromise, codeVerifier, and scopes
    const { authUrl, codePromise, codeVerifier, scopes } =
      await googleAuthService.authenticateForLogin();

    // Store codeVerifier for the split handler (handleGoogleCompleteLogin)
    // and for the setTimeout completion below
    pendingCodeVerifiers.set("login", codeVerifier);

    await logService.info(
      "Opening Google auth URL in popup window",
      "AuthHandlers"
    );

    // Create a popup window for auth
    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // webSecurity defaults to true - do not disable
      },
      autoHideMenuBar: true,
      title: "Sign in with Google",
    });

    // Strip CSP headers to allow Google's scripts to load
    const filter = {
      urls: [
        "*://*.google.com/*",
        "*://*.googleapis.com/*",
        "*://*.gstatic.com/*",
        "*://*.googleusercontent.com/*",
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

    // Load the auth URL
    authWindow.loadURL(authUrl);

    // Track if auth completed successfully
    let authCompleted = false;

    // Clean up server if window is closed before auth completes
    authWindow.on("closed", () => {
      if (!authCompleted) {
        googleAuthService.stopLocalServer();
        logService.info(
          "Google login auth window closed by user, cleaned up server",
          "AuthHandlers"
        );
        // Notify renderer that auth was cancelled
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("google:login-cancelled");
          logService.info(
            "Sent google:login-cancelled event to renderer",
            "AuthHandlers"
          );
        }
      }
    });

    // Intercept navigation to callback URL to extract code directly
    const handleGoogleCallbackUrl = (callbackUrl: string) => {
      const parsedUrl = new URL(callbackUrl);
      const code = parsedUrl.searchParams.get("code");
      const error = parsedUrl.searchParams.get("error");
      const errorDescription = parsedUrl.searchParams.get("error_description");

      if (error) {
        logService.error(
          `Google auth error from navigation: ${error}`,
          "AuthHandlers",
          { errorDescription }
        );
        googleAuthService.rejectCodeDirectly(errorDescription || error);
        authCompleted = true;
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
      } else if (code) {
        logService.info(
          "Extracted Google auth code directly from navigation",
          "AuthHandlers"
        );
        googleAuthService.resolveCodeDirectly(code);
        authCompleted = true;
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
      }
    };

    // Use will-navigate to intercept the callback
    authWindow.webContents.on(
      "will-navigate",
      (event: ElectronEvent, url: string) => {
        if (url.startsWith("http://localhost:3001/callback")) {
          event.preventDefault();
          handleGoogleCallbackUrl(url);
        }
      }
    );

    // Also handle will-redirect as a fallback
    authWindow.webContents.on(
      "will-redirect",
      (event: ElectronEvent, url: string) => {
        if (url.startsWith("http://localhost:3001/callback")) {
          event.preventDefault();
          handleGoogleCallbackUrl(url);
        }
      }
    );

    // Process login in background after code is received
    setTimeout(async () => {
      try {
        // Wrap the code promise with a timeout (matches Microsoft pattern)
        const timeoutMs = 120000; // 2 minutes
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
        await logService.info("Received Google authorization code, completing login", "AuthHandlers");

        // Retrieve and clear the PKCE code verifier
        const storedCodeVerifier = pendingCodeVerifiers.get("login");
        pendingCodeVerifiers.delete("login");

        // Exchange code for tokens (PKCE: codeVerifier required)
        const { tokens, userInfo } = await googleAuthService.exchangeCodeForTokens(code, storedCodeVerifier);

        // BACKLOG-390: Sign in with Supabase Auth for RLS support
        // This creates a Supabase session so auth.uid() works in RLS policies
        if (tokens.id_token) {
          await supabaseService.signInWithIdToken("google", tokens.id_token);
        }

        // Sync user to Supabase
        const cloudUser = await supabaseService.syncUser({
          email: userInfo.email,
          first_name: userInfo.given_name,
          last_name: userInfo.family_name,
          display_name: userInfo.name,
          avatar_url: userInfo.picture,
          oauth_provider: "google",
          oauth_id: userInfo.id,
        });

        // Check if database is initialized
        if (!databaseService.isInitialized()) {
          await logService.info(
            "Database not initialized - deferring user creation",
            "AuthHandlers"
          );
          // Validate subscription for pending login
          const pendingSubscription = await supabaseService.validateSubscription(cloudUser.id);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("google:login-pending", {
              success: true,
              pendingLogin: true,
              oauthData: {
                provider: "google" as const,
                userInfo,
                tokens: {
                  access_token: tokens.access_token,
                  refresh_token: tokens.refresh_token ?? null,
                  expires_at: tokens.expires_at ?? new Date(Date.now() + 3600 * 1000).toISOString(),
                  scopes: tokens.scopes ?? [],
                },
                cloudUser,
                subscription: pendingSubscription ?? undefined,
              },
            });
          }
          return;
        }

        // Create or find user in local database
        let localUser = await databaseService.getUserByOAuthId("google", userInfo.id);
        const isNewUser = !localUser;

        if (!localUser) {
          // TASK-1507G: Use Supabase Auth UUID as local user ID for unified IDs
          localUser = await databaseService.createUser({
            id: cloudUser.id,
            email: userInfo.email,
            first_name: userInfo.given_name,
            last_name: userInfo.family_name,
            display_name: userInfo.name,
            avatar_url: userInfo.picture,
            oauth_provider: "google",
            oauth_id: userInfo.id,
            subscription_tier: cloudUser.subscription_tier,
            subscription_status: cloudUser.subscription_status,
            trial_ends_at: cloudUser.trial_ends_at,
            is_active: true,
          });
        }

        // Create session
        const sessionToken = await databaseService.createSession(localUser.id);

        // Save session to disk for persistence across app restarts
        await sessionService.saveSession({
          user: localUser,
          sessionToken,
          provider: "google",
          expiresAt: Date.now() + sessionService.getSessionExpirationMs(),
          createdAt: Date.now(),
        });

        // Determine subscription status
        const subscription = {
          tier: cloudUser.subscription_tier || localUser.subscription_tier || "free",
          status: cloudUser.subscription_status || localUser.subscription_status || "trialing",
          trial_ends_at: cloudUser.trial_ends_at || localUser.trial_ends_at,
        };

        // Check if new terms need acceptance
        const needsTermsUpdate = isNewUser ? false : needsToAcceptTerms(localUser);

        await logService.info("Google login completed successfully", "AuthHandlers", {
          userId: localUser.id,
          isNewUser,
          needsTermsUpdate,
        });

        // Send success event to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("google:login-complete", {
            success: true,
            user: {
              id: localUser.id,
              email: localUser.email,
              display_name: localUser.display_name,
              avatar_url: localUser.avatar_url,
            },
            sessionToken,
            subscription,
            isNewUser: isNewUser || needsTermsUpdate,
          });
        }
      } catch (error) {
        await logService.error("Google login completion failed", "AuthHandlers", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("google:login-complete", {
            success: false,
            error: error instanceof Error ? error.message : "Login failed",
          });
        }
      }
    }, 0);

    return {
      success: true,
      authUrl,
      scopes,
    };
  } catch (error) {
    await logService.error("Google login failed", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Google Auth: Complete login with authorization code
 */
export async function handleGoogleCompleteLogin(
  _event: Electron.IpcMainInvokeEvent,
  authCode: string
): Promise<LoginCompleteResponse> {
  try {
    await logService.info("Completing Google login", "AuthHandlers");

    // Validate input
    const validatedAuthCode = validateAuthCode(authCode);

    // Retrieve and clear the PKCE code verifier stored by handleGoogleLogin()
    const codeVerifier = pendingCodeVerifiers.get("login");
    pendingCodeVerifiers.delete("login");

    // Exchange code for tokens (PKCE: codeVerifier required)
    const { tokens, userInfo } =
      await googleAuthService.exchangeCodeForTokens(validatedAuthCode, codeVerifier);

    // BACKLOG-390: Sign in with Supabase Auth for RLS support
    if (tokens.id_token) {
      await supabaseService.signInWithIdToken("google", tokens.id_token);
    }

    // Session-only OAuth: no keychain encryption needed
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token || null;

    // Sync user to Supabase
    const cloudUser = await supabaseService.syncUser({
      email: userInfo.email,
      first_name: userInfo.given_name,
      last_name: userInfo.family_name,
      display_name: userInfo.name,
      avatar_url: userInfo.picture,
      oauth_provider: "google",
      oauth_id: userInfo.id,
    });

    // Create user in local database
    let localUser = await databaseService.getUserByOAuthId(
      "google",
      userInfo.id
    );

    if (!localUser) {
      // TASK-1507G: Use Supabase Auth UUID as local user ID for unified IDs
      localUser = await databaseService.createUser({
        id: cloudUser.id,
        email: userInfo.email,
        first_name: userInfo.given_name,
        last_name: userInfo.family_name,
        display_name: userInfo.name,
        avatar_url: userInfo.picture,
        oauth_provider: "google",
        oauth_id: userInfo.id,
        subscription_tier: cloudUser.subscription_tier,
        subscription_status: cloudUser.subscription_status,
        trial_ends_at: cloudUser.trial_ends_at,
        is_active: true,
      });
    } else {
      // Update existing user - sync profile AND user state from cloud
      await databaseService.updateUser(localUser.id, {
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
        subscription_tier: cloudUser.subscription_tier,
        subscription_status: cloudUser.subscription_status,
      });

      // Bidirectional sync
      if (localUser.terms_accepted_at && !cloudUser.terms_accepted_at) {
        await logService.info(
          "Local user has accepted terms but cloud does not - syncing to cloud",
          "AuthHandlers"
        );
        try {
          await supabaseService.syncTermsAcceptance(
            cloudUser.id,
            localUser.terms_version_accepted || CURRENT_TERMS_VERSION,
            localUser.privacy_policy_version_accepted ||
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
        }
      }
    }

    // Update last login
    if (!localUser) {
      throw new Error("Local user is unexpectedly null after creation/update");
    }

    await databaseService.updateLastLogin(localUser.id);
    const refreshedUser = await databaseService.getUserById(localUser.id);
    if (!refreshedUser) {
      throw new Error("Failed to retrieve user after update");
    }
    localUser = refreshedUser;

    // Save auth token
    const scopesGranted = Array.isArray(tokens.scopes)
      ? tokens.scopes.join(" ")
      : tokens.scopes;

    await databaseService.saveOAuthToken(
      localUser.id,
      "google",
      "authentication",
      {
        access_token: accessToken,
        refresh_token: refreshToken ?? undefined,
        token_expires_at: tokens.expires_at ?? undefined,
        scopes_granted: scopesGranted,
      }
    );

    // Create session
    const sessionToken = await databaseService.createSession(localUser.id);

    // Save session to disk for persistence across app restarts
    await sessionService.saveSession({
      user: localUser,
      sessionToken,
      provider: "google",
      expiresAt: Date.now() + sessionService.getSessionExpirationMs(),
      createdAt: Date.now(),
    });

    // Validate subscription
    const subscription = await supabaseService.validateSubscription(
      cloudUser.id
    );

    // Register device
    const deviceInfo = {
      device_id: crypto.randomUUID(),
      device_name: os.hostname(),
      os: os.platform() + " " + os.release(),
      app_version: app.getVersion(),
    };
    await supabaseService.registerDevice(cloudUser.id, deviceInfo);

    // Track login event
    await supabaseService.trackEvent(
      cloudUser.id,
      "user_login",
      { provider: "google" },
      deviceInfo.device_id,
      app.getVersion()
    );

    await logService.info(
      "Google login completed successfully",
      "AuthHandlers",
      {
        userId: localUser.id,
        provider: "google",
      }
    );

    // Check if user needs to accept terms
    const isNewUser = needsToAcceptTerms(localUser);

    // Record successful login for rate limiting
    await rateLimitService.recordAttempt(localUser.email, true);

    // Audit log successful login
    await auditService.log({
      userId: localUser.id,
      sessionId: sessionToken,
      action: "LOGIN",
      resourceType: "SESSION",
      resourceId: sessionToken,
      metadata: { provider: "google", isNewUser },
      success: true,
    });

    return {
      success: true,
      user: localUser,
      sessionToken,
      subscription,
      isNewUser,
    };
  } catch (error) {
    await logService.error(
      "Google complete login failed",
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
 * Google Auth: Connect mailbox (Gmail access)
 */
export async function handleGoogleConnectMailbox(
  mainWindow: BrowserWindow | null,
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
    setTimeout(async () => {
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

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("google:mailbox-connected", {
              success: false,
              error: "Failed to save credentials. Please try logging in again.",
            });
          }
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

        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("google:mailbox-connected", {
            success: true,
            email: userInfo.email,
          });
        }

        // BACKLOG-1759: Now that the Google mailbox is connected, re-fire the
        // Google contact import for users who enabled it but have no Google
        // contacts yet. Fire-and-forget: this MUST NOT be awaited — an import
        // error must never surface as a failed connect. Google contacts also
        // require the contacts.readonly scope; syncProvider.canSync gates that
        // and reports reconnectRequired without throwing.
        void importEnabledEmptyContactSources(validatedUserId, ["google_contacts"])
          .then((importResults) => {
            const importedAny = importResults.some((r) => r.imported > 0);
            if (importedAny && mainWindow && !mainWindow.isDestroyed()) {
              // Refresh any open contact picker so the newly imported contacts appear.
              mainWindow.webContents.send("contacts:external-sync-complete");
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

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("google:mailbox-connected", {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
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
 * Google Auth: Connect mailbox pending (pre-DB onboarding flow)
 * Returns tokens instead of saving to DB
 */
export async function handleGoogleConnectMailboxPending(
  mainWindow: BrowserWindow | null,
  emailHint?: string
): Promise<PendingMailboxResponse> {
  try {
    await logService.info(
      "Starting Google mailbox connection (pending/pre-DB)",
      "AuthHandlers"
    );

    // Start auth flow
    const { authUrl, codePromise, codeVerifier } =
      await googleAuthService.authenticateForMailbox(emailHint);

    // Store codeVerifier for use after code is received
    pendingCodeVerifiers.set("mailbox-pending", codeVerifier);

    // Create a popup window
    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // webSecurity defaults to true - do not disable
      },
      autoHideMenuBar: true,
      title: "Connect to Gmail",
    });

    // Strip CSP headers
    const filter = {
      urls: [
        "*://*.google.com/*",
        "*://*.googleapis.com/*",
        "*://*.gstatic.com/*",
        "*://*.googleusercontent.com/*",
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
        googleAuthService.stopLocalServer();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("google:mailbox-pending-cancelled");
        }
      }
    });

    const handleGoogleCallbackUrl = (callbackUrl: string) => {
      const parsedUrl = new URL(callbackUrl);
      const code = parsedUrl.searchParams.get("code");
      const error = parsedUrl.searchParams.get("error");
      const errorDescription = parsedUrl.searchParams.get("error_description");

      if (error) {
        googleAuthService.rejectCodeDirectly(errorDescription || error);
        authCompleted = true;
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
      } else if (code) {
        googleAuthService.resolveCodeDirectly(code);
        authCompleted = true;
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
      }
    };

    authWindow.webContents.on(
      "will-navigate",
      (event: ElectronEvent, url: string) => {
        if (url.startsWith("http://localhost:3001/callback")) {
          event.preventDefault();
          handleGoogleCallbackUrl(url);
        }
      }
    );

    authWindow.webContents.on(
      "will-redirect",
      (event: ElectronEvent, url: string) => {
        if (url.startsWith("http://localhost:3001/callback")) {
          event.preventDefault();
          handleGoogleCallbackUrl(url);
        }
      }
    );

    // Wait for code and return tokens
    const code = await codePromise;
    authCompleted = true;

    // Retrieve and clear the PKCE code verifier
    const storedCodeVerifier = pendingCodeVerifiers.get("mailbox-pending");
    pendingCodeVerifiers.delete("mailbox-pending");

    const { tokens } = await googleAuthService.exchangeCodeForTokens(code, storedCodeVerifier);
    const userInfo = await googleAuthService.getUserInfo(tokens.access_token);

    await logService.info(
      "Google mailbox pending connection completed",
      "AuthHandlers",
      { email: userInfo.email }
    );

    return {
      success: true,
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
        expiresAt: tokens.expires_at ?? undefined,
        scopesGranted: Array.isArray(tokens.scopes)
          ? tokens.scopes.join(" ")
          : tokens.scopes,
        connectedEmailAddress: userInfo.email,
        provider: "google",
      },
    };
  } catch (error) {
    await logService.error(
      "Google mailbox pending connection failed",
      "AuthHandlers",
      {
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
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
  mainWindow: BrowserWindow | null
): void {
  // Google Auth - Login
  ipcMain.handle("auth:google:login", () => handleGoogleLogin(mainWindow));
  ipcMain.handle("auth:google:complete-login", handleGoogleCompleteLogin);

  // Google Auth - Mailbox Connection
  ipcMain.handle("auth:google:connect-mailbox", (_event, userId: string) =>
    handleGoogleConnectMailbox(mainWindow, userId)
  );

  // Google Auth - Mailbox Pending (pre-DB)
  ipcMain.handle(
    "auth:google:connect-mailbox-pending",
    (_event, emailHint?: string) =>
      handleGoogleConnectMailboxPending(mainWindow, emailHint)
  );
}
