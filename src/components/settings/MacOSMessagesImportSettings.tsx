/**
 * MacOSMessagesImportSettings Component (TASK-1710, TASK-1752)
 *
 * Settings section for importing messages from macOS Messages app.
 * Only visible on macOS platform.
 *
 * Features:
 * - Shows inline progress bar during import (no modal)
 * - Supports cancellation
 * - Displays results after import completes
 *
 * @module settings/MacOSMessagesImportSettings
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { ResponsiveModal } from "../common/ResponsiveModal";
import { usePlatform } from "../../contexts/PlatformContext";
import { useSyncOrchestrator } from "../../hooks/useSyncOrchestrator";
import { settingsService } from '../../services';
import logger from '../../utils/logger';
import { safeErrorMessage } from '../../utils/formatUtils';
import { parseLocalCalendarDay } from '../../utils/dateRangeUtils';

/**
 * Lookback window shown when the user has stored NO `lookbackMonths` preference.
 *
 * BACKLOG-2561: must equal `DEFAULT_LOOKBACK_MONTHS` in
 * `electron/services/macOSMessagesImportService/importHelpers.ts`, which is what
 * the main process actually imports with. The renderer cannot import from
 * `electron/` (the Vite renderer build parses it as JavaScript and `rootDir`
 * forbids the reverse), so the value is duplicated here on purpose and pinned by
 * `__tests__/MacOSMessagesImportSettings.allTime-2561.test.tsx`, which asserts the
 * dropdown reads "Last 3 months" for the exact preference shape the app writes
 * when only the message cap has ever been changed.
 */
const DEFAULT_LOOKBACK_MONTHS = 3;

/** Import progress state for inline display */
interface ImportProgressState {
  phase: "deleting" | "attachments" | "importing";
  current: number;
  total: number;
  percent: number;
}

interface MacOSMessagesImportSettingsProps {
  userId: string;
  /**
   * BACKLOG-2335: Whether macOS Messages is the ACTIVE import source. When false
   * (e.g. the user picked iPhone or Android above), the panel is shown but its
   * controls are disabled and an explanatory note is rendered — otherwise the
   * controls would no-op silently because SyncOrchestrator skips macOS import
   * for any non-`macos-native` source. Defaults to true (fully enabled).
   */
  enabled?: boolean;
  /**
   * BACKLOG-2335: User-facing reason the panel is inactive, worded from the real
   * active import source (e.g. "…set to iPhone — switch to macOS above…").
   */
  disabledReason?: string;
}

/**
 * Messages import settings for macOS users.
 * Allows manual import of messages from the macOS Messages app.
 */
