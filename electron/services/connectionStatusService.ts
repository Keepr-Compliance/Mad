/**
 * Connection Status Service
 * Monitor OAuth connections to Google and Microsoft
 */

import databaseService from "./databaseService";
import googleAuthService from "./googleAuthService";
import microsoftAuthService from "./microsoftAuthService";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import { net } from "electron";
import { OAuthToken } from "../types/models";
import {
  providerUnreachableHelp,
  providerUnreachableMessage,
  UNREACHABLE_STREAK_THRESHOLD,
  type RefreshAccessTokenResult,
} from "./oauthRefreshFailure";

type MailboxProvider = "google" | "microsoft";

/**
 * BACKLOG-3954: consecutive refreshes that could not reach one provider.
 * Kept in the main process so every caller of the connection check shares it
 * and a renderer remount does not reset it. In memory only: a restart starts
 * a new streak.
 */
interface UnreachableStreak {
  /** The user the streak belongs to; a different user starts over. */
  userId: string | null;
  count: number;
  /** Date.now() of the first failure in the streak. */
  since: number | null;
  /** The once-per-streak Sentry report has been sent. */
  reported: boolean;
}

function emptyStreak(): UnreachableStreak {
  return { userId: null, count: 0, since: null, reported: false };
}

/**
 * BACKLOG-3954: while the computer reports no network at all, the offline
 * banner already says so; the streak must not advance under it. Fails toward
 * "online" when Electron cannot answer.
 */
function isNetOnline(): boolean {
  try {
    return typeof net?.isOnline === "function" ? net.isOnline() : true;
  } catch {
    return true;
  }
}

/**
 * Connection error types
 */
export type ConnectionErrorType =
  | "NOT_CONNECTED"
  | "TOKEN_EXPIRED"
  | "TOKEN_REFRESH_FAILED"
  | "CONNECTION_CHECK_FAILED"
  // BACKLOG-3799: refresh could not reach the provider; connection kept.
  // Deliberately NOT a broken-token type (no Reconnect banner).
  | "PROVIDER_UNREACHABLE";

/**
 * Connection error details
 */
export interface ConnectionError {
  type: ConnectionErrorType;
  userMessage: string;
  action: string;
  actionHandler: string;
  details?: string;
  /**
   * BACKLOG-3954: PROVIDER_UNREACHABLE only. True once the failure streak has
   * passed UNREACHABLE_STREAK_THRESHOLD; the health banner shows the row only
   * then. Settings -> Email shows the error on every failure, as before.
   */
  persistent?: boolean;
}

/**
 * Connection status for a single provider
 */
export interface ProviderConnectionStatus {
  connected: boolean;
  lastCheck: number | null;
  email?: string;
  error: ConnectionError | null;
  /**
   * BACKLOG-2142: ISO timestamp of the last SUCCESSFUL email sync for this
   * provider (from oauth_tokens.last_sync_at). Set on every branch where a
   * token row exists (connected AND broken-token); omitted (null) for
   * NOT_CONNECTED. Consumed electron-side to compose a "No email captured
   * since <date>" reconnect subtitle — a display value, not a discriminator.
   */
  lastSyncAt?: string | null;
}

/**
 * All connection statuses
 */
export interface AllConnectionStatuses {
  google: ProviderConnectionStatus;
  microsoft: ProviderConnectionStatus;
  allConnected: boolean;
  anyConnected: boolean;
}

/**
 * Formatted user error
 */
interface FormattedUserError {
  title: string;
  message: string;
  action: string;
  actionHandler: string;
  details?: string;
  severity: "info" | "warning";
}

class ConnectionStatusService {
  private connectionStatus: {
    google: ProviderConnectionStatus;
    microsoft: ProviderConnectionStatus;
  };

  private unreachableStreaks: Record<MailboxProvider, UnreachableStreak> = {
    google: emptyStreak(),
    microsoft: emptyStreak(),
  };

