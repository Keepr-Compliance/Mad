/**
 * Google Auth Service
 * Handles Google OAuth authentication using Authorization Code Flow with PKCE
 * Supports two-step consent: login (minimal scopes) + mailbox access (Gmail scopes)
 *
 * BACKLOG-733: Migrated from googleapis OAuth2Client to manual PKCE flow (RFC 8252)
 * PKCE is kept as defense-in-depth, but client_secret is still required because
 * Google's OAuth server requires it for ALL app types (including Desktop).
 * See: https://discuss.google.dev/t/authorization-code-flow-without-client-secret/168113
 *
 * Note: Environment variable GOOGLE_CLIENT_ID is loaded centrally in electron/main.ts
 * via dotenv. Do not import dotenv here.
 */

import * as Sentry from "@sentry/electron/main";
import axios, { AxiosError } from "axios";
import crypto from "crypto";
import http from "http";
import url from "url";
import databaseService from "./databaseService";
import logService from "./logService";
import type { MailboxRevokeReason } from "../types/ipc/window-api-auth";

// ============================================
// GOOGLE OAUTH2 ENDPOINTS
// ============================================

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * BACKLOG-3206: how long the revoke may hold up a disconnect.
 *
 * `electron/` calls axios bare — `git grep "axios.create\|axios.defaults" --
 * electron` returns nothing — so a request with no `timeout` inherits none and
 * waits on the OS TCP timeout. This call sits between the user pressing
 * Disconnect and the UI answering, so it gets an explicit bound.
 */
const REVOKE_TIMEOUT_MS = 5000;

// ============================================
// TYPES & INTERFACES
// ============================================

/**
 * BACKLOG-3206: the three states a Google revoke can end in. The wider union
 * the handler reports (`no-token`, `read-failed`, `unsupported`) describes
 * things that happen before or instead of this call, so they are not this
 * method's to return.
 */
export interface GoogleRevokeResult {
  outcome: "revoked" | "already-invalid" | "failed";
  /** Only set when `outcome` is `failed`. */
  reason?: MailboxRevokeReason;
  /** The HTTP status, when the server answered at all. */
  status?: number;
}

interface AuthFlowResult {
  authUrl: string;
  codePromise: Promise<string>;
  codeVerifier: string;
  scopes: string[];
}

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at: string | null;
  scopes: string[];
  /** BACKLOG-390: ID token for Supabase Auth signInWithIdToken */
  id_token?: string;
}

interface UserInfo {
  id: string;
  email: string;
  verified_email?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
}

interface TokenExchangeResult {
  tokens: TokenData;
  userInfo: UserInfo;
}

interface RefreshTokenResult {
  access_token: string;
  expires_at: string | null;
}

/** Raw token response from Google's token endpoint */
interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

// ============================================
// SERVICE CLASS
// ============================================

