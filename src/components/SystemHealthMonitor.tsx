import React, { useState, useEffect, useCallback, useRef } from "react";

import type { OAuthProvider } from "../../electron/types/models";
// BACKLOG-3230: the real wire shape, replacing a local all-optional interface
// that was mutually comparable with `string` — which is why `string[] as
// SystemIssue[]` compiled with zero diagnostics and the contract could not fail.
import type {
  HealthIssue,
  HealthIssueSeverity,
} from "../../electron/types/ipc/healthIssue";
import { systemService, authService } from '../services';
import { identityOf } from '../utils/healthIssueIdentity';
import logger from '../utils/logger';
import { openEmailSettings } from '../utils/openEmailSettings';
import { FdaHelpSheet } from './permissions/FdaHelpSheet';

interface SystemHealthMonitorProps {
  userId: string;
  provider: OAuthProvider;
  hidden?: boolean;
  /** Callback to open Settings modal - used for reconnect actions. Pass a scrollTarget to scroll to a specific section. */
  onOpenSettings?: (scrollTarget?: string) => void;
}

/**
 * The severity this banner PAINTS a row in, which is not the severity the wire
 * carries — a reconnectable mailbox is painted amber even though the health
 * summary counts it as an error.
 *
 * It is exactly `HealthIssueSeverity` and is declared as an alias of it rather
 * than restated, so the paint vocabulary cannot drift from the wire vocabulary.
 *
 * BACKLOG-3230, and worth the paragraph. An earlier revision of this PR widened
 * this to `"error" | "warning" | "info"` to keep an `=== "info"` render branch
 * compiling. That branch is dead — `permissionService` has nine `severity`
 * writes and every one is "error" or "warning", and the single site that could
 * emit "info" (`connectionStatusService.formatUserError`) has NO CALLERS and
 * would only fire it for `NOT_CONNECTED`, which `BROKEN_TOKEN_TYPES` keeps out
 * of this banner anyway.
 *
 * Widening the return type to silence that was the same move as the
 * `as SystemIssue[]` cast this item deletes: assert a shape the producer cannot
 * produce so the compiler stops objecting. The whole deliverable of BACKLOG-3230
 * is a compiler that CAN object here, so the branch went instead.
 */
type DisplaySeverity = HealthIssueSeverity;