export function MacOSMessagesImportSettings({
  userId,
  enabled = true,
  disabledReason,
}: MacOSMessagesImportSettingsProps) {
  const { isMacOS } = usePlatform();
  const { queue, requestSync } = useSyncOrchestrator();

  // Derive importing state from orchestrator queue
  const messagesItem = queue.find(q => q.type === 'messages');
  const isImporting = messagesItem?.status === 'running' || messagesItem?.status === 'pending';

  // BACKLOG-2335: Disable every interactive control when macOS is not the active
  // import source (or while an import is running). Without this the filter
  // selects + Import / Force Re-import buttons stay clickable but silently no-op
  // (SyncOrchestrator skips macOS import for non-`macos-native` sources), which
  // reads to the user as "Re-imported 0 messages".
  const controlsDisabled = !enabled || isImporting;

  // Derive progress from orchestrator queue item
  const importProgress = isImporting && messagesItem?.phase ? {
    phase: messagesItem.phase as ImportProgressState['phase'],
    current: 0,
    total: 0,
    percent: messagesItem.progress,
  } : null;
  const [lastResult, setLastResult] = useState<{
    success: boolean;
    messagesImported: number;
    error?: string;
    cancelled?: boolean;
    wasCapped?: boolean;
    totalAvailable?: number;
    // BACKLOG-2329: true when the completed import was a force re-import, so the
    // result copy reads "Re-imported N messages" rather than "imported N new".
    wasForceReimport?: boolean;
    /** BACKLOG-2743: non-fatal notice (e.g. attachments skipped for disk space). */
    warning?: string;
  } | null>(null);
  const [importStatus, setImportStatus] = useState<{
    messageCount?: number;
    lastImportAt?: string | null;
  } | null>(null);

  // TASK-1952: Import filter state
  const [lookbackMonths, setLookbackMonths] = useState<number | null>(
    DEFAULT_LOOKBACK_MONTHS
  );
  const [maxMessages, setMaxMessages] = useState<number | null>(50000);

  // BACKLOG-2286: Effective (audit-aware) import window for a truthful label.
  // Post-BACKLOG-2276 the real import lower bound is the EARLIER of the lookback
  // preference and the earliest transaction audit-period start, so the label
  // must reflect that rather than always saying "last N months".
  const [effectiveWindow, setEffectiveWindow] = useState<{
    effectiveCutoffISO: string | null;
    source: "audit-period" | "lookback-pref";
    lookbackMonths: number | null;
  } | null>(null);

  // Available message count for pre-import cap warning
  const [availableCount, setAvailableCount] = useState<number | null>(null);

  // BACKLOG-2743: Selection-time size estimate. Before this, choosing "All time"
  // showed a message count and nothing about size, so an import whose
  // attachments exceeded the disk looked identical to one that fit.
  const [sizeEstimate, setSizeEstimate] = useState<{
    attachmentBytes: number;
    attachmentCount: number;
    availableDiskBytes: number | null;
    fitsOnDisk: boolean;
  } | null>(null);

  // BACKLOG-2743: "Import without attachments" — the escape hatch that makes a
  // refusal actionable. Message text is a small fraction of attachment size, so
  // this always fits when the full import does not.
  const [skipAttachments, setSkipAttachments] = useState(false);

  // Confirmation prompt when cap would be exceeded
  // Stores whether the pending import is a force re-import, or null if no prompt
  const [capPromptForce, setCapPromptForce] = useState<boolean | null>(null);
  const showCapPrompt = capPromptForce !== null;
  const capExceeded = availableCount !== null && maxMessages !== null && availableCount > maxMessages;

  // Force re-import warning confirmation
  const [showForceWarning, setShowForceWarning] = useState(false);

  // Load import status and filter preferences on mount
  useEffect(() => {
    if (!isMacOS || !userId) return;
    loadImportStatus();
    loadFilterPreferences();
    loadEffectiveWindow();
  }, [isMacOS, userId]);

  // Fetch available count when filters change (for pre-import cap warning)
  //
  // BACKLOG-2743: also fetches the attachment-size estimate and the disk verdict
  // for the SAME window. `auditPeriodStart` is passed because the real import
  // widens the window to cover transaction audit periods — without it the
  // estimate would describe a narrower import than the one that actually runs.
  useEffect(() => {
    if (!isMacOS) return;
    const fetchCount = async () => {
      try {
        const result = await window.api.messages.getImportCount({
          lookbackMonths,
          auditPeriodStart: effectiveWindow?.effectiveCutoffISO ?? null,
        });
        if (result.success) {
          setAvailableCount(result.filteredCount ?? result.count ?? null);
          setSizeEstimate(
            result.attachmentBytes !== undefined
              ? {
                  attachmentBytes: result.attachmentBytes,
                  attachmentCount: result.attachmentCount ?? 0,
                  availableDiskBytes: result.availableDiskBytes ?? null,
                  // The main process owns this verdict. Recomputing it here from
                  // bytes vs available would duplicate the headroom rule and let
                  // the shown number drift from the enforced one.
                  fitsOnDisk: result.fitsOnDisk !== false,
                }
              : null
          );
        }
      } catch {
        // Silently handle
      }
    };
    fetchCount();
  }, [isMacOS, lookbackMonths, effectiveWindow?.effectiveCutoffISO]);

  const loadImportStatus = async () => {
    try {
      const result = await window.api.messages.getImportStatus(userId);
      if (result.success) {
        setImportStatus({
          messageCount: result.messageCount,
          lastImportAt: result.lastImportAt,
        });
      }
    } catch (error) {
      logger.error("Failed to load import status:", error);
    }
  };

  // BACKLOG-2286: Load the effective (audit-aware) import window for the label.
  // Read-only; failures leave the label on the plain lookback-preference copy.
  const loadEffectiveWindow = async () => {
    try {
      const result = await window.api.messages.getEffectiveImportWindow(userId);
      if (result.success) {
        setEffectiveWindow({
          effectiveCutoffISO: result.effectiveCutoffISO,
          source: result.source,
          lookbackMonths: result.lookbackMonths,
        });
      }
    } catch (error) {
      logger.error("Failed to load effective import window:", error);
    }
  };

  // TASK-1952: Load filter preferences from user preferences
  const loadFilterPreferences = async () => {
    try {
      const result = await settingsService.getPreferences(userId);
      if (result?.success && result.data) {
        const prefs = result.data as Record<string, unknown>;
        const messageImport = prefs.messageImport as
          | {
              filters?: {
                lookbackMonths?: number | null;
                maxMessages?: number | null;
                skipAttachments?: boolean;
              };
            }
          | undefined;
        if (messageImport?.filters) {
          // BACKLOG-2561: an ABSENT key is "no preference", not "All time".
          // `?? null` showed "All time" in the dropdown while the main process
          // imported the 3-month default — reachable today, because changing only
          // the message cap writes `{ maxMessages: N }` and the preferences
          // deep-merge leaves `lookbackMonths` absent. Only an explicit `null`
          // (what this dropdown writes for "All time") means unbounded.
          setLookbackMonths(
            messageImport.filters.lookbackMonths === undefined
              ? DEFAULT_LOOKBACK_MONTHS
              : messageImport.filters.lookbackMonths
          );
          setMaxMessages(messageImport.filters.maxMessages ?? null);
          // BACKLOG-2743: absent preference means "import attachments" (prior behavior).
          setSkipAttachments(messageImport.filters.skipAttachments === true);
        }
      }
    } catch {
      // Silently handle - use defaults
    }
  };

  // TASK-1952: Save lookback months filter
  const handleLookbackChange = async (value: string) => {
    const months = value === "all" ? null : Number(value);
    setLookbackMonths(months);
    setLastResult(null);
    setCapPromptForce(null);
    try {
      await settingsService.updatePreferences(userId, {
        messageImport: {
          filters: {
            lookbackMonths: months,
          },
        },
      });
    } catch {
      // Silently handle
    }
    // BACKLOG-2286: Refresh the effective window (the pref is a floor the audit
    // period can widen past) after the save lands so the label stays truthful.
    loadEffectiveWindow();
  };

  // TASK-1952: Save max messages filter
  const handleMaxMessagesChange = async (value: string) => {
    const cap = value === "unlimited" ? null : Number(value);
    setMaxMessages(cap);
    setLastResult(null);
    setCapPromptForce(null);
    try {
      await settingsService.updatePreferences(userId, {
        messageImport: {
          filters: {
            maxMessages: cap,
          },
        },
      });
    } catch {
      // Silently handle
    }
  };

  // BACKLOG-2743: Persist the "without attachments" choice. The block clears via
  // `spaceBlocked`, which reads this flag directly — no re-estimate is triggered
  // or needed, because skipping attachments changes what gets COPIED, not what
  // the selected window CONTAINS.
  const handleSkipAttachmentsChange = async (skip: boolean) => {
    setSkipAttachments(skip);
    setLastResult(null);
    try {
      await settingsService.updatePreferences(userId, {
        messageImport: { filters: { skipAttachments: skip } },
      });
    } catch {
      // Silently handle
    }
  };

  // BACKLOG-2743: True when the attachment copy does NOT fit and the user has
  // not chosen to skip attachments. Import is BLOCKED in this state — there is
  // deliberately no "import anyway" override, because an override is exactly
  // what would let the disk fill and evict the user's Time Machine snapshots.
  const spaceBlocked =
    sizeEstimate !== null && !sizeEstimate.fitsOnDisk && !skipAttachments;

  // BACKLOG-2743: Plain size formatting — real numbers, no adjectives.
  const formatGb = (bytes: number): string => {
    const gb = bytes / 1e9;
    if (gb < 0.1) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
    return `${gb.toFixed(1)} GB`;
  };

  // Format the last import time for display
  const formatLastImport = (lastImportAt: string | null | undefined): string => {
    if (!lastImportAt) return "Never imported";

    const importDate = new Date(lastImportAt);
    const now = new Date();
    const diffMs = now.getTime() - importDate.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
    if (diffHours < 24)
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  };

  // BACKLOG-2286: Format the effective-window cutoff as a local calendar day
  // (e.g. "Jan 1, 2026"). parseLocalCalendarDay uses only the calendar-day
  // portion so the shown date matches the audit boundary with no UTC off-by-one.
  const formatEffectiveCutoff = (iso: string): string => {
    const d = parseLocalCalendarDay(iso);
    if (!d) return "";
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  // BACKLOG-2286: True when the audit period drives the import window (reaches
  // back further than the lookback preference).
  const isAuditDriven =
    effectiveWindow?.source === "audit-period" &&
    !!effectiveWindow.effectiveCutoffISO;

  // TASK-2150: Track overrideCap state for preference restoration after orchestrator completes
  const pendingCapRestoreRef = useRef<number | null>(null);

  // BACKLOG-2329: remember whether the in-flight import is a force re-import so
  // the completion copy can distinguish "Re-imported N" from "imported N new".
  const lastForceReimportRef = useRef(false);

  // Watch orchestrator queue for messages completion to restore cap preference
  useEffect(() => {
    if (pendingCapRestoreRef.current !== null && messagesItem?.status !== 'running' && messagesItem?.status !== 'pending') {
      // Messages sync completed or errored -- restore the cap preference
      const previousMax = pendingCapRestoreRef.current;
      pendingCapRestoreRef.current = null;
      setMaxMessages(previousMax);
      settingsService.updatePreferences(userId, {
        messageImport: { filters: { maxMessages: previousMax } },
      }).catch(() => { /* Silently handle */ });
    }
  }, [messagesItem?.status, userId]);

  const handleImport = useCallback(
    async (forceReimport = false, overrideCap = false) => {
      if (!userId || isImporting) return;

      // BACKLOG-2329: record the path so the completion copy matches it.
      lastForceReimportRef.current = forceReimport;

      // Temporarily remove cap for this import if overriding
      if (overrideCap) {
        pendingCapRestoreRef.current = maxMessages;
        setMaxMessages(null);
        try {
          await settingsService.updatePreferences(userId, {
            messageImport: { filters: { maxMessages: null } },
          });
        } catch {
          // Continue with override anyway
        }
      }

      setLastResult(null);

      // TASK-2150: Route through orchestrator instead of direct IPC
      requestSync(['messages'], userId, { forceReimport: forceReimport || undefined });
    },
    [userId, isImporting, maxMessages, requestSync]
  );

  // Watch orchestrator queue for messages completion to update result/status
  useEffect(() => {
    if (messagesItem?.status === 'complete') {
      loadImportStatus();
      loadEffectiveWindow();
      // BACKLOG-2329: report the ACTUAL imported count carried by the queue item
      // (previously hard-coded to 0). Fall back to 0 only when the count is
      // genuinely absent (e.g. sync skipped for a non-macos-native source).
      const messagesImported = messagesItem.importedCount ?? 0;
      const wasForceReimport = lastForceReimportRef.current;
      // If there's a warning from the orchestrator (cap exceeded), flag it
      setLastResult({
        success: true,
        messagesImported,
        wasForceReimport,
        wasCapped: messagesItem.warning ? true : undefined,
        // BACKLOG-2743: surface the warning text itself. The pre-flight
        // free-space refusal arrives on this channel, and discarding it would
        // report unqualified success while attachments were silently skipped.
        warning: messagesItem.warning,
      });
    } else if (messagesItem?.status === 'error') {
      setLastResult({
        success: false,
        messagesImported: 0,
        error: safeErrorMessage(messagesItem.error, 'Import failed'),
      });
    }
  }, [messagesItem?.status, messagesItem?.error, messagesItem?.warning, messagesItem?.importedCount]);


  // Only render on macOS
  if (!isMacOS) {
    return null;
  }

  return (
    <div
      className="p-4 bg-gray-50 rounded-lg border border-gray-200"
      aria-disabled={!enabled}
      data-testid="macos-messages-import"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <svg
            className={`w-5 h-5 ${enabled ? "text-green-600" : "text-gray-400"}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <h4
            className={`text-sm font-medium ${
              enabled ? "text-gray-900" : "text-gray-400"
            }`}
          >
            macOS Messages
          </h4>
        </div>
      </div>

      {/* BACKLOG-2335: Explain why the panel is inactive when another message
          source is active, so the disabled controls don't read as a bug. */}
      {!enabled && (
        <div
          data-testid="macos-import-disabled-note"
          className="mb-3 p-2 rounded text-xs bg-amber-50 text-amber-700 border border-amber-200"
        >
          {disabledReason ??
            "macOS Messages is not your active message source — switch to macOS above to import from Messages."}
        </div>
      )}

      {/* BACKLOG-2335: Mute the controls region while inactive (the note above
          stays full-strength so the reason is always legible). */}
      <div className={enabled ? "" : "opacity-60"}>
      <p className="text-xs text-gray-600 mb-3">
        Import messages from the macOS Messages app to enable linking with your
        transactions.
      </p>

      {/* Import status display */}
      {importStatus && (
        <div className="mb-3 text-xs text-gray-500">
          Last imported: {formatLastImport(importStatus.lastImportAt)}
          {importStatus.messageCount !== undefined && (
            <> | {importStatus.messageCount.toLocaleString()} messages</>
          )}
        </div>
      )}

      {/* TASK-1952: Import Filters */}
      <div id="settings-import-filters" className="mb-3 p-3 bg-white rounded border border-gray-200">
        <h5 className="text-xs font-medium text-gray-700 mb-2">
          Import Filters
        </h5>

        {/* Date Range Filter */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-600">Import messages from</span>
          <select
            value={lookbackMonths ?? "all"}
            onChange={(e) => handleLookbackChange(e.target.value)}
            disabled={controlsDisabled}
            className="text-xs border border-gray-300 rounded px-3 py-2.5 bg-white text-gray-900 disabled:opacity-50 min-h-[44px]"
          >
            <option value="3">Last 3 months</option>
            <option value="6">Last 6 months</option>
            <option value="9">Last 9 months</option>
            <option value="12">Last 12 months</option>
            <option value="18">Last 18 months</option>
            <option value="24">Last 24 months</option>
            <option value="all">All time</option>
          </select>
        </div>

        {/* Message Count Cap */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-600">Maximum messages</span>
          <select
            value={maxMessages ?? "unlimited"}
            onChange={(e) => handleMaxMessagesChange(e.target.value)}
            disabled={controlsDisabled}
            className="text-xs border border-gray-300 rounded px-3 py-2.5 bg-white text-gray-900 disabled:opacity-50 min-h-[44px]"
          >
            <option value="10000">10,000</option>
            <option value="50000">50,000</option>
            <option value="100000">100,000</option>
            <option value="250000">250,000</option>
            <option value="500000">500,000</option>
            <option value="unlimited">Unlimited</option>
          </select>
        </div>

        {/* Active filter / effective-window indicator (BACKLOG-2286) */}
        {isAuditDriven ? (
          <div className="mt-2">
            <p className="text-xs text-blue-600">
              Auto-importing messages back to{" "}
              {formatEffectiveCutoff(effectiveWindow!.effectiveCutoffISO!)}
              {maxMessages !== null &&
                `, up to ${maxMessages.toLocaleString()} messages`}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              This covers your transactions&rsquo; audit periods. The setting
              below only applies if you want to reach back even further.
            </p>
          </div>
        ) : (
          (lookbackMonths !== null || maxMessages !== null) && (
            <p className="text-xs text-blue-600 mt-2">
              {lookbackMonths !== null && maxMessages !== null
                ? `Importing last ${lookbackMonths} months, up to ${maxMessages.toLocaleString()} messages`
                : lookbackMonths !== null
                  ? `Importing messages from the last ${lookbackMonths} months`
                  : `Importing up to ${maxMessages!.toLocaleString()} messages`}
            </p>
          )
        )}

        {/* Pre-import cap info */}
        {!isImporting && capExceeded && (
          <p className="text-xs text-amber-600 mt-2">
            This time period contains {availableCount!.toLocaleString()} messages,
            which exceeds the {maxMessages!.toLocaleString()} limit.
          </p>
        )}

        {/* BACKLOG-2743: Size estimate for the selected window. Real numbers
            only — messages, attachment size, and the user's own free space.
            Deliberately NOT worded as "may slow your computer": this is a disk
            capacity fact, and a vague warning trains people to dismiss it. */}
        {!isImporting && sizeEstimate !== null && sizeEstimate.attachmentCount > 0 && (
          <p
            data-testid="import-size-estimate"
            className="text-xs text-gray-600 mt-2"
          >
            {availableCount !== null && (
              <>This selection covers {availableCount.toLocaleString()} messages and </>
            )}
            about {formatGb(sizeEstimate.attachmentBytes)} of attachments
            {sizeEstimate.availableDiskBytes !== null && (
              <>. You have {formatGb(sizeEstimate.availableDiskBytes)} available</>
            )}
            .
          </p>
        )}

        {/* BACKLOG-2743: Import without attachments. Also reachable from the
            block below; kept here so it is a normal, always-available choice. */}
        <label className="flex items-center gap-2 mt-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={skipAttachments}
            onChange={(e) => handleSkipAttachmentsChange(e.target.checked)}
            disabled={controlsDisabled}
            data-testid="skip-attachments-toggle"
            className="rounded border-gray-300"
          />
          Import message text only (no attachment files)
        </label>
      </div>

      {/* BACKLOG-2743: The attachment copy does not fit. Import is BLOCKED with
          two ways through — a narrower window, or without attachments. There is
          no "import anyway": macOS would make room by deleting the user's local
          Time Machine snapshots, which is the failure this guard exists for. */}
      {!isImporting && spaceBlocked && sizeEstimate && (
        <div
          data-testid="import-space-block"
          className="mb-3 p-3 bg-red-50 border border-red-200 rounded"
        >
          <p className="text-xs text-red-800 font-medium mb-2">
            {/* "up to": the figure is an upper bound by construction — identical
                files are copied once, and that is not subtracted here. */}
            This import needs up to {formatGb(sizeEstimate.attachmentBytes)} for attachments
            {sizeEstimate.availableDiskBytes !== null && (
              <> but only {formatGb(sizeEstimate.availableDiskBytes)} is available</>
            )}
            . It will not start.
          </p>
          <p className="text-xs text-red-700 mb-2">
            Choose a shorter time period above, or import the message text
            without attachment files.
          </p>
          <button
            onClick={() => handleSkipAttachmentsChange(true)}
            data-testid="import-without-attachments"
            className="w-full px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium rounded transition-all"
          >
            Import without attachments
          </button>
        </div>
      )}

      {/* Result display */}
      {lastResult && !isImporting && (
        <div
          data-testid="import-result"
          className={`mb-3 p-2 rounded text-xs ${
            lastResult.cancelled
              ? "bg-yellow-50 text-yellow-700 border border-yellow-200"
              : lastResult.success
                ? "bg-green-50 text-green-700 border border-green-200"
                : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {lastResult.cancelled ? (
            <>
              Import cancelled.{" "}
              {lastResult.messagesImported > 0 && (
                <>
                  <strong>
                    {lastResult.messagesImported.toLocaleString()}
                  </strong>{" "}
                  messages were imported before cancellation.
                </>
              )}
            </>
          ) : lastResult.success ? (
            lastResult.wasForceReimport ? (
              <>
                Re-imported{" "}
                <strong>{lastResult.messagesImported.toLocaleString()}</strong>{" "}
                messages.
              </>
            ) : (
              <>
                Successfully imported{" "}
                <strong>{lastResult.messagesImported.toLocaleString()}</strong>{" "}
                new messages.
              </>
            )
          ) : (
            <>Import failed: {safeErrorMessage(lastResult.error)}</>
          )}
          {/* BACKLOG-2743: non-fatal notice alongside a successful import —
              e.g. the pre-flight refused the attachment copy for disk space. */}
          {lastResult.success && lastResult.warning && (
            <span data-testid="import-warning" className="block mt-1 text-amber-700">
              {lastResult.warning}
            </span>
          )}
        </div>
      )}

      {/* Cap exceeded confirmation prompt */}
      {showCapPrompt && !isImporting && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded">
          <p className="text-xs text-amber-800 font-medium mb-2">
            This time period has {availableCount!.toLocaleString()} messages but your limit is {maxMessages!.toLocaleString()}.
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => { setCapPromptForce(null); handleImport(!!capPromptForce); }}
              className="w-full px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium rounded transition-all"
            >
              {capPromptForce ? "Re-import" : "Import"} most recent {maxMessages!.toLocaleString()} only
            </button>
            <button
              onClick={() => { setCapPromptForce(null); handleImport(!!capPromptForce, true); }}
              className="w-full px-3 py-2 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium rounded transition-all"
            >
              {capPromptForce ? "Re-import" : "Import"} all {availableCount!.toLocaleString()} messages
            </button>
            <button
              onClick={() => setCapPromptForce(null)}
              className="w-full px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-medium rounded transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => {
            if (capExceeded) {
              setCapPromptForce(false);
            } else {
              handleImport(false);
            }
          }}
          // BACKLOG-2743: blocked when the attachment copy would not fit.
          disabled={controlsDisabled || spaceBlocked}
          title={spaceBlocked ? "Not enough free disk space for attachments" : undefined}
          className="flex-1 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isImporting ? "Importing..." : "Import Messages"}
        </button>
        <button
          onClick={() => setShowForceWarning(true)}
          disabled={controlsDisabled || spaceBlocked}
          className="px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          title="Delete all existing messages and re-import from scratch"
        >
          Force Re-import
        </button>
      </div>

      {/*
        BACKLOG-2331: Force re-import confirmation dialog (founder-decided:
        WARN ONLY — no auto-recovery). A force re-import clears + re-imports
        every message row, which cascade-deletes the conversation↔transaction
        junction, so attached conversations become UNLINKED and must be
        re-attached by hand. Gate the destructive path behind an explicit,
        centered-card confirm (ResponsiveModal — the app's shared confirm
        pattern, matching DeleteConfirmModal). The normal import path is NOT
        gated by this dialog.
      */}
      {showForceWarning && (
        <ResponsiveModal
          onClose={() => setShowForceWarning(false)}
          zIndex="z-[70]"
          panelClassName="max-w-md p-6"
          testId="force-reimport-confirm-modal"
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
              Re-import all messages?
            </h3>
          </div>
          <p className="text-sm text-gray-600 mb-6">
            This re-imports your entire message history from scratch and will{" "}
            <strong>unlink your attached conversations</strong> from their
            transactions — you&rsquo;ll need to re-attach them afterward. This
            can take a while.
          </p>
          <div className="flex items-center gap-3 justify-end">
            <button
              onClick={() => setShowForceWarning(false)}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setShowForceWarning(false);
                if (capExceeded) {
                  setCapPromptForce(true);
                } else {
                  handleImport(true);
                }
              }}
              data-testid="force-reimport-confirm"
              className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 rounded-lg font-semibold transition-all"
            >
              Re-import &amp; unlink
            </button>
          </div>
        </ResponsiveModal>
      )}

      {/* Inline progress bar during import (TASK-1752) */}
      {isImporting && (
        <div className="mt-3">
          {importProgress ? (
            <>
              <div className="flex justify-between text-xs text-gray-600 mb-1">
                <span>
                  {importProgress.phase === "deleting"
                    ? "Clearing existing messages..."
                    : importProgress.phase === "attachments"
                      ? "Processing attachments..."
                      : "Importing messages..."}
                </span>
                <span>{importProgress.percent}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all duration-300 ${
                    importProgress.phase === "deleting"
                      ? "bg-orange-500"
                      : importProgress.phase === "attachments"
                        ? "bg-green-500"
                        : "bg-blue-500"
                  }`}
                  style={{ width: `${importProgress.percent}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {importProgress.current.toLocaleString()} /{" "}
                {importProgress.total.toLocaleString()}
                {importProgress.phase === "deleting"
                  ? " cleared"
                  : importProgress.phase === "attachments"
                    ? " attachments"
                    : " messages"}
              </p>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              Preparing import...
            </div>
          )}
        </div>
      )}
      </div>{/* /BACKLOG-2335 muted controls region */}
    </div>
  );
}

export default MacOSMessagesImportSettings;
