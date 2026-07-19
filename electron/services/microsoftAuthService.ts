import * as Sentry from "@sentry/electron/main";
import axios, { AxiosError } from "axios";
import http from "http";
import url from "url";
import crypto from "crypto";
import databaseService from "./databaseService";
import logService from "./logService";

// ============================================
// TYPES & INTERFACES
// ============================================

interface AuthFlowResult {
  authUrl: string;
  codePromise: Promise<string>;
  codeVerifier: string;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  /** BACKLOG-390: ID token for Supabase Auth signInWithIdToken */
  id_token?: string;
}

interface UserInfo {
  id: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
}

interface MailboxInfo {
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

interface RevokeTokenResult {
  success: boolean;
  message: string;
}

// ============================================
// HELPERS
// ============================================

/**
 * Escape a string for safe interpolation into HTML.
 * Prevents reflected XSS when user-controlled data (e.g. error_description)
 * is rendered in an HTML response.
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================
// SERVICE CLASS
// ============================================

/**
 * Microsoft OAuth Service with Authorization Code Flow
 * Uses temporary local HTTP server to catch redirect
 * Better UX than device code flow - browser redirects back to app
 */
class MicrosoftAuthService {
  private clientId: string = "";
  private tenantId: string = "common";
  private redirectUri: string = "http://localhost:3000/callback";
  private authorizeUrl: string = "";
  private tokenUrl: string = "";
  private server: http.Server | null = null;
  private serverTimeout: NodeJS.Timeout | null = null;
  // Store resolve/reject functions to allow direct code resolution from navigation interception
  private codeResolver: ((code: string) => void) | null = null;
  private codeRejecter: ((error: Error) => void) | null = null;
  private initialized: boolean = false;
  /** BACKLOG-1121: Auth server timeout (5 minutes) to prevent port leak */
  private static readonly AUTH_TIMEOUT_MS = 5 * 60 * 1000;

  constructor() {
    // Lazy initialization - don't read env vars here
    // They may not be loaded yet in packaged builds
  }

  /**
   * Initialize the service by reading env vars
   * Called lazily on first use to ensure dotenv has loaded
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    this.clientId = process.env.MICROSOFT_CLIENT_ID || "";
    this.tenantId = process.env.MICROSOFT_TENANT_ID || "common";

    // Microsoft OAuth2 endpoints
    this.authorizeUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize`;
    this.tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;

    if (!this.clientId) {
      throw new Error("Microsoft OAuth credentials not configured");
    }

    this.initialized = true;
    logService.info("[MicrosoftAuth] Service initialized", "MicrosoftAuth");
  }

  /**
   * Ensure service is initialized before use
   */
  private _ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }

  /**
   * Resolve the authorization code directly from navigation interception
   * This bypasses the HTTP server round-trip for faster auth
   * @param code - The authorization code from the callback URL
   */
  resolveCodeDirectly(code: string): void {
    if (this.codeResolver) {
      logService.info(
        "[MicrosoftAuth] Resolving code directly from navigation interception",
        "MicrosoftAuth"
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
        "[MicrosoftAuth] Rejecting code directly from navigation interception",
        "MicrosoftAuth"
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
   * @returns Object with codePromise (resolves to auth code) and listeningPromise (resolves to assigned port)
   */
  startLocalServer(): { codePromise: Promise<string>; listeningPromise: Promise<number> } {
    // Stop any existing server before starting a new one
    // This prevents EADDRINUSE errors when user retries auth
    if (this.server) {
      logService.info(
        "[MicrosoftAuth] Stopping existing server before starting new one",
        "MicrosoftAuth"
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
          `[MicrosoftAuth] HTTP server received request: ${parsedUrl.pathname}`,
          "MicrosoftAuth"
        );

        if (parsedUrl.pathname === "/callback") {
          const code = parsedUrl.query.code as string | undefined;
          const error = parsedUrl.query.error as string | undefined;
          logService.info(
            `[MicrosoftAuth] Callback received via HTTP server - code: ${code ? "present" : "missing"}, error: ${error || "none"}`,
            "MicrosoftAuth"
          );

          if (error) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <!DOCTYPE html>
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
                    <p style="color: #4a5568; font-size: 1rem; margin: 0 0 1.5rem 0; line-height: 1.5;">${escapeHtml(String(parsedUrl.query.error_description || error))}</p>
                    <p style="color: #718096; font-size: 0.875rem; margin: 0;">You can close this window and try again.</p>
                  </div>
                </body>
              </html>
            `);
            this.stopLocalServer();
            reject(
              new Error((parsedUrl.query.error_description as string) || error),
            );
          } else if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <!DOCTYPE html>
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
                    <p id="status-message" style="color: #4a5568; font-size: 1rem; margin: 0 0 1.5rem 0; line-height: 1.5;">You've been successfully authenticated with Microsoft.</p>
                    <p id="close-message" style="color: #718096; font-size: 0.875rem; margin: 0 0 1rem 0;">Attempting to close this window...</p>
                    <button id="return-button" style="display: none; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 0.75rem 2rem; border-radius: 0.5rem; font-size: 1rem; font-weight: 600; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">Return to Application</button>
                  </div>
                  <script>
                    // Try to close the window
                    setTimeout(() => {
                      window.close();

                      // If window didn't close (we're still here after 500ms), show fallback
                      setTimeout(() => {
                        const closeMsg = document.getElementById('close-message');
                        const returnBtn = document.getElementById('return-button');

                        closeMsg.innerHTML = 'Please return to the application to continue.';
                        closeMsg.style.color = '#4a5568';
                        closeMsg.style.fontSize = '1rem';
                        closeMsg.style.marginBottom = '1.5rem';
                        returnBtn.style.display = 'inline-block';

                        returnBtn.onclick = () => {
                          // Use the app's deep link protocol to bring it to focus
                          window.location.href = 'keepr://focus';
                          // Also try to close the tab
                          setTimeout(() => window.close(), 300);
                        };
                      }, 500);
                    }, 2000);
                  </script>
                </body>
              </html>
            `);
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
          `[MicrosoftAuth] Local callback server listening on http://localhost:${port}`,
          "MicrosoftAuth"
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
          "[MicrosoftAuth] Auth server timed out after 5 minutes — closing",
          "MicrosoftAuth"
        );
        const rejecter = this.codeRejecter;
        this.stopLocalServer();
        if (rejecter) {
          rejecter(new Error("OAuth authentication timed out after 5 minutes"));
        }
      }, MicrosoftAuthService.AUTH_TIMEOUT_MS);
    });