function displaySeverity(
  issue: HealthIssue,
  isReconnectIssue: boolean,
): DisplaySeverity {
  // BACKLOG-2127: a broken mailbox token is RECOVERABLE, so it is painted amber
  // even though the health summary still counts it as severity:"error".
  if (isReconnectIssue) return "warning";
  // An absent severity is amber on purpose: a permission result carries none.
  return issue.severity || "warning";
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
  const [issues, setIssues] = useState<HealthIssue[]>([]);
  // BACKLOG-3229: identities, NOT array indices. See utils/healthIssueIdentity.
  const [dismissed, setDismissed] = useState(new Set<string>());
  const checkingRef = useRef(false);
  /**
   * BACKLOG-3210 (part 2): the Full Disk Access explainer, opened from this
   * banner's action button.
   *
   * Rendered here rather than routed through `onOpenSettings` because it needs
   * nothing from the Settings modal — sending the user to Settings first would
   * reproduce, one screen out, the dead-end this is fixing.
   */
  const [showFdaExplainer, setShowFdaExplainer] = useState(false);

  const checkSystemHealth = useCallback(async () => {
    if (checkingRef.current) return;

    checkingRef.current = true;

    try {
      // Pass provider so we only check the relevant OAuth connection
      const result = await systemService.healthCheck(userId, provider);

      // BACKLOG-3210 (part 2): the `!result.data.healthy` condition that used
      // to sit in this guard is GONE, and its absence is the fix.
      //
      // With it, the issue list could only ever be REPLACED by a non-empty one.
      // A recovered system reports `healthy: true` with `issues: []`, that
      // branch was skipped, and the previous issues stayed in state — so a
      // banner could appear and never disappear. A user who granted Full Disk
      // Access, or reconnected a mailbox, went on being told it was missing
      // until the app was restarted. It is the same shape as the bug in
      // BACKLOG-3219 one layer up: the surface that reports a problem could not
      // report the problem's end.
      //
      // `Array.isArray` still guards the whole write, so a check that could NOT
      // answer (the handler's error path returns no `issues` at all) leaves the
      // banner exactly as it was rather than silently clearing it. An
      // unanswerable check is not a recovery.
      if (result.success && result.data && Array.isArray(result.data.issues)) {
        // BACKLOG-3230: the cast that used to sit here is GONE, and its absence
        // is the point — it was what stopped the compiler seeing that the
        // declared `string[]` and the emitted objects disagreed.
        const nextIssues = result.data.issues;
        setIssues(nextIssues);
        // BACKLOG-3229: PRUNE the dismissed set to the identities still
        // present. This replaces the old "clear it when the list is empty"
        // mitigation, which could only fire on a list that reached zero — and
        // the damaging case (one issue replaced by a different one) never does.
        //
        // Pruning also gives recurrence the right behaviour for free: an issue
        // that is resolved and later comes back has had its identity dropped in
        // between, so it reappears rather than staying dismissed forever.
        //
        // The functional updater is REQUIRED, not stylistic. `checkSystemHealth`
        // is a `useCallback` keyed on [userId, provider], and `setInterval`
        // holds ONE closure for the life of the effect — so reading `dismissed`
        // from scope here would read the empty set captured on first render and
        // wipe every dismissal on each 2-minute poll. Adding `dismissed` to the
        // deps is the wrong fix: it would tear down and rebuild the interval on
        // every dismissal.
        const liveIdentities = new Set(
          nextIssues.map(identityOf).filter((id): id is string => id !== null),
        );
        setDismissed(
          (prev) => new Set([...prev].filter((id) => liveIdentities.has(id))),
        );
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

  const handleDismiss = (issueIdentity: string | null) => {
    // A row with no derivable identity is not dismissable — see identityOf.
    if (issueIdentity === null) return;
    setDismissed((prev) => new Set([...prev, issueIdentity]));
  };

  const handleAction = async (issue: HealthIssue, issueIdentity: string | null) => {
    switch (issue.actionHandler) {
      case "open-system-settings":
        await systemService.openPrivacyPane("fullDiskAccess");
        break;

      // BACKLOG-3210 (part 2) / BACKLOG-3219: a Full Disk Access denial opens
      // the explainer, not the raw macOS pane. `diagnosticHandlers` attaches
      // this handler to the FDA denial issues; before it, those rows reached
      // the `default:` branch below and the button did nothing at all.
      //
      // The row is NOT dismissed here: the permission is still missing when
      // the sheet closes, and a banner that disappears because you asked for
      // help is a worse dead-end than the one being fixed. It reappears on the
      // next health check anyway; keeping it makes the state honest now.
      case "open-fda-explainer":
        setShowFdaExplainer(true);
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
          handleDismiss(issueIdentity);
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
                      handleDismiss(issueIdentity);
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
        handleDismiss(issueIdentity);
        break;

      default:
        logger.warn(
          "[SystemHealthMonitor] Unknown action handler:",
          issue.actionHandler,
        );
    }
  };

  // BACKLOG-3229: filtered by IDENTITY, not by position. A row with no
  // identity is never filtered out — it cannot have been dismissed.
  const visibleIssues = issues.filter((issue) => {
    const identity = identityOf(issue);
    return identity === null || !dismissed.has(identity);
  });

  // Hide during onboarding tour or when no issues
  if (hidden || visibleIssues.length === 0) {
    return null;
  }

  // Severity styling - using amber for warnings to match Dashboard setup banner
  const severityClasses: Record<DisplaySeverity, string> = {
    error: "bg-red-50 border-red-200",
    warning: "bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200",
  };

  const iconClasses: Record<DisplaySeverity, string> = {
    error: "text-red-600",
    warning: "text-amber-600",
  };

  const textClasses: Record<DisplaySeverity, string> = {
    error: "text-red-800",
    warning: "text-amber-900",
  };

  const buttonClasses: Record<DisplaySeverity, string> = {
    error: "bg-red-200 hover:bg-red-300 text-red-800",
    warning: "bg-amber-500 hover:bg-amber-600 text-white",
  };

  return (
    <div className="space-y-0">
      {showFdaExplainer && (
        <FdaHelpSheet
          onClose={() => setShowFdaExplainer(false)}
          // BACKLOG-3210 (part 2): when the explainer observes the grant it
          // closes itself; re-running the health check is what makes THIS row
          // go away with it. Without this the banner would linger until the
          // 2-minute poll came round, so the user would fix the permission and
          // still be told it was missing.
          onPermissionGranted={checkSystemHealth}
        />
      )}
      {visibleIssues.map((issue, index) => {
        const issueIdentity = identityOf(issue);
        // BACKLOG-2127: a broken mailbox token is RECOVERABLE — the user just
        // needs to reconnect. Render it in the amber (warning) family so the
        // same fact has one visual voice across the sync card and this banner,
        // even though the health summary still counts it as severity:'error'.
        // Red stays reserved for genuinely unrecoverable issues.
        const isReconnectIssue =
          issue.actionHandler === "reconnect-microsoft" ||
          issue.actionHandler === "reconnect-google";
        const severity = displaySeverity(issue, isReconnectIssue);

        return (
          <div
            // BACKLOG-3229: the identity is the key, so React keeps a row bound
            // to its issue across a reorder. The index is the fallback ONLY for
            // a row with no identity, and ONLY for React's key — never for
            // dismissal, which is what this item removed positions from.
            key={issueIdentity ?? `no-identity:${index}`}
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
                    onClick={() => handleAction(issue, issueIdentity)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${buttonClasses[severity]}`}
                  >
                    {issue.action}
                  </button>
                )}
                {/* BACKLOG-3229: no identity, no Dismiss button. Such a row cannot
                    be remembered across a poll, so offering the control would
                    produce a button that silently does nothing. */}
                {issueIdentity !== null && (
                  <button
                    onClick={() => handleDismiss(issueIdentity)}
                    className={`px-3 py-1.5 text-xs font-medium ${severity === 'warning' ? 'text-amber-700 hover:text-amber-900' : textClasses[severity]} hover:opacity-80 transition-colors`}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SystemHealthMonitor;