  constructor() {
    this.connectionStatus = {
      google: { connected: false, lastCheck: null, error: null },
      microsoft: { connected: false, lastCheck: null, error: null },
    };
  }

  /** BACKLOG-3954: end the provider's failure streak (any outcome but unreachable). */
  private resetStreak(provider: MailboxProvider): void {
    this.unreachableStreaks[provider] = emptyStreak();
  }

  /**
   * BACKLOG-3954: end every streak. Called on sign-out, so the next user on
   * this profile starts from zero.
   */
  resetUnreachableStreaks(): void {
    this.resetStreak("google");
    this.resetStreak("microsoft");
  }

  /** BACKLOG-3954: a check for a different user than the streak's starts over. */
  private beginCheck(provider: MailboxProvider, userId: string): void {
    const streak = this.unreachableStreaks[provider];
    if (streak.userId !== null && streak.userId !== userId) this.resetStreak(provider);
  }

  /**
   * BACKLOG-3954: count one refresh that could not reach the provider, and say
   * whether the streak is now long enough for the health banner. Sends one
   * Sentry message when the streak first gets there.
   */
  private recordUnreachable(
    provider: MailboxProvider,
    userId: string,
    result: RefreshAccessTokenResult,
  ): boolean {
    const online = isNetOnline();
    const streak = this.unreachableStreaks[provider];
    const now = Date.now();
    if (online) {
      if (streak.count === 0) {
        streak.since = now;
        streak.userId = userId;
      }
      streak.count += 1;
    }
    const persistent =
      online &&
      streak.since !== null &&
      streak.count >= UNREACHABLE_STREAK_THRESHOLD.failures &&
      now - streak.since >= UNREACHABLE_STREAK_THRESHOLD.minMs;
    if (persistent && !streak.reported) {
      streak.reported = true;
      Sentry.captureMessage("Mailbox token refresh unreachable", {
        level: "warning",
        tags: {
          service: "connection-status",
          provider,
          causeCode: result.cause?.causeCode ?? "OTHER",
          tlsIntercept: result.cause?.tlsIntercept ?? false,
        },
        fingerprint: ["mailbox-refresh-unreachable", provider],
      });
    }
    return persistent;
  }

  /**
   * BACKLOG-2142: read the last SUCCESSFUL email-sync timestamp for a provider
   * (oauth_tokens.last_sync_at) as an ISO string, or null if never synced.
   * Best-effort — a read failure must NOT break the connection check, so it
   * returns null and logs rather than throwing.
   */
  private async getLastSyncAt(
    userId: string,
    provider: "google" | "microsoft",
  ): Promise<string | null> {
    try {
      const syncTime = await databaseService.getOAuthTokenSyncTime(userId, provider);
      return syncTime ? syncTime.toISOString() : null;
    } catch (error) {
      logService.warn(
        "[ConnectionStatus] Failed to read last sync time",
        "ConnectionStatus",
        { provider, error: error instanceof Error ? error.message : "Unknown error" },
      );
      return null;
    }
  }

