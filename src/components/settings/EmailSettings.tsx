import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNetwork } from '../../contexts/NetworkContext';
import {
  emitEmailConnectionChanged,
  useEmailConnectionListener,
} from "@/utils/emailConnectionEvents";
import { settingsService, authService } from '../../services';
import logger from '../../utils/logger';
import { safeErrorMessage } from '../../utils/formatUtils';
import { ResponsiveModal } from "../common/ResponsiveModal";
import type { Connections, ConnectionResult, PreferencesResult } from './types';

// Refresh interval for connection status (60 seconds)
const CONNECTION_REFRESH_INTERVAL = 60000;

type ForceSwapSummary = {
  emailsDeleted: number;
  emailsInserted: number;
  participantsInserted: number;
  providers: Array<"gmail" | "outlook">;
};

const MAILBOX_LABEL: Record<"gmail" | "outlook", string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

/**
 * BACKLOG-2856: what to tell the user after a force re-cache, derived from what
 * the swap actually did.
 *
 * Exported for test, and written as a pure function for the same reason: the
 * defect this replaces was a template string that asserted an unlink which, on
 * the decline-to-swap paths, never happened. A pure function can be driven
 * through every outcome directly, including the ones that need a provider to
 * fail mid-run.
 *
 * `forceSwap` absent means the swap did not commit. The caller only reaches this
 * on `success: true`, so that combination is not an error — it is the ordinary
 * "nothing needed replacing" case — and it must NOT claim an unlink.
 */
export function describeForceRecache(
  forceSwap: ForceSwapSummary | undefined,
  connections: Connections,
): string {
  if (!forceSwap) {
    return "Re-cache finished without replacing anything. Your emails and their transaction links are unchanged.";
  }

  const connected: Array<"gmail" | "outlook"> = [
    ...(connections.google?.connected ? (["gmail"] as const) : []),
    ...(connections.microsoft?.connected ? (["outlook"] as const) : []),
  ];
  const skipped = connected.filter((p) => !forceSwap.providers.includes(p));

  const headline = `Re-cached ${forceSwap.emailsInserted} email${
    forceSwap.emailsInserted === 1 ? "" : "s"
  }. Those emails were unlinked from their transactions.`;

  // A partial success is the case most likely to mislead: the count looks
  // healthy, and nothing on screen would otherwise say that a whole mailbox was
  // left untouched because it could not be re-downloaded.
  if (skipped.length > 0) {
    const names = skipped.map((p) => MAILBOX_LABEL[p]).join(" and ");
    return `${headline} ${names} could not be re-downloaded and ${
      skipped.length === 1 ? "was" : "were"
    } left unchanged — try again to re-cache ${skipped.length === 1 ? "it" : "them"}.`;
  }

  return headline;
}

interface EmailSettingsProps {
  userId: string;
  initialPreferences: PreferencesResult['preferences'];
  onEmailConnected?: (email: string, provider: "google" | "microsoft") => void;
  onEmailDisconnected?: (provider: "google" | "microsoft") => void;
  /** Report connection status changes to parent (for Contacts section) */
  onConnectionStatusChange?: (google: boolean, microsoft: boolean) => void;
}