class GoogleAuthService {
  private clientId: string = "";
  private clientSecret: string = "";
  private initialized: boolean = false;
  private redirectUri: string = "http://localhost:3001/callback"; // Different port than Microsoft
  private server: http.Server | null = null;
  private serverTimeout: NodeJS.Timeout | null = null;
  // Store resolve/reject functions to allow direct code resolution from navigation interception
  private codeResolver: ((code: string) => void) | null = null;
  private codeRejecter: ((error: Error) => void) | null = null;
  /** BACKLOG-1121: Auth server timeout (5 minutes) to prevent port leak */
  private static readonly AUTH_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * Initialize Google OAuth2 configuration (PKCE + client_secret)
   * Google requires client_secret for all app types, including Desktop.
   * PKCE is kept as defense-in-depth.
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId) {
      logService.error(
        "[GoogleAuth] Missing GOOGLE_CLIENT_ID. Check .env.development file.",
        "GoogleAuth",
      );
      throw new Error("Google OAuth credentials not configured");
    }

    if (!clientSecret) {
      logService.error(
        "[GoogleAuth] Missing GOOGLE_CLIENT_SECRET. Check .env.development file.",
        "GoogleAuth",
      );
      throw new Error("Google OAuth credentials not configured");
    }

    logService.info(
      "[GoogleAuth] Initializing with client ID:",
      "GoogleAuth",
      { clientIdPrefix: clientId.substring(0, 20) + "..." },
    );

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.initialized = true;
    logService.debug("[GoogleAuth] Initialized successfully (PKCE + client_secret mode)", "GoogleAuth");
  }

  /**
   * Ensure service is initialized before use
   * @private
   */
  private _ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }

  /**
   * Generate PKCE code_verifier and code_challenge
   * @private
   * @returns Object with codeVerifier and codeChallenge
   */
  private _generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    return { codeVerifier, codeChallenge };
  }

  /**
   * Resolve the authorization code directly from navigation interception
   * This bypasses the HTTP server round-trip for faster auth
   * @param code - The authorization code from the callback URL
   */
  resolveCodeDirectly(code: string): void {
    if (this.codeResolver) {
      logService.info(
        "[GoogleAuth] Resolving code directly from navigation interception",
        "GoogleAuth",
      );
      this.codeResolver(code);
      this.codeResolver = null;
      this.codeRejecter = null;
      this.stopLocalServer();
    }
  }

  /**
   * Reject the authorization code directly (for errors from navigation)
   * @param error - The error message
   */
  rejectCodeDirectly(error: string): void {
    if (this.codeRejecter) {
      logService.info(
        "[GoogleAuth] Rejecting code directly from navigation interception",
        "GoogleAuth",
      );
      this.codeRejecter(new Error(error));
      this.codeResolver = null;
      this.codeRejecter = null;
      this.stopLocalServer();
    }
  }

  /**
   * Start a temporary local HTTP server to catch OAuth redirect.
   * BACKLOG-1121: Uses port 0 (OS-assigned) and 5-min timeout.
   * @returns Object with codePromise and listeningPromise (resolves to assigned port)
   */
  startLocalServer(): { codePromise: Promise<string>; listeningPromise: Promise<number> } {
    // Stop any existing server before starting a new one
    // This prevents EADDRINUSE errors when user retries auth
    if (this.server) {
      logService.info(
        "[GoogleAuth] Stopping existing server before starting new one",
        "GoogleAuth",
      );
      this.stopLocalServer();
    }

    let resolveListening: (port: number) => void;
    const listeningPromise = new Promise<number>((resolve) => {
      resolveListening = resolve;
    });

    const codePromise = new Promise<string>((resolve, reject) => {
      // Store resolve/reject for direct resolution from navigation interception
      this.codeResolver = resolve;
      this.codeRejecter = reject;

      this.server = http.createServer((req, res) => {
        const parsedUrl = url.parse(req.url || "", true);
        logService.info(
          `[GoogleAuth] HTTP server received request: ${parsedUrl.pathname}`,
          "GoogleAuth",
        );

        if (parsedUrl.pathname === "/callback") {
          const code = parsedUrl.query.code as string | undefined;
          const callbackError = parsedUrl.query.error as string | undefined;
          logService.info(
            `[GoogleAuth] Callback received via HTTP server - code: ${code ? "present" : "missing"}, error: ${callbackError || "none"}`,
            "GoogleAuth",
          );

          if (callbackError) {
            const errorDesc = (parsedUrl.query.error_description as string) || callbackError;
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(this._buildErrorPage(errorDesc));
            this.stopLocalServer();
            reject(new Error(errorDesc));
          } else if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(this._buildSuccessPage());
            this.stopLocalServer();
            resolve(code);
          } else {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                  <div style="text-align: center;">
                    <h1 style="color: #c33;">Invalid Request</h1>
                    <p style="color: #666;">No authorization code received.</p>
                  </div>
                </body>
              </html>
            `);
          }
        }
      });

      // BACKLOG-1121: Use port 0 for OS-assigned port to avoid EADDRINUSE
      this.server.listen(0, "localhost", () => {
        const addr = this.server!.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        // Update redirect URI with the actual assigned port
        this.redirectUri = `http://localhost:${port}/callback`;
        logService.info(
          `[GoogleAuth] Local callback server listening on http://localhost:${port}`,
          "GoogleAuth",
        );
        resolveListening!(port);
      });

      this.server.on("error", (err: Error) => {
        this._clearAuthTimeout();
        reject(err);
      });

      // BACKLOG-1121: 5-minute timeout to prevent port leak if user abandons auth
      this.serverTimeout = setTimeout(() => {
        logService.warn(
          "[GoogleAuth] Auth server timed out after 5 minutes — closing",
          "GoogleAuth",
        );
        const rejecter = this.codeRejecter;
        this.stopLocalServer();
        if (rejecter) {
          rejecter(new Error("OAuth authentication timed out after 5 minutes"));
        }
      }, GoogleAuthService.AUTH_TIMEOUT_MS);
    });

    return { codePromise, listeningPromise };
  }

  /**
   * Build HTML error page for OAuth callback
   * @private
   */
  private _buildErrorPage(errorMessage: string): string {
    // Escape HTML entities to prevent XSS from error descriptions
    const safeMessage = errorMessage
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Failed</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
    <div style="text-align: center; background: white; padding: 2rem 2rem; border-radius: 1rem; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 380px; margin: 1.5rem; box-sizing: border-box;">
      <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem;">
        <svg style="width: 48px; height: 48px; color: white;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </div>
      <h1 style="color: #1a202c; font-size: 1.875rem; font-weight: 700; margin: 0 0 1rem 0;">Authentication Failed</h1>
      <p style="color: #4a5568; font-size: 1rem; margin: 0 0 1.5rem 0; line-height: 1.5;">${safeMessage}</p>
      <p style="color: #718096; font-size: 0.875rem; margin: 0;">You can close this window and try again.</p>
    </div>
  </body>
</html>`;
  }

  /**
   * Build HTML success page for OAuth callback
   * @private
   */
  private _buildSuccessPage(): string {
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Successful</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
    <div style="text-align: center; background: white; padding: 2rem 2rem; border-radius: 1rem; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 380px; margin: 1.5rem; box-sizing: border-box;">
      <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem;">
        <svg style="width: 48px; height: 48px; color: white;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
        </svg>
      </div>
      <h1 style="color: #1a202c; font-size: 1.875rem; font-weight: 700; margin: 0 0 1rem 0;">Authentication Successful!</h1>
      <p id="status-message" style="color: #4a5568; font-size: 1rem; margin: 0 0 1.5rem 0; line-height: 1.5;">You have been successfully authenticated with Google.</p>
      <p id="close-message" style="color: #718096; font-size: 0.875rem; margin: 0 0 1rem 0;">Attempting to close this window...</p>
      <button id="return-button" style="display: none; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 0.75rem 2rem; border-radius: 0.5rem; font-size: 1rem; font-weight: 600; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: transform 0.2s;">Return to Application</button>
    </div>
    <script>
      setTimeout(function() {
        window.close();
        setTimeout(function() {
          var closeMsg = document.getElementById('close-message');
          var returnBtn = document.getElementById('return-button');
          if (closeMsg) closeMsg.textContent = 'Please return to the application to continue.';
          if (returnBtn) {
            returnBtn.style.display = 'inline-block';
            returnBtn.onclick = function() {
              window.location.href = 'keepr://focus';
              setTimeout(function() { window.close(); }, 300);
            };
          }
        }, 500);
      }, 2000);
    </script>
  </body>
</html>`;
  }

  /**
   * Clear the auth timeout timer
   * @private
   */
  private _clearAuthTimeout(): void {
    if (this.serverTimeout) {
      clearTimeout(this.serverTimeout);
      this.serverTimeout = null;
    }
  }

  /**
   * Stop the local HTTP server and clear timeout
   */
  stopLocalServer(): void {
    this._clearAuthTimeout();
    if (this.server) {
      this.server.close();
      this.server = null;
      logService.debug("[GoogleAuth] Local callback server stopped", "GoogleAuth");
    }
  }

  /**
   * Authenticate for login (minimal scopes)
   * Step 1: Get user into the app
   * Opens browser, user logs in, redirects back to local server
   */
  async authenticateForLogin(): Promise<AuthFlowResult> {
    this._ensureInitialized();

    const scopes = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ];

    try {
      logService.debug("[GoogleAuth] Starting login flow with minimal scopes (PKCE)", "GoogleAuth");

      // Generate PKCE challenge
      const { codeVerifier, codeChallenge } = this._generatePKCE();

      // BACKLOG-1121: Start server first to get dynamic port, then build auth URL
      const { codePromise, listeningPromise } = this.startLocalServer();
      await listeningPromise;

      // Build authorization URL with dynamically assigned redirect URI
      const params = new URLSearchParams({
        client_id: this.clientId,
        response_type: "code",
        redirect_uri: this.redirectUri,
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "select_account",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

      logService.debug("[GoogleAuth] Auth URL generated with PKCE, local server started", "GoogleAuth");

      return {
        authUrl,
        codePromise,
        codeVerifier,
        scopes,
      };
    } catch (error) {
      logService.error("[GoogleAuth] Login flow failed:", "GoogleAuth", { error });
      this.stopLocalServer();
      throw error;
    }
  }

  /**
   * Exchange authorization code for tokens using PKCE + client_secret
   * Google requires client_secret for all app types; PKCE is defense-in-depth.
   * @param code - Authorization code from OAuth callback
   * @param codeVerifier - PKCE code verifier from the auth flow
   * @returns Tokens and user info
   */
  async exchangeCodeForTokens(code: string, codeVerifier?: string): Promise<TokenExchangeResult> {
    this._ensureInitialized();

    try {
      logService.debug("[GoogleAuth] Exchanging code for tokens (PKCE + client_secret)", "GoogleAuth");

      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: code,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
      });

      // Include code_verifier for PKCE flow (defense-in-depth)
      if (codeVerifier) {
        params.append("code_verifier", codeVerifier);
      }

      const response = await axios.post<GoogleTokenResponse>(
        GOOGLE_TOKEN_URL,
        params.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      const tokenResponse = response.data;

      logService.debug("[GoogleAuth] Tokens obtained successfully", "GoogleAuth");

      // Get user info
      const userInfo = await this.getUserInfo(tokenResponse.access_token);

      return {
        tokens: {
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token ?? undefined,
          expires_at: tokenResponse.expires_in
            ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
            : null,
          scopes: tokenResponse.scope ? tokenResponse.scope.split(" ") : [],
          // BACKLOG-390: Include ID token for Supabase Auth
          id_token: tokenResponse.id_token ?? undefined,
        },
        userInfo,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      logService.error("[GoogleAuth] Code exchange failed:", "GoogleAuth", {
        error: axiosError.response?.data || axiosError.message || error,
      });
      Sentry.captureException(error, { tags: { service: "google-auth", operation: "exchangeCodeForTokens" } });
      throw error;
    }
  }

  /**
   * Authenticate for mailbox access (Gmail scopes)
   * Step 2: Connect to Gmail (incremental consent)
   * Opens browser, user grants Gmail access, redirects back to local server
   * @param loginHint - Optional email to pre-fill
   */
  async authenticateForMailbox(loginHint?: string): Promise<AuthFlowResult> {
    this._ensureInitialized();

    const scopes = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
    ];

    try {
      logService.debug("[GoogleAuth] Starting mailbox connection flow (PKCE)", "GoogleAuth");

      // Generate PKCE challenge
      const { codeVerifier, codeChallenge } = this._generatePKCE();

      // BACKLOG-1121: Start server first to get dynamic port, then build auth URL
      const { codePromise, listeningPromise } = this.startLocalServer();
      await listeningPromise;

      // Build authorization URL with dynamically assigned redirect URI
      const params = new URLSearchParams({
        client_id: this.clientId,
        response_type: "code",
        redirect_uri: this.redirectUri,
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "select_account", // Show account picker, only consent if needed
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      if (loginHint) {
        params.append("login_hint", loginHint);
      }

      const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

      logService.info(
        "[GoogleAuth] Mailbox auth URL generated with PKCE, local server started",
        "GoogleAuth",
      );

      return {
        authUrl,
        codePromise,
        codeVerifier,
        scopes,
      };
    } catch (error) {
      logService.error("[GoogleAuth] Mailbox flow failed:", "GoogleAuth", { error });
      this.stopLocalServer();
      throw error;
    }
  }

  /**
   * Get user profile information via direct HTTP GET (no googleapis dependency)
   * @param accessToken - Access token
   * @returns User info
   */
  async getUserInfo(accessToken: string): Promise<UserInfo> {
    try {
      const response = await axios.get(GOOGLE_USERINFO_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const data = response.data;

      logService.debug("[GoogleAuth] User info retrieved:", "GoogleAuth", { email: data.email });

      return {
        id: data.id,
        email: data.email,
        verified_email: data.verified_email ?? undefined,
        name: data.name || undefined,
        given_name: data.given_name || undefined,
        family_name: data.family_name || undefined,
        picture: data.picture || undefined,
        locale: data.locale || undefined,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      logService.error("[GoogleAuth] Failed to get user info:", "GoogleAuth", {
        error: axiosError.response?.data || axiosError.message || error,
      });
      Sentry.captureException(error, { tags: { service: "google-auth", operation: "getUserInfo" } });
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token via HTTP POST (client_secret required)
   * @param refreshToken - Refresh token
   * @returns New tokens
   */
  async refreshToken(refreshToken: string): Promise<RefreshTokenResult> {
    this._ensureInitialized();

    try {
      logService.info("[GoogleAuth] Refreshing access token", "GoogleAuth");

      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });

      const response = await axios.post<GoogleTokenResponse>(
        GOOGLE_TOKEN_URL,
        params.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      const tokenResponse = response.data;

      logService.info("[GoogleAuth] Token refreshed successfully", "GoogleAuth");

      return {
        access_token: tokenResponse.access_token,
        expires_at: tokenResponse.expires_in
          ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
          : null,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      logService.error("[GoogleAuth] Token refresh failed:", "GoogleAuth", {
        error: axiosError.response?.data || axiosError.message || error,
      });
      Sentry.captureException(error, { tags: { service: "google-auth", operation: "refreshToken" } });
      throw error;
    }
  }

  /**
   * Refresh access token for a user (high-level method with database integration)
   * @param userId - User ID to refresh token for
   * @returns Success status with new token data
   */
  async refreshAccessToken(
    userId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      logService.info("[GoogleAuth] Refreshing access token for user:", "GoogleAuth", { userId });

      // Get current token from database
      const tokenRecord = await databaseService.getOAuthToken(
        userId,
        "google",
        "mailbox",
      );

      if (!tokenRecord || !tokenRecord.refresh_token) {
        logService.error("[GoogleAuth] No refresh token found for user", "GoogleAuth");
        return { success: false, error: "No refresh token available" };
      }

      // Session-only OAuth: tokens stored unencrypted in encrypted database
      const currentRefreshToken = tokenRecord.refresh_token;

      // Call Google to refresh the token
      const newTokens = await this.refreshToken(currentRefreshToken);

      // Update database with new tokens (no encryption needed)
      // Note: Google typically doesn't return a new refresh token, so we keep the old one
      await databaseService.saveOAuthToken(userId, "google", "mailbox", {
        access_token: newTokens.access_token,
        refresh_token: tokenRecord.refresh_token, // Keep existing refresh token
        token_expires_at: newTokens.expires_at ?? undefined,
        scopes_granted: tokenRecord.scopes_granted, // Keep existing scopes
        connected_email_address: tokenRecord.connected_email_address,
        mailbox_connected: true,
      });

      logService.info(
        "[GoogleAuth] Token refreshed successfully. New expiry:",
        "GoogleAuth",
        { expiresAt: newTokens.expires_at },
      );

      return { success: true };
    } catch (error) {
      logService.error("[GoogleAuth] Failed to refresh access token:", "GoogleAuth", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Revoke tokens via HTTP POST to Google's revocation endpoint (no googleapis dependency)
   *
   * BACKLOG-3206: this used to resolve `void` on success and re-throw on any
   * failure, which gave the caller two states where there are four. The caller
   * has to tell the user what happened, and "Google says this token was already
   * dead" is a success for the user's purposes while "Google answered 429" is
   * not. So the outcome is classified here, where the response is, and the
   * method no longer throws.
   *
   * @param token - The refresh token where one exists, otherwise the access
   *   token. Google's endpoint accepts either.
   */
  async revokeToken(token: string): Promise<GoogleRevokeResult> {
    try {
      logService.info("[GoogleAuth] Revoking token", "GoogleAuth");

      await axios.post(
        GOOGLE_REVOKE_URL,
        new URLSearchParams({ token }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: REVOKE_TIMEOUT_MS,
        },
      );

      logService.info("[GoogleAuth] Token revoked successfully", "GoogleAuth");
      return { outcome: "revoked" };
    } catch (error) {
      const axiosError = error as AxiosError<{ error?: string }>;
      const status = axiosError.response?.status;
      const errorCode = axiosError.response?.data?.error;

      // `400 invalid_token` is Google saying the token is already dead. That is
      // the state we were asking it to reach, so it is not a failure — and
      // classifying it as one would show the user a warning about a grant that
      // is already gone.
      if (status === 400 && errorCode === "invalid_token") {
        logService.info(
          "[GoogleAuth] Token was already invalid; nothing left to revoke",
          "GoogleAuth",
        );
        return { outcome: "already-invalid", status };
      }

      // axios attaches `response` only when the server answered
      // (axios 1.18.1, lib/core/settle.js). Its absence is the transport
      // failing: timeout, DNS, connection reset.
      const reason: MailboxRevokeReason = axiosError.response
        ? "rejected"
        : "network";

      logService.error("[GoogleAuth] Token revocation failed:", "GoogleAuth", {
        reason,
        status,
        errorCode,
        error: axiosError.response?.data || axiosError.message || error,
      });

      // Transport failures are expected noise and are suppressed. An answer we
      // did not expect means our request shape is probably wrong, which is both
      // rare and actionable.
      if (reason === "rejected") {
        Sentry.captureException(error, {
          tags: {
            service: "google-auth-service",
            operation: "disconnectMailbox.revoke",
          },
          extra: { status, errorCode },
        });
      }

      return { outcome: "failed", reason, status };
    }
  }

  /**
   * Check if user is authenticated
   * @param accessToken - Access token to check
   * @returns True if authenticated
   */
  async isAuthenticated(accessToken: string): Promise<boolean> {
    if (!accessToken) {
      return false;
    }

    try {
      // Try to get user info - if it works, token is valid
      await this.getUserInfo(accessToken);
      return true;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export default new GoogleAuthService();