  /**
   * Check Google OAuth connection status
   * @param userId
   * @returns Connection status
   */
  async checkGoogleConnection(
    userId: string,
  ): Promise<ProviderConnectionStatus> {
    this.beginCheck("google", userId);
    try {
      // Get Google auth token from database
      const token: OAuthToken | null = await databaseService.getOAuthToken(
        userId,
        "google",
        "mailbox",
      );

      if (!token || !token.access_token) {
        this.resetStreak("google");
        this.connectionStatus.google = {
          connected: false,
          lastCheck: Date.now(),
          error: {
            type: "NOT_CONNECTED",
            userMessage: "Gmail is not connected",
            action: "Connect your Gmail account to access emails",
            actionHandler: "connect-google",
          },
        };
        return this.connectionStatus.google;
      }

      // BACKLOG-2142: a token row exists, so surface the last successful email
      // sync time (from oauth_tokens.last_sync_at) on all remaining branches.
      const lastSyncAt = await this.getLastSyncAt(userId, "google");

      // Check if token is expired
      const tokenExpiry = new Date(token.token_expires_at || 0);
      const now = new Date();

      if (tokenExpiry < now) {
        // Token expired - try to refresh
        logService.info(
          "[ConnectionStatus] Google token expired, attempting refresh...",
          "ConnectionStatus",
        );
        try {
          const refreshResult =
            await googleAuthService.refreshAccessToken(userId);
          if (refreshResult.success) {
            logService.info(
              "[ConnectionStatus] Google token refreshed successfully",
              "ConnectionStatus",
            );
            this.resetStreak("google");
            this.connectionStatus.google = {
              connected: true,
              lastCheck: Date.now(),
              email: token.connected_email_address,
              error: null,
              lastSyncAt,
            };
            return this.connectionStatus.google;
          } else if (refreshResult.unreachable) {
            // BACKLOG-3799: Google could not be reached (network, antivirus
            // TLS inspection, 5xx). The stored grant is still good: keep the
            // connection and say what is wrong instead of "expired".
            logService.warn(
              "[ConnectionStatus] Google token refresh could not reach the provider",
              "ConnectionStatus",
              { error: refreshResult.error },
            );
            // BACKLOG-3954: no reconnect handler — reconnecting does not fix an
            // unreachable provider. `action` is the help text Settings -> Email
            // shows under the title; the health banner builds its own row.
            const persistent = this.recordUnreachable("google", userId, refreshResult);
            this.connectionStatus.google = {
              connected: true,
              lastCheck: Date.now(),
              email: token.connected_email_address,
              error: {
                type: "PROVIDER_UNREACHABLE",
                userMessage: providerUnreachableMessage("Google"),
                action: providerUnreachableHelp(),
                actionHandler: "",
                details: "Token refresh could not reach the provider",
                persistent,
              },
              lastSyncAt,
            };
            return this.connectionStatus.google;
          } else {
            logService.error(
              "[ConnectionStatus] Google token refresh failed:",
              "ConnectionStatus",
              { error: refreshResult.error },
            );
          }
        } catch (refreshError: any) {
          logService.error(
            "[ConnectionStatus] Google token refresh error:",
            "ConnectionStatus",
            { error: refreshError },
          );
          Sentry.captureException(refreshError, {
            tags: { service: "connection-status", operation: "checkGoogleConnection.refresh" },
          });
        }

        // Refresh failed, mark as expired but preserve email for UI
        this.resetStreak("google");
        this.connectionStatus.google = {
          connected: false,
          lastCheck: Date.now(),
          email: token.connected_email_address,
          error: {
            type: "TOKEN_REFRESH_FAILED",
            userMessage: "Your Gmail connection expired. Reconnect to keep capturing email.",
            // BACKLOG-2127: button label only ("Reconnect"). The full sentence
            // lives in userMessage (banner title); a separate subtitle would
            // just echo the button.
            action: "Reconnect",
            actionHandler: "reconnect-google",
            details: "Failed to refresh authentication token",
          },
          lastSyncAt,
        };
        return this.connectionStatus.google;
      }

      // Token is valid
      this.resetStreak("google");
      this.connectionStatus.google = {
        connected: true,
        lastCheck: Date.now(),
        email: token.connected_email_address,
        error: null,
        lastSyncAt,
      };
      return this.connectionStatus.google;
    } catch (error: unknown) {
      logService.error(
        "[ConnectionStatus] Error checking Google connection:",
        "ConnectionStatus",
        { error },
      );
      Sentry.captureException(error, {
        tags: { service: "connection-status", operation: "checkGoogleConnection" },
      });

      this.resetStreak("google");
      this.connectionStatus.google = {
        connected: false,
        lastCheck: Date.now(),
        error: {
          type: "CONNECTION_CHECK_FAILED",
          userMessage: "Could not verify Gmail connection",
          action: "Check your Gmail connection",
          actionHandler: "reconnect-google",
          details: error instanceof Error ? error.message : "Unknown error",
        },
      };
      return this.connectionStatus.google;
    }
  }