    return { codePromise, listeningPromise };
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
   * Stop the local HTTP server
   */
  stopLocalServer(): void {
    this._clearAuthTimeout();
    if (this.server) {
      this.server.close();
      this.server = null;
      logService.info("[MicrosoftAuth] Local callback server stopped", "MicrosoftAuth");
    }
  }

  /**
   * Step 1: Authenticate for Login (minimal scopes)
   * Opens browser, user logs in, redirects back to local server
   */
  async authenticateForLogin(): Promise<AuthFlowResult> {
    this._ensureInitialized();
    const scopes = [
      "openid",
      "profile",
      "email",
      "User.Read",
      "offline_access",
    ];

    // Generate PKCE challenge (optional but recommended)
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    // BACKLOG-1121: Start server first to get dynamic port, then build auth URL
    const { codePromise, listeningPromise } = this.startLocalServer();
    await listeningPromise;

    // Build authorization URL with dynamically assigned redirect URI
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      scope: scopes.join(" "),
      response_mode: "query",
      prompt: "select_account", // Show account picker, only consent if needed
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authUrl = `${this.authorizeUrl}?${params.toString()}`;

    return {
      authUrl,
      codePromise,
      codeVerifier,
      scopes,
    };
  }

  /**
   * Step 2: Authenticate for Mailbox Access
   * Requests full mailbox permissions
   * @param loginHint - User email to pre-fill
   */
  async authenticateForMailbox(loginHint?: string): Promise<AuthFlowResult> {
    this._ensureInitialized();
    const scopes = [
      "openid",
      "profile",
      "email",
      "User.Read",
      "Mail.Read",
      "Contacts.Read",
      "offline_access",
    ];

    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    // Start local server to catch redirect (port 0 = OS-assigned)
    const { codePromise, listeningPromise } = this.startLocalServer();

    // Wait for the server to start listening so redirectUri has the dynamic port
    await listeningPromise;

    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      scope: scopes.join(" "),
      response_mode: "query",
      prompt: "select_account",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    if (loginHint) {
      params.append("login_hint", loginHint);
    }

    const authUrl = `${this.authorizeUrl}?${params.toString()}`;

    return {
      authUrl,
      codePromise,
      codeVerifier,
      scopes,
    };
  }

