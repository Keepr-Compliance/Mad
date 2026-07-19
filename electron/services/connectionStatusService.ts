/**
 * Connection Status Service
 * Monitor OAuth connections to Google and Microsoft
 */

import databaseService from "./databaseService";
import googleAuthService from "./googleAuthService";
import microsoftAuthService from "./microsoftAuthService";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import { OAuthToken } from "../types/models";

/**
 * Connection error types
 */
export type ConnectionErrorType =
  | "NOT_CONNECTED"
  | "TOKEN_EXPIRED"
  | "TOKEN_REFRESH_FAILED"
  | "CONNECTION_CHECK_FAILED";

/**
 * Connection error details
 */
export interface ConnectionError {
  type: ConnectionErrorType;
  userMessage: string;
  action: string;
  actionHandler: string;
  details?: string;
}

/**
 * Connection status for a single provider
 */
export interface ProviderConnectionStatus {
  connected: boolean;
  lastCheck: number | null;
  email?: string;
  error: ConnectionError | null;
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

  constructor() {
    this.connectionStatus = {
      google: { connected: false, lastCheck: null, error: null },
      microsoft: { connected: false, lastCheck: null, error: null },
    };
  }

  /**
   * Check Google OAuth connection status
   * @param userId
   * @returns Connection status
   */
  async checkGoogleConnection(
    userId: string,
  ): Promise<ProviderConnectionStatus> {
    try {
      // Get Google auth token from database
      const token: OAuthToken | null = await databaseService.getOAuthToken(
        userId,
        "google",
        "mailbox",
      );

      if (!token || !token.access_token) {
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
            this.connectionStatus.google = {
              connected: true,
              lastCheck: Date.now(),
              email: token.connected_email_address,
              error: null,
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
        };
        return this.connectionStatus.google;
      }

      // Token is valid
      this.connectionStatus.google = {
        connected: true,
        lastCheck: Date.now(),
        email: token.connected_email_address,
        error: null,
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
    try {
      // Get Microsoft auth token from database
      const token: OAuthToken | null = await databaseService.getOAuthToken(
        userId,
        "microsoft",
        "mailbox",
      );

      if (!token || !token.access_token) {
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
            this.connectionStatus.microsoft = {
              connected: true,
              lastCheck: Date.now(),
              email: token.connected_email_address,
              error: null,
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
        };
        return this.connectionStatus.microsoft;
      }

      // Token is valid
      this.connectionStatus.microsoft = {
        connected: true,
        lastCheck: Date.now(),
        email: token.connected_email_address,
        error: null,
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