  /**
   * Check Microsoft OAuth connection status
   * @param userId
   * @returns Connection status
   */
  async checkMicrosoftConnection(
    userId: string,
  ): Promise<ProviderConnectionStatus> {
    this.beginCheck("microsoft", userId);
    try {
      // Get Microsoft auth token from database
      const token: OAuthToken | null = await databaseService.getOAuthToken(
        userId,
        "microsoft",
        "mailbox",
      );

      if (!token || !token.access_token) {
        this.resetStreak("microsoft");
        this.connectionStatus.microsoft = {
          connected: false,
          lastCheck: Date.now(),
          error: {
            type: "NOT_CONNECTED",
            userMessage: "Outlook is not connected",
            action: "Connect your Outlook account to access emails",
            actionHandler: "connect-microsoft",
          },
        };
        return this.connectionStatus.microsoft;
      }

      // BACKLOG-2142: a token row exists, so surface the last successful email
      // sync time (from oauth_tokens.last_sync_at) on all remaining branches.
      const lastSyncAt = await this.getLastSyncAt(userId, "microsoft");

      // Check if token is expired
      const tokenExpiry = new Date(token.token_expires_at || 0);
      const now = new Date();

      if (tokenExpiry < now) {
        // Token expired - try to refresh
        logService.info(
          "[ConnectionStatus] Microsoft token expired, attempting refresh...",
          "ConnectionStatus",
        );
        try {
          const refreshResult =
            await microsoftAuthService.refreshAccessToken(userId);
          if (refreshResult.success) {
            logService.info(
              "[ConnectionStatus] Microsoft token refreshed successfully",
              "ConnectionStatus",
            );
            this.resetStreak("microsoft");
            this.connectionStatus.microsoft = {
              connected: true,
              lastCheck: Date.now(),
              email: token.connected_email_address,
              error: null,
              lastSyncAt,
            };
            return this.connectionStatus.microsoft;
          } else if (refreshResult.unreachable) {
            // BACKLOG-3799: Microsoft could not be reached (network, antivirus
            // TLS inspection, 5xx). The stored grant is still good: keep the
            // connection and say what is wrong instead of "expired".
            logService.warn(
              "[ConnectionStatus] Microsoft token refresh could not reach the provider",
              "ConnectionStatus",
              { error: refreshResult.error },
            );
            // BACKLOG-3954: no reconnect handler — reconnecting does not fix an
            // unreachable provider. `action` is the help text Settings -> Email
            // shows under the title; the health banner builds its own row.
            const persistent = this.recordUnreachable("microsoft", userId, refreshResult);
            this.connectionStatus.microsoft = {
              connected: true,
              lastCheck: Date.now(),
              email: token.connected_email_address,
              error: {
                type: "PROVIDER_UNREACHABLE",
                userMessage: providerUnreachableMessage("Microsoft"),
                action: providerUnreachableHelp(),
                actionHandler: "",
                details: "Token refresh could not reach the provider",
                persistent,
              },
              lastSyncAt,
            };
            return this.connectionStatus.microsoft;
          } else {
            logService.error(
              "[ConnectionStatus] Microsoft token refresh failed:",
              "ConnectionStatus",
              { error: refreshResult.error },
            );
          }
        } catch (refreshError: any) {
          logService.error(
            "[ConnectionStatus] Microsoft token refresh error:",
            "ConnectionStatus",
            { error: refreshError },
          );
          Sentry.captureException(refreshError, {
            tags: { service: "connection-status", operation: "checkMicrosoftConnection.refresh" },
          });
        }

        // Refresh failed, mark as expired but preserve email for UI
        this.resetStreak("microsoft");
        this.connectionStatus.microsoft = {
          connected: false,
          lastCheck: Date.now(),
          email: token.connected_email_address,
          error: {
            type: "TOKEN_REFRESH_FAILED",
            userMessage: "Your Outlook connection expired. Reconnect to keep capturing email.",
            // BACKLOG-2127: button label only ("Reconnect"). The full sentence
            // lives in userMessage (banner title); a separate subtitle would
            // just echo the button.
            action: "Reconnect",
            actionHandler: "reconnect-microsoft",
            details: "Failed to refresh authentication token",
          },
          lastSyncAt,
        };
        return this.connectionStatus.microsoft;
      }

      // Token is valid
      this.resetStreak("microsoft");
      this.connectionStatus.microsoft = {
        connected: true,
        lastCheck: Date.now(),
        email: token.connected_email_address,
        error: null,
        lastSyncAt,
      };
      return this.connectionStatus.microsoft;
    } catch (error: unknown) {
      logService.error(
        "[ConnectionStatus] Error checking Microsoft connection:",
        "ConnectionStatus",
        { error },
      );
      Sentry.captureException(error, {
        tags: { service: "connection-status", operation: "checkMicrosoftConnection" },
      });

      this.resetStreak("microsoft");
      this.connectionStatus.microsoft = {
        connected: false,
        lastCheck: Date.now(),
        error: {
          type: "CONNECTION_CHECK_FAILED",
          userMessage: "Could not verify Outlook connection",
          action: "Check your Outlook connection",
          actionHandler: "reconnect-microsoft",
          details: error instanceof Error ? error.message : "Unknown error",
        },
      };
      return this.connectionStatus.microsoft;
    }
  }