  /**
   * Exchange authorization code for tokens
   * @param code - Authorization code from OAuth flow
   * @param codeVerifier - PKCE code verifier
   */
  async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<TokenResponse> {
    this._ensureInitialized();
    try {
      const params = new URLSearchParams({
        client_id: this.clientId,
        code: code,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      });

      const response = await axios.post(this.tokenUrl, params.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logService.error(
        "Error exchanging code for tokens",
        "MicrosoftAuth",
        { error: axiosError.response?.data || axiosError.message }
      );
      Sentry.captureException(error, { tags: { service: "microsoft-auth", operation: "exchangeCodeForTokens" } });
      throw new Error(
        (axiosError.response?.data as any)?.error_description ||
          "Failed to exchange authorization code",
      );
    }
  }

  /**
   * Get user information from Microsoft Graph API
   * @param accessToken - Access token
   */
  async getUserInfo(accessToken: string): Promise<UserInfo> {
    try {
      const response = await axios.get("https://graph.microsoft.com/v1.0/me", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const user = response.data;

      return {
        id: user.id,
        email: user.mail || user.userPrincipalName,
        name: user.displayName,
        given_name: user.givenName,
        family_name: user.surname,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      logService.error(
        "Error getting user info",
        "MicrosoftAuth",
        { error: axiosError.response?.data || axiosError.message }
      );
      Sentry.captureException(error, { tags: { service: "microsoft-auth", operation: "getUserInfo" } });
      throw new Error("Failed to get user information");
    }
  }

  /**
   * Refresh access token using refresh token
   * @param refreshToken - Refresh token
   */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    this._ensureInitialized();
    try {
      const params = new URLSearchParams({
        client_id: this.clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });

      const response = await axios.post(this.tokenUrl, params.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError<{ error?: string; error_description?: string }>;
      logService.error(
        "Error refreshing token",
        "MicrosoftAuth",
        { error: axiosError.response?.data || axiosError.message }
      );
      Sentry.captureException(error, { tags: { service: "microsoft-auth", operation: "refreshToken" } });
      // BACKLOG-2127: preserve the HTTP status and OAuth error code (e.g.
      // invalid_grant on a dead refresh token) so isTokenExpiryError can
      // classify it — matching Google's raw-rethrow behaviour. Previously the
      // generic "Failed to refresh access token" message stripped this signal.
      const status = axiosError.response?.status;
      const oauthErrorCode = axiosError.response?.data?.error;
      const detail = [
        status ? `status ${status}` : null,
        oauthErrorCode ? `${oauthErrorCode}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const refreshError = new Error(
        `Failed to refresh access token${detail ? ` (${detail})` : ""}`,
      ) as Error & { status?: number };
      if (status !== undefined) refreshError.status = status;
      throw refreshError;
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
      logService.info("[MicrosoftAuth] Refreshing access token for user:", "MicrosoftAuth", { userId });

      // Get current token from database
      const tokenRecord = await databaseService.getOAuthToken(
        userId,
        "microsoft",
        "mailbox",
      );

      if (!tokenRecord || !tokenRecord.refresh_token) {
        logService.error("[MicrosoftAuth] No refresh token found for user", "MicrosoftAuth");
        return { success: false, error: "No refresh token available" };
      }

      // Session-only OAuth: tokens stored unencrypted in encrypted database
      const refreshToken = tokenRecord.refresh_token;

      // Call Microsoft to refresh the token
      const newTokens = await this.refreshToken(refreshToken);

      // Calculate new expiry time
      const expiresAt = new Date(
        Date.now() + newTokens.expires_in * 1000,
      ).toISOString();

      // Update database with new tokens (no encryption needed)
      await databaseService.saveOAuthToken(userId, "microsoft", "mailbox", {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || tokenRecord.refresh_token, // Keep old if new not provided
        token_expires_at: expiresAt,
        scopes_granted: newTokens.scope,
        connected_email_address: tokenRecord.connected_email_address,
        mailbox_connected: true,
      });

      logService.info(
        "[MicrosoftAuth] Token refreshed successfully. New expiry:",
        "MicrosoftAuth",
        { expiresAt }
      );

      return { success: true };
    } catch (error) {
      logService.error("[MicrosoftAuth] Failed to refresh access token", "MicrosoftAuth", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Revoke access token (logout)
   * @param accessToken - Access token to revoke
   */
  async revokeToken(_accessToken: string): Promise<RevokeTokenResult> {
    // Microsoft OAuth2 doesn't provide a revocation endpoint
    // For proper logout, direct user to: https://login.microsoftonline.com/common/oauth2/v2.0/logout
    logService.info(
      "Microsoft tokens cannot be revoked programmatically. User should sign out from Microsoft account.",
      "MicrosoftAuth"
    );
    return { success: true, message: "Token will expire naturally" };
  }

  /**
   * Get mailbox metadata (for testing connection)
   * @param accessToken - Access token with Mail.Read scope
   */
  async getMailboxInfo(accessToken: string): Promise<MailboxInfo> {
    try {
      const response = await axios.get(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      return {
        displayName: response.data.displayName,
        totalItemCount: response.data.totalItemCount,
        unreadItemCount: response.data.unreadItemCount,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      logService.error(
        "Error getting mailbox info",
        "MicrosoftAuth",
        { error: axiosError.response?.data || axiosError.message }
      );
      Sentry.captureException(error, { tags: { service: "microsoft-auth", operation: "getMailboxInfo" } });
      throw new Error("Failed to get mailbox information");
    }
  }
}

// Export singleton instance
export default new MicrosoftAuthService();