export function EmailSettings({
  userId,
  initialPreferences,
  onEmailConnected,
  onEmailDisconnected,
  onConnectionStatusChange,
}: EmailSettingsProps) {
  const { isOnline } = useNetwork();

  // Connection state
  const [connections, setConnections] = useState<Connections>({ google: null, microsoft: null });
  const [loadingConnections, setLoadingConnections] = useState<boolean>(true);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [disconnectingProvider, setDisconnectingProvider] = useState<string | null>(null);

  // Email cache duration (TASK-2072)
  const [emailCacheDurationMonths, setEmailCacheDurationMonths] = useState<number>(() => {
    const val = initialPreferences?.emailCache?.durationMonths
      ?? initialPreferences?.emailSync?.lookbackMonths;
    return (typeof val === "number" && val > 0) ? val : 3;
  });

  // Check connections
  const checkConnections = useCallback(async (): Promise<{
    google?: { connected: boolean; email?: string };
    microsoft?: { connected: boolean; email?: string };
  } | null> => {
    setLoadingConnections(true);
    try {
      const result = await window.api.system.checkAllConnections(userId);
      if (result.success) {
        setConnections({
          google: result.google
            ? { connected: result.google.connected, email: result.google.email, error: result.google.error }
            : null,
          microsoft: result.microsoft
            ? { connected: result.microsoft.connected, email: result.microsoft.email, error: result.microsoft.error }
            : null,
        });
        return { google: result.google, microsoft: result.microsoft };
      }
      return null;
    } catch (error) {
      logger.error("Failed to check connections:", error);
      return null;
    } finally {
      setLoadingConnections(false);
    }
  }, [userId]);

  // Load connections on mount + periodic refresh
  useEffect(() => {
    if (userId) {
      checkConnections();
      const refreshInterval = setInterval(() => {
        checkConnections();
      }, CONNECTION_REFRESH_INTERVAL);
      return () => clearInterval(refreshInterval);
    }
  }, [userId, checkConnections]);

  // Report connection status changes to parent
  useEffect(() => {
    if (onConnectionStatusChange) {
      onConnectionStatusChange(
        connections.google?.connected ?? false,
        connections.microsoft?.connected ?? false,
      );
    }
  }, [connections.google?.connected, connections.microsoft?.connected, onConnectionStatusChange]);

  // Listen for email connection events from other components
  useEmailConnectionListener(
    useCallback(() => {
      checkConnections();
    }, [checkConnections])
  );

  // Connection handlers
  const handleConnectGoogle = async (): Promise<void> => {
    setConnectingProvider("google");
    let cleanup: (() => void) | undefined;
    try {
      const result = await authService.googleConnectMailbox(userId);
      if (result.success) {
        cleanup = authService.onMailboxConnected("google",
          async (connectionResult: ConnectionResult) => {
            if (connectionResult.success) {
              const connResult = await checkConnections();
              const email = connResult?.google?.email;
              if (email && onEmailConnected) {
                onEmailConnected(email, "google");
              }
              if (email) {
                emitEmailConnectionChanged({ connected: true, email, provider: "google" });
              }
            }
            setConnectingProvider(null);
            if (cleanup) cleanup();
          },
        );
      }
    } catch (error) {
      logger.error("Failed to connect Google:", error);
      setConnectingProvider(null);
    }
  };

  const handleConnectMicrosoft = async (): Promise<void> => {
    setConnectingProvider("microsoft");
    let cleanup: (() => void) | undefined;
    try {
      const result = await authService.microsoftConnectMailbox(userId);
      if (result.success) {
        cleanup = authService.onMailboxConnected("microsoft",
          async (connectionResult: ConnectionResult) => {
            if (connectionResult.success) {
              const connResult = await checkConnections();
              const email = connResult?.microsoft?.email;
              if (email && onEmailConnected) {
                onEmailConnected(email, "microsoft");
              }
              if (email) {
                emitEmailConnectionChanged({ connected: true, email, provider: "microsoft" });
              }
            }
            setConnectingProvider(null);
            if (cleanup) cleanup();
          },
        );
      }
    } catch (error) {
      logger.error("Failed to connect Microsoft:", error);
      setConnectingProvider(null);
    }
  };

  const handleDisconnectGoogle = async (): Promise<void> => {
    setDisconnectingProvider("google");
    try {
      const result = await authService.googleDisconnectMailbox(userId);
      if (result.success) {
        await checkConnections();
        if (onEmailDisconnected) {
          onEmailDisconnected("google");
        }
        emitEmailConnectionChanged({ connected: false, provider: "google" });
      }
    } catch (error) {
      logger.error("Failed to disconnect Google:", error);
    } finally {
      setDisconnectingProvider(null);
    }
  };

  const handleDisconnectMicrosoft = async (): Promise<void> => {
    setDisconnectingProvider("microsoft");
    try {
      const result = await authService.microsoftDisconnectMailbox(userId);
      if (result.success) {
        await checkConnections();
        if (onEmailDisconnected) {
          onEmailDisconnected("microsoft");
        }
        emitEmailConnectionChanged({ connected: false, provider: "microsoft" });
      }
    } catch (error) {
      logger.error("Failed to disconnect Microsoft:", error);
    } finally {
      setDisconnectingProvider(null);
    }
  };

  // BACKLOG-1362: Re-cache emails state
  const [isRecaching, setIsRecaching] = useState(false);
  const [recacheResult, setRecacheResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const recacheTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (recacheTimeoutRef.current) {
        clearTimeout(recacheTimeoutRef.current);
      }
    };
  }, []);

  // BACKLOG-2856: the Force Re-cache confirmation. Gated behind an explicit
  // dialog because the run cascade-deletes every email<->transaction link, in
  // parity with the macOS messages Force Re-import (founder decision,
  // 2026-08-24: "the functionality of the force button on the msg should be the
  // same as the emails").
  const [showForceWarning, setShowForceWarning] = useState(false);

  const handleRecacheEmails = async (force = false): Promise<void> => {
    setIsRecaching(true);
    setRecacheResult(null);
    try {
      const result = await window.api.transactions.precacheEmails(userId, force);
      if (result.success) {
        setRecacheResult({
          success: true,
          // The two runs did different things, so they must not report the same
          // sentence. "Cached N new" after a force re-cache would read as though
          // almost nothing happened, when in fact the mailbox was rebuilt.
          //
          // BACKLOG-2856: the force sentence is driven by `forceSwap`, NOT by
          // `emailsStored`. `emailsStored` counts rows written to the staging
          // tables, so on a force run it reports what was FETCHED — including
          // rows that were pruned or discarded because the swap never ran.
          // Claiming those as re-cached, and claiming an unlink that did not
          // happen, is what sent users off to re-attach mail that was never
          // detached. `forceSwap` is present only when the swap actually
          // committed, so it is the only honest source for this sentence.
          message: force
            ? describeForceRecache(result.forceSwap, connections)
            : `Cached ${result.emailsStored ?? 0} new emails (${result.emailsFetched ?? 0} checked).`,
        });
      } else {
        setRecacheResult({
          success: false,
          message: safeErrorMessage(result.error, "Failed to re-cache emails."),
        });
      }
    } catch (error) {
      logger.error("[Settings] Email re-cache failed:", error);
      setRecacheResult({
        success: false,
        message: "An error occurred while re-caching emails.",
      });
    } finally {
      setIsRecaching(false);
      // Clear result after 8 seconds
      recacheTimeoutRef.current = setTimeout(() => setRecacheResult(null), 8000);
    }
  };

  const hasAnyConnection = connections.google?.connected || connections.microsoft?.connected;

  // Email cache duration handler
  const handleEmailCacheDurationChange = async (months: number): Promise<void> => {
    setEmailCacheDurationMonths(months);
    try {
      const result = await settingsService.updatePreferences(userId, { emailCache: { durationMonths: months } });
      if (!result.success) {
        logger.error("[Settings] Failed to save email cache duration:", result);
      }
    } catch (error) {
      logger.error("[Settings] Error saving email cache duration:", error);
    }
  };

  return (
    <div id="settings-email" className="mb-8">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Email Connections
      </h3>
      <div className="space-y-4">
        {/* Gmail Connection */}
        <div className={`p-4 rounded-lg border ${
          connections.google?.error && !connections.google?.connected && connections.google.error.type !== "NOT_CONNECTED"
            ? "bg-yellow-50 border-yellow-200"
            : "bg-gray-50 border-gray-200"
        }`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <svg
                className="w-5 h-5 text-red-500"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L12 9.545l8.073-6.052C21.69 2.28 24 3.434 24 5.457z" />
              </svg>
              <h4 className="text-sm font-medium text-gray-900">
                Gmail
              </h4>
            </div>
            {loadingConnections ? (
              <div className="text-xs text-gray-500">Checking...</div>
            ) : connections.google?.connected ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-green-600 font-medium">
                  Connected
                </span>
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              </div>
            ) : connections.google?.error && connections.google.error.type !== "NOT_CONNECTED" ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-yellow-600 font-medium">
                  {connections.google.error.type === "TOKEN_REFRESH_FAILED" ||
                   connections.google.error.type === "TOKEN_EXPIRED"
                    ? "Session Expired"
                    : "Connection Issue"}
                </span>
                <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">
                  Not Connected
                </span>
                <div className="w-2 h-2 bg-gray-300 rounded-full"></div>
              </div>
            )}
          </div>
          {connections.google?.email && (
            <p className="text-xs text-gray-600 mb-2">
              {typeof connections.google.email === 'string' ? connections.google.email : String(connections.google.email)}
            </p>
          )}
          {connections.google?.error && !connections.google?.connected && connections.google.error.type !== "NOT_CONNECTED" && (
            <div className="mb-3 p-2 bg-yellow-100 rounded text-xs">
              <p className="text-yellow-800 font-medium">
                {typeof connections.google.error.userMessage === 'string' ? connections.google.error.userMessage : String(connections.google.error.userMessage)}
              </p>
              {connections.google.error.action && (
                <p className="text-yellow-700 mt-1">
                  {typeof connections.google.error.action === 'string' ? connections.google.error.action : String(connections.google.error.action)}
                </p>
              )}
            </div>
          )}
          {connections.google?.connected ? (
            <button
              onClick={handleDisconnectGoogle}
              disabled={disconnectingProvider === "google" || !isOnline}
              title={!isOnline ? "You are offline" : undefined}
              className="w-full mt-2 px-3 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {disconnectingProvider === "google"
                ? "Disconnecting..."
                : "Disconnect Gmail"}
            </button>
          ) : connections.google?.error && connections.google.error.type !== "NOT_CONNECTED" ? (
            <button
              onClick={handleConnectGoogle}
              disabled={connectingProvider === "google" || !isOnline}
              title={!isOnline ? "You are offline" : undefined}
              className="w-full mt-2 px-3 py-2 bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {connectingProvider === "google"
                ? "Reconnecting..."
                : "Reconnect Gmail"}
            </button>
          ) : (
            <button
              onClick={handleConnectGoogle}
              disabled={connectingProvider === "google" || !isOnline}
              title={!isOnline ? "You are offline" : undefined}
              className="w-full mt-2 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {connectingProvider === "google"
                ? "Connecting..."
                : "Connect Gmail"}
            </button>
          )}
        </div>

        {/* Outlook Connection */}
        <div className={`p-4 rounded-lg border ${
          connections.microsoft?.error && !connections.microsoft?.connected && connections.microsoft.error.type !== "NOT_CONNECTED"
            ? "bg-yellow-50 border-yellow-200"
            : "bg-gray-50 border-gray-200"
        }`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none">
                <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
              </svg>
              <h4 className="text-sm font-medium text-gray-900">
                Outlook
              </h4>
            </div>
            {loadingConnections ? (
              <div className="text-xs text-gray-500">Checking...</div>
            ) : connections.microsoft?.connected ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-green-600 font-medium">
                  Connected
                </span>
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              </div>
            ) : connections.microsoft?.error && connections.microsoft.error.type !== "NOT_CONNECTED" ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-yellow-600 font-medium">
                  {connections.microsoft.error.type === "TOKEN_REFRESH_FAILED" ||
                   connections.microsoft.error.type === "TOKEN_EXPIRED"
                    ? "Session Expired"
                    : "Connection Issue"}
                </span>
                <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">
                  Not Connected
                </span>
                <div className="w-2 h-2 bg-gray-300 rounded-full"></div>
              </div>
            )}
          </div>
          {connections.microsoft?.email && (
            <p className="text-xs text-gray-600 mb-2">
              {typeof connections.microsoft.email === 'string' ? connections.microsoft.email : String(connections.microsoft.email)}
            </p>
          )}
          {connections.microsoft?.error && !connections.microsoft?.connected && connections.microsoft.error.type !== "NOT_CONNECTED" && (
            <div className="mb-3 p-2 bg-yellow-100 rounded text-xs">
              <p className="text-yellow-800 font-medium">
                {typeof connections.microsoft.error.userMessage === 'string' ? connections.microsoft.error.userMessage : String(connections.microsoft.error.userMessage)}
              </p>
              {connections.microsoft.error.action && (
                <p className="text-yellow-700 mt-1">
                  {typeof connections.microsoft.error.action === 'string' ? connections.microsoft.error.action : String(connections.microsoft.error.action)}
                </p>
              )}
            </div>
          )}
          {connections.microsoft?.connected ? (
            <button
              onClick={handleDisconnectMicrosoft}
              disabled={disconnectingProvider === "microsoft" || !isOnline}
              title={!isOnline ? "You are offline" : undefined}
              className="w-full mt-2 px-3 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {disconnectingProvider === "microsoft"
                ? "Disconnecting..."
                : "Disconnect Outlook"}
            </button>
          ) : connections.microsoft?.error && connections.microsoft.error.type !== "NOT_CONNECTED" ? (
            <button
              onClick={handleConnectMicrosoft}
              disabled={connectingProvider === "microsoft" || !isOnline}
              title={!isOnline ? "You are offline" : undefined}
              className="w-full mt-2 px-3 py-2 bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {connectingProvider === "microsoft"
                ? "Reconnecting..."
                : "Reconnect Outlook"}
            </button>
          ) : (
            <button
              onClick={handleConnectMicrosoft}
              disabled={connectingProvider === "microsoft" || !isOnline}
              title={!isOnline ? "You are offline" : undefined}
              className="w-full mt-2 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {connectingProvider === "microsoft"
                ? "Connecting..."
                : "Connect Outlook"}
            </button>
          )}
        </div>

        {/* TASK-2072: Email History (cache duration) */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h4 className="text-sm font-medium text-gray-900">
                Email History
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                How much email to keep cached locally for fast search and auto-linking.
              </p>
            </div>
            <select
              value={emailCacheDurationMonths}
              onChange={(e) =>
                handleEmailCacheDurationChange(Number(e.target.value))
              }
              className="ml-4 text-sm border border-gray-300 rounded px-3 py-2.5 bg-white text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 min-h-[44px]"
            >
              <option value={1}>1 month</option>
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>1 year</option>
            </select>
          </div>
        </div>

        {/* BACKLOG-1362: Re-cache Emails */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h4 className="text-sm font-medium text-gray-900">
                Re-cache Emails
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                Fetch latest emails from your connected provider into the local cache.
                Only downloads emails newer than what is already cached.
              </p>
            </div>
            <button
              onClick={() => void handleRecacheEmails(false)}
              disabled={isRecaching || !isOnline || !hasAnyConnection}
              title={
                !isOnline
                  ? "You are offline"
                  : !hasAnyConnection
                    // BACKLOG-2142: unified disabled-control copy across surfaces.
                    ? "Connect email to enable import"
                    : undefined
              }
              data-testid="recache-emails"
              className="ml-4 px-4 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {isRecaching ? "Caching..." : "Re-cache"}
            </button>
          </div>

          {/* BACKLOG-2856: Force Re-cache. Recessive next to the ordinary
              Re-cache above — the incremental run is the one a user should reach
              for, and this one destroys links. Same visual weight relationship
              the messages Force Re-import uses. */}
          <div className="mt-3 pt-3 border-t border-gray-200 flex items-center justify-between">
            <p className="text-xs text-gray-600 flex-1">
              <span className="font-medium text-gray-900">Force re-cache.</span>{" "}
              Re-downloads every email in your cache window and replaces what is
              stored — use this after a fix to email importing. It{" "}
              <strong>unlinks your emails from their transactions</strong>.
            </p>
            <button
              onClick={() => setShowForceWarning(true)}
              disabled={isRecaching || !isOnline || !hasAnyConnection}
              title={
                !isOnline
                  ? "You are offline"
                  : !hasAnyConnection
                    ? "Connect email to enable import"
                    : undefined
              }
              data-testid="force-recache-emails"
              className="ml-4 px-4 py-1.5 bg-white border border-red-300 text-red-700 hover:bg-red-50 text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              Force Re-cache
            </button>
          </div>
          {recacheResult && (
            <p
              className={`text-xs mt-2 ${
                recacheResult.success ? "text-green-600" : "text-red-600"
              }`}
            >
              {typeof recacheResult.message === 'string' ? recacheResult.message : String(recacheResult.message)}
            </p>
          )}
        </div>
      </div>

      {/* BACKLOG-2856: force re-cache confirmation. Mirrors the macOS messages
          Force Re-import dialog (MacOSMessagesImportSettings.tsx) — same shared
          ResponsiveModal, same red warning mark, same button relationship: the
          safe way out is the PROMINENT default and the destructive action is
          recessive while still reading as destructive (outlined, red text).
          Cancel is deliberately not painted red; teaching the eye that "the red
          button is the one to avoid" would be the opposite of the truth here and
          would transfer to every other confirm in the app (BACKLOG-2749). */}
      {showForceWarning && (
        <ResponsiveModal
          onClose={() => setShowForceWarning(false)}
          zIndex="z-[70]"
          panelClassName="max-w-md p-6"
          testId="force-recache-confirm-modal"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
              <svg
                className="w-6 h-6 text-red-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-gray-900">
              Re-cache all emails?
            </h3>
          </div>
          <p className="text-sm text-gray-600 mb-6">
            This re-downloads every email in your cache window from scratch and
            will <strong>unlink your emails from their transactions</strong> —
            you&rsquo;ll need to re-attach them afterward. Any review decisions on
            those emails are lost, and attachments are re-downloaded when you next
            open or export them. This can take a while.
          </p>
          <div className="flex items-center gap-3 justify-end">
            <button
              onClick={() => {
                setShowForceWarning(false);
                void handleRecacheEmails(true);
              }}
              data-testid="force-recache-confirm"
              className="px-4 py-2 bg-white border border-red-300 text-red-700 hover:bg-red-50 rounded-lg font-medium transition-all"
            >
              Re-cache &amp; unlink
            </button>
            <button
              onClick={() => setShowForceWarning(false)}
              data-testid="force-recache-cancel"
              className="px-4 py-2 bg-blue-500 text-white hover:bg-blue-600 rounded-lg font-semibold transition-all"
            >
              Cancel
            </button>
          </div>
        </ResponsiveModal>
      )}
    </div>
  );
}