  /**
   * Check all connections
   * @param userId
   * @returns All connection statuses
   */
  async checkAllConnections(userId: string): Promise<AllConnectionStatuses> {
    const [google, microsoft] = await Promise.all([
      this.checkGoogleConnection(userId),
      this.checkMicrosoftConnection(userId),
    ]);

    return {
      google,
      microsoft,
      allConnected: google.connected && microsoft.connected,
      anyConnected: google.connected || microsoft.connected,
    };
  }

  /**
   * Get cached connection status (avoid repeated database queries)
   * @param maxAge - Maximum cache age in milliseconds (default: 60 seconds)
   * @returns Cached status or null if expired
   */
  getCachedStatus(maxAge: number = 60000): AllConnectionStatuses | null {
    const googleAge = this.connectionStatus.google.lastCheck
      ? Date.now() - this.connectionStatus.google.lastCheck
      : Infinity;
    const microsoftAge = this.connectionStatus.microsoft.lastCheck
      ? Date.now() - this.connectionStatus.microsoft.lastCheck
      : Infinity;

    if (googleAge > maxAge || microsoftAge > maxAge) {
      return null;
    }

    return {
      google: this.connectionStatus.google,
      microsoft: this.connectionStatus.microsoft,
      allConnected:
        this.connectionStatus.google.connected &&
        this.connectionStatus.microsoft.connected,
      anyConnected:
        this.connectionStatus.google.connected ||
        this.connectionStatus.microsoft.connected,
    };
  }

  /**
   * Clear connection cache
   */
  clearCache(): void {
    // BACKLOG-3954: no production caller today (tests use it to isolate);
    // sign-out resets the streaks through resetUnreachableStreaks().
    this.resetUnreachableStreaks();
    this.connectionStatus = {
      google: { connected: false, lastCheck: null, error: null },
      microsoft: { connected: false, lastCheck: null, error: null },
    };
  }

  /**
   * Format error message for user display
   * @param error
   * @returns Formatted error
   */
  formatUserError(error: ConnectionError): FormattedUserError {
    return {
      title:
        error.type === "NOT_CONNECTED" ? "Not Connected" : "Connection Lost",
      message: error.userMessage,
      action: error.action,
      actionHandler: error.actionHandler,
      details: error.details,
      severity: error.type === "NOT_CONNECTED" ? "info" : "warning",
    };
  }
}

export default new ConnectionStatusService();
