import React, { useState, useEffect, useCallback, useRef } from "react";

import type { OAuthProvider } from "../../electron/types/models";
import { systemService, authService } from '../services';
import logger from '../utils/logger';
import { openEmailSettings } from '../utils/openEmailSettings';

interface SystemHealthMonitorProps {
  userId: string;
  provider: OAuthProvider;
  hidden?: boolean;
  /** Callback to open Settings modal - used for reconnect actions. Pass a scrollTarget to scroll to a specific section. */
  onOpenSettings?: (scrollTarget?: string) => void;
}

interface SystemIssue {
  severity?: "error" | "warning" | "info";
  title?: string;
  message?: string;
  userMessage?: string;
  details?: string;
  action?: string;
  actionHandler?: string;
}

/**
 * System Health Monitor
 * Displays warnings and errors for lost permissions and connections
 *
 * Features:
 * - Monitors Full Disk Access permission
 * - Monitors Contacts permission
 * - Monitors Google/Microsoft OAuth connections
 * - Shows dismissible notifications
 * - Provides action buttons to fix issues
 */
function SystemHealthMonitor({
  userId,
  provider,
  hidden = false,
  onOpenSettings,
}: SystemHealthMonitorProps) {
  const [issues, setIssues] = useState<SystemIssue[]>([]);
  const [dismissed, setDismissed] = useState(new Set<number>());
  const checkingRef = useRef(false);

  const checkSystemHealth = useCallback(async () => {
    if (checkingRef.current) return;

    checkingRef.current = true;

    try {
      // Pass provider so we only check the relevant OAuth connection
      const result = await systemService.healthCheck(userId, provider);

      if (result.success && result.data && !result.data.healthy && result.data.issues && Array.isArray(result.data.issues)) {
        setIssues(result.data.issues as SystemIssue[]);
      }
    } catch (error) {
      logger.error("[SystemHealthMonitor] System health check failed:", error);
    } finally {
      checkingRef.current = false;
    }
  }, [userId, provider]);

  useEffect(() => {
    // Delay initial check by 3 seconds to allow OutlookService to initialize
    // This prevents the "not connected" warning from flashing on startup
    const initialTimeout = setTimeout(() => {
      checkSystemHealth();
    }, 3000);

    // Check every 2 minutes after the initial check
    const interval = setInterval(checkSystemHealth, 2 * 60 * 1000);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [checkSystemHealth]);

  const handleDismiss = (issueIndex: number) => {
    setDismissed((prev) => new Set([...prev, issueIndex]));
  };

  const handleAction = async (issue: SystemIssue, issueIndex: number) => {
    switch (issue.actionHandler) {
      case "open-system-settings":
        await systemService.openPrivacyPane("fullDiskAccess");
        break;

      case "connect-google":
      case "reconnect-google":
      case "connect-microsoft":
      case "reconnect-microsoft":
        // Navigate to Settings and scroll to Email Connections section
        // This is more reliable than triggering OAuth directly from the notification
        if (onOpenSettings) {
          // Navigate to Settings + highlight email connections (shared with the
          // SyncStatusIndicator reconnect CTA so both land in the same place).
          openEmailSettings(onOpenSettings);
          handleDismiss(issueIndex);
        } else {
          // Fallback: Try OAuth directly if Settings callback not available
          try {
            const isGoogle = issue.actionHandler === "connect-google" || issue.actionHandler === "reconnect-google";
            const result = isGoogle
              ? await authService.googleConnectMailbox(userId)
              : await authService.microsoftConnectMailbox(userId);
            if (result.success) {
              const cleanup = authService.onMailboxConnected(
                isGoogle ? "google" : "microsoft",
                async (connectionResult) => {
                  if (connectionResult.success) {
                    await checkSystemHealth();
                    if (!isGoogle) {
                      handleDismiss(issueIndex);
                    }
                  }
                  cleanup();
                }
              );
            }
          } catch (error) {
            logger.error(
              `[SystemHealthMonitor] ${issue.actionHandler} failed:`,
              error,
            );
          }
        }
        break;

      case "retry":
        await checkSystemHealth();
        handleDismiss(issueIndex);
        break;

      default:
        logger.warn(
          "[SystemHealthMonitor] Unknown action handler:",
          issue.actionHandler,
        );
    }
  };

  const visibleIssues = issues.filter((_, index) => !dismissed.has(index));

  // Hide during onboarding tour or when no issues
  if (hidden || visibleIssues.length === 0) {
    return null;
  }

  // Severity styling - using amber for warnings to match Dashboard setup banner
  const severityClasses: Record<"error" | "warning" | "info", string> = {
    error: "bg-red-50 border-red-200",
    warning: "bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200",
    info: "bg-blue-50 border-blue-200",
  };

  const iconClasses: Record<"error" | "warning" | "info", string> = {
    error: "text-red-600",
    warning: "text-amber-600",
    info: "text-blue-600",
  };

  const textClasses: Record<"error" | "warning" | "info", string> = {
    error: "text-red-800",
    warning: "text-amber-900",
    info: "text-blue-800",
  };

  const buttonClasses: Record<"error" | "warning" | "info", string> = {
    error: "bg-red-200 hover:bg-red-300 text-red-800",
    warning: "bg-amber-500 hover:bg-amber-600 text-white",
    info: "bg-blue-200 hover:bg-blue-300 text-blue-800",
  };

  return (
    <div className="space-y-0">
      {visibleIssues.map((issue, _index) => {
        const originalIndex = issues.findIndex(
          (i, idx) => i === issue && !dismissed.has(idx),
        );
        // BACKLOG-2127: a broken mailbox token is RECOVERABLE — the user just
        // needs to reconnect. Render it in the amber (warning) family so the
        // same fact has one visual voice across the sync card and this banner,
        // even though the health summary still counts it as severity:'error'.
        // Red stays reserved for genuinely unrecoverable issues.
        const isReconnectIssue =
          issue.actionHandler === "reconnect-microsoft" ||
          issue.actionHandler === "reconnect-google";
        const severity: "error" | "warning" | "info" = isReconnectIssue
          ? "warning"
          : issue.severity || "warning";

        return (
          <div
            key={originalIndex}
            className={`flex-shrink-0 ${severityClasses[severity]} border-b px-4 py-3`}
          >
            <div className="flex items-center justify-between max-w-4xl mx-auto">
              <div className="flex items-center gap-3">
                {/* Icon */}
                <div className={`flex-shrink-0 ${iconClasses[severity]}`}>
                  {severity === "error" && (
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  )}
                  {severity === "warning" && (
                    <svg
                      className="w-5 h-5"
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
                  )}
                  {severity === "info" && (
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  )}
                </div>

                {/* Content */}
                <div>
                  <p className={`text-sm font-medium ${textClasses[severity]}`}>
                    {issue.title || issue.userMessage}
                  </p>
                  {/* BACKLOG-2127: only render a subtitle when there's a
                      DISTINCT message. Reconnect issues put the full sentence in
                      the title (userMessage) and the CTA in the button, so a
                      subtitle echoing `action` was redundant. */}
                  {issue.message && (
                    <p className={`text-xs ${textClasses[severity]} opacity-80`}>
                      {issue.message}
                    </p>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                {issue.action && (
                  <button
                    onClick={() => handleAction(issue, originalIndex)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${buttonClasses[severity]}`}
                  >
                    {issue.action}
                  </button>
                )}
                <button
                  onClick={() => handleDismiss(originalIndex)}
                  className={`px-3 py-1.5 text-xs font-medium ${severity === 'warning' ? 'text-amber-700 hover:text-amber-900' : textClasses[severity]} hover:opacity-80 transition-colors`}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SystemHealthMonitor;
