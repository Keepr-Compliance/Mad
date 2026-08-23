/**
 * SyncStatusIndicator Component
 *
 * Unified notification component for sync operations on the dashboard.
 * This is the SINGLE notification system - handles both progress AND completion.
 *
 * IMPORTANT: Sync progress is shown for ALL users (not gated by license).
 * AI-specific features (pending transaction count, "Review Now" button) are
 * gated internally via useFeatureGate() hook.
 *
 * TASK-2119: iPhone sync is now rendered from the orchestrator queue like
 * contacts/emails/messages. No more iPhone-specific props.
 *
 * Flow:
 * 1. During sync: Shows progress bar with current operation (all users)
 * 2. After sync: Shows completion message with dismiss button (all users)
 * 3. After dismiss: Disappears completely
 *
 * The completion message adapts based on license and pending count:
 * - If hasAIAddon && pending > 0: Shows "X transactions found" with "Review Now" button
 * - Otherwise: Shows "Sync Complete" with generic success message
 *
 * @module components/dashboard/SyncStatusIndicator
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useFeatureGate } from "../../hooks/useFeatureGate";
import { useSyncOrchestrator } from "../../hooks/useSyncOrchestrator";
import type { SyncType, SyncItemStatus, ReconnectProvider } from "../../services/SyncOrchestratorService";
import logger from "../../utils/logger";
import { openEmailSettings } from "../../utils/openEmailSettings";

interface SyncStatusIndicatorProps {
  /** Pending transaction count (shown in completion message) */
  pendingCount?: number;
  /** Callback when user clicks "Review Now" */
  onViewPending?: () => void;
  /** Callback to open Settings modal (for message cap warnings). Pass a scrollTarget to scroll to a specific section. */
  onOpenSettings?: (scrollTarget?: string) => void;
  /** When true, suppress auto-dismiss so the tour anchor stays visible (TASK-2081) */
  isTourActive?: boolean;
  /** Callback when user clicks "Details" on a sync pill (e.g., iPhone) */
  onViewSyncDetails?: (type: SyncType) => void;
}

/**
 * Get display label for a sync type
 */
const getLabelForType = (type: SyncType): string => {
  switch (type) {
    case 'contacts':
      return 'Contacts';
    case 'emails':
      return 'Emails';
    case 'messages':
      return 'Messages';
    case 'iphone':
      return 'iPhone';
    case 'reindex':
      return 'Reindex';
    case 'backup':
      return 'Backup';
    case 'restore':
      return 'Restore';
    case 'ccpa-export':
      return 'Data Export';
    default:
      return type;
  }
};

/**
 * Status to color mapping for pills
 */
const statusColors: Record<SyncItemStatus, string> = {
  pending: 'bg-gray-100 text-gray-500',
  running: 'bg-blue-100 text-blue-700',
  complete: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  // BACKLOG-2794: a leg the user cancelled before it ran. Gray, like pending —
  // it is the same "nothing happened here" the user is looking at, and it must
  // not read as the green tick of a sync that did.
  skipped: 'bg-gray-100 text-gray-500',
};

/**
 * Unified sync notification - handles progress and completion.
 * All sync types (contacts, emails, messages, iphone) render from the
 * orchestrator queue. No type-specific props needed.
 */
export function SyncStatusIndicator({
  pendingCount = 0,
  onViewPending,
  onOpenSettings,
  isTourActive = false,
  onViewSyncDetails,
}: SyncStatusIndicatorProps) {
  const [showCompletion, setShowCompletion] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const wasSyncingRef = useRef(false);
  const hadErrorsDuringSync = useRef(false);
  const errorItemsDuringSync = useRef<string[]>([]);
  // BACKLOG-2127: capture provider-specific error messages (e.g. "Outlook
  // connection expired — reconnect to sync email") so the completion subtitle
  // names the failure and reconnect action instead of a generic "Failed: emails".
  const errorMessagesDuringSync = useRef<string[]>([]);
  // BACKLOG-2127: capture the TYPED reconnect provider (from the item's
  // reconnectProvider discriminator — NOT parsed from the message) so the
  // completion card can render a provider-aware "Reconnect" CTA that routes to
  // the same Settings navigation as the SystemHealthMonitor banner.
  const reconnectProviderDuringSync = useRef<ReconnectProvider | null>(null);
  const autoDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // BACKLOG-2330: an external sync (e.g. iPhone) cancel empties the orchestrator
  // queue exactly like a genuine completion would, so the running->done
  // transition below would otherwise render a false "Sync Complete" card for a
  // sync the user actually cancelled. Track the orchestrator's cancel counter
  // (captured at sync start) so that transition can tell a cancel apart from a
  // real completion and suppress the card instead of surfacing it.
  const externalCancelCountRef = useRef(0);
  const cancelCountAtSyncStartRef = useRef(0);
  // BACKLOG-2748: the same problem for INTERNAL syncs, which became cancellable
  // only with the import Cancel button. An internal cancel does NOT empty the
  // queue — it lands `status: 'complete'` carrying `cancelled: true` — so the
  // 2330 counter above cannot see it, and the completion card would read the
  // 'complete' status and render green "Sync Complete / All data synced
  // successfully" for a run the user stopped. That is the exact defect
  // BACKLOG-2748 exists to fix, one surface over: the founder cancels in the
  // Settings modal, reads the honest "Import cancelled — N messages imported",
  // closes the modal, and the dashboard behind it congratulates him.
  //
  // Tracked in a ref rather than read off `queue` at completion time for the
  // same reason the error tracking above is: the completion branch also fires
  // when the queue has already emptied, and a flag read from an empty queue is
  // always false.
  const cancelledDuringSync = useRef(false);

  // Get feature gate status for AI-specific features (pending count, Review Now button)
  const { isAllowed } = useFeatureGate();
  const hasAIAddon = isAllowed("ai_detection");

  // Use SyncOrchestrator as single source of truth for sync state
  const { queue, isRunning, externalCancelCount } = useSyncOrchestrator();

  // isRunning from SyncOrchestrator now naturally includes all sync types (including iPhone)
  const isAnySyncing = isRunning;

  // BACKLOG-2330: keep the latest cancel counter in a ref (read inside the
  // running->done effect without adding it to that effect's deps, so a cancel
  // that coincides with the isRunning flip is observed on the same run).
  externalCancelCountRef.current = externalCancelCount;

  useEffect(() => {
    logger.info("[SyncStatusIndicator] Mounted");
    return () => logger.info("[SyncStatusIndicator] Unmounted");
  }, []);

  useEffect(() => {
    const view = (dismissed && !isAnySyncing) ? "hidden(dismissed)" :
      (showCompletion && !isAnySyncing) ? "completion" :
      (!isAnySyncing && queue.length === 0) ? "hidden(empty)" :
      "progress";
    logger.debug(`[SyncStatusIndicator] Rendering: ${view}`, { isRunning, queueLen: queue.length, showCompletion, dismissed });
  }, [isAnySyncing, queue.length, showCompletion, dismissed]);

  // Check if any sync in the queue has an error
  const hasError = queue.some(item => item.status === 'error');

  // Check if any sync item has a warning (e.g., message cap exceeded)
  const syncWarning = queue.find(item => item.warning)?.warning;

  // Track transition from syncing to not syncing
  // NOTE: isTourActive is included in deps to gate auto-dismiss during the onboarding tour.
  // When the tour is active, completion stays visible so the [data-tour="sync-status"] anchor
  // is not removed mid-step. A separate effect below handles starting the timer when the tour ends.
  useEffect(() => {
    if (isAnySyncing) {
      if (!wasSyncingRef.current) {
        // First render of a new sync — reset error tracking
        hadErrorsDuringSync.current = false;
        errorItemsDuringSync.current = [];
        errorMessagesDuringSync.current = [];
        reconnectProviderDuringSync.current = null;
        // BACKLOG-2748: a cancel belongs to the run it stopped, not the next one.
        cancelledDuringSync.current = false;
        // BACKLOG-2330: baseline the cancel counter so a cancel during THIS
        // sync is detectable when it finishes.
        cancelCountAtSyncStartRef.current = externalCancelCountRef.current;
      }
      wasSyncingRef.current = true;
      setDismissed(false);
      // Track errors as they happen during sync
      for (const item of queue) {
        // BACKLOG-2748: a multi-type run (contacts, emails, messages) can land
        // the cancelled messages item while the others are still going, so the
        // flag has to be observed here too and not only at the transition.
        if (item.cancelled) {
          cancelledDuringSync.current = true;
        }
        if (item.status === 'error' && !errorItemsDuringSync.current.includes(item.type)) {
          hadErrorsDuringSync.current = true;
          errorItemsDuringSync.current.push(item.type);
          // BACKLOG-2127: keep the provider-specific message for the subtitle.
          if (item.error) errorMessagesDuringSync.current.push(item.error);
          // BACKLOG-2127: keep the TYPED reconnect provider (first one wins) so
          // the completion card can render a "Reconnect" CTA.
          if (item.reconnectProvider && !reconnectProviderDuringSync.current) {
            reconnectProviderDuringSync.current = item.reconnectProvider;
          }
        }
      }
      // Cancel any pending auto-dismiss timer when new sync starts
      if (autoDismissTimerRef.current) {
        clearTimeout(autoDismissTimerRef.current);
        autoDismissTimerRef.current = null;
      }
      setShowCompletion(false);
    } else if (wasSyncingRef.current && !isAnySyncing && (queue.length === 0 || queue.some(item => item.status === 'complete' || item.status === 'error' || item.status === 'skipped'))) {
      // BACKLOG-2794: 'skipped' joins the terminal set here so a run whose ONLY
      // leg the user cancelled while pending still resolves. It reaches the
      // cancel gate below carrying `cancelled`, which dismisses it silently —
      // the established answer for a user cancel. Without it the run never
      // resolves at all and the indicator holds a stale "Sync:" row until the
      // orchestrator's clean-up timer fires.
      // BACKLOG-2330: if an external sync was cancelled during this run, the
      // queue emptied because the user cancelled (removeExternalSync) — NOT
      // because the sync completed. Do not surface a user-initiated cancel as a
      // dashboard "Sync Complete" card; clear silently instead. (BACKLOG-2333:
      // the iPhone sync modal no longer shows a "Sync Cancelled" screen either —
      // it resets to the clean idle start screen. Cancel = no card, no screen.)
      // This suppression keys off externalCancelCount (bumped by
      // removeExternalSync), independent of the iPhone hook's syncStatus.
      // BACKLOG-1368/2127/2748: scan the finished queue ONCE, before deciding
      // whether to suppress. This loop used to run only after the cancel gate
      // below, which meant a cancel returned early and the run's errors were
      // never recorded — see the ordering note on that gate.
      for (const item of queue) {
        // BACKLOG-2748: catch an internal cancel that only became visible on
        // the transition itself (the single-sync case: the messages item flips
        // to complete+cancelled and `isRunning` goes false in one update).
        if (item.cancelled) {
          cancelledDuringSync.current = true;
        }
        if (item.status === 'error' && !errorItemsDuringSync.current.includes(item.type)) {
          hadErrorsDuringSync.current = true;
          errorItemsDuringSync.current.push(item.type);
          // BACKLOG-2127: keep the provider-specific message for the subtitle.
          if (item.error) errorMessagesDuringSync.current.push(item.error);
          // BACKLOG-2127: keep the TYPED reconnect provider (first one wins) so
          // the completion card can render a "Reconnect" CTA.
          if (item.reconnectProvider && !reconnectProviderDuringSync.current) {
            reconnectProviderDuringSync.current = item.reconnectProvider;
          }
        }
      }

      // A user-initiated cancel gets no card, whichever kind of sync it was:
      // external (2330, queue emptied by removeExternalSync) or internal (2748,
      // queue item completed carrying `cancelled`). Silence rather than a
      // "Sync Cancelled" card is the established answer here, and it is the
      // right one for the import: the Settings panel the user pressed Cancel in
      // already reports the outcome WITH the real partial count, and a second
      // card behind the modal could only repeat it with less information.
      //
      // BUT NEVER over an error. A cancel silences a SUCCESS notice, which
      // costs the user nothing; silencing a FAILURE notice costs them the
      // reason their email stopped syncing and the "Reconnect" CTA that fixes
      // it (BACKLOG-2127). Cancelling the messages leg of a full sync must not
      // hide that the emails leg died. This condition applies to the 2330
      // external path too — deliberately, because two kinds of cancel with two
      // different rules is the hand-kept-rule shape that drifts.
      if (
        (externalCancelCountRef.current !== cancelCountAtSyncStartRef.current ||
          cancelledDuringSync.current) &&
        !hadErrorsDuringSync.current
      ) {
        wasSyncingRef.current = false;
        if (autoDismissTimerRef.current) {
          clearTimeout(autoDismissTimerRef.current);
          autoDismissTimerRef.current = null;
        }
        setShowCompletion(false);
        setDismissed(true);
        return;
      }
      // Just finished syncing - show completion message.
      // BACKLOG-1368: errors are tracked in refs (scanned above, before the
      // cancel gate) so they persist after the queue is cleaned.
      logger.info(`[SyncStatusIndicator] Completion: hadErrors=${hadErrorsDuringSync.current}, queue=${JSON.stringify(queue.map(q => ({ type: q.type, status: q.status })))}`);
      setShowCompletion(true);
      wasSyncingRef.current = false;

      // Only auto-dismiss if tour is NOT active (TASK-2081)
      // BACKLOG-1368: Do NOT auto-dismiss if there were errors — user needs time to read
      if (!isTourActive && !hadErrorsDuringSync.current) {
        autoDismissTimerRef.current = setTimeout(() => {
          setShowCompletion(false);
          setDismissed(true);
          autoDismissTimerRef.current = null;
        }, 3000);
      }

      return () => {
        if (autoDismissTimerRef.current) {
          clearTimeout(autoDismissTimerRef.current);
          autoDismissTimerRef.current = null;
        }
      };
    }
  }, [isAnySyncing, isTourActive]);

  // TASK-2081: When tour ends while completion is still showing, start the auto-dismiss timer.
  // This is a separate effect to avoid re-firing the sync transition logic above.
  useEffect(() => {
    if (!isTourActive && showCompletion && !dismissed && !isAnySyncing && !hadErrorsDuringSync.current) {
      autoDismissTimerRef.current = setTimeout(() => {
        setShowCompletion(false);
        setDismissed(true);
        autoDismissTimerRef.current = null;
      }, 3000);

      return () => {
        if (autoDismissTimerRef.current) {
          clearTimeout(autoDismissTimerRef.current);
          autoDismissTimerRef.current = null;
        }
      };
    }
  }, [isTourActive, showCompletion, dismissed, isAnySyncing]);

  // Handle manual dismiss (also cancels auto-dismiss timer)
  const handleDismiss = useCallback(() => {
    logger.info("[SyncStatusIndicator] Dismiss clicked");
    if (autoDismissTimerRef.current) {
      clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }
    setShowCompletion(false);
    setDismissed(true);
  }, []);

  // Don't render if dismissed and not syncing
  // Note: queue may still contain completed items (internal syncs don't auto-clean),
  // but once dismissed, we should hide regardless of queue contents.
  if (dismissed && !isAnySyncing) {
    return null;
  }

  // Show completion state (after sync finishes)
  if (showCompletion && !isAnySyncing) {
    // Only show pending count styling/message for AI add-on users
    const hasPending = hasAIAddon && pendingCount > 0;

    // Determine completion variant: error (amber) vs success (green/indigo)
    // BACKLOG-1368: If any queue item had an error, show amber "completed with errors"
    // instead of unconditionally showing green "Sync Complete"
    const completionVariant: 'error' | 'pending' | 'success' =
      (hasError || hadErrorsDuringSync.current) ? 'error' : hasPending ? 'pending' : 'success';

    const completionStyles = {
      error: {
        card: 'bg-amber-50 border-amber-200',
        iconBg: 'bg-amber-100',
        title: 'text-amber-900',
        subtitle: 'text-amber-700',
        dismissBtn: 'text-amber-400 hover:text-amber-600 hover:bg-amber-100',
      },
      pending: {
        card: 'bg-gradient-to-r from-indigo-50 to-purple-50 border-indigo-200',
        iconBg: 'bg-indigo-100',
        title: 'text-indigo-900',
        subtitle: 'text-indigo-700',
        dismissBtn: 'text-indigo-400 hover:text-indigo-600 hover:bg-indigo-100',
      },
      success: {
        card: 'bg-green-50 border-green-200',
        iconBg: 'bg-green-100',
        title: 'text-green-800',
        subtitle: 'text-green-600',
        dismissBtn: 'text-green-400 hover:text-green-600 hover:bg-green-100',
      },
    };

    const styles = completionStyles[completionVariant];

    const completionTitle =
      completionVariant === 'error' ? 'Sync Completed with Errors' :
      completionVariant === 'pending' ? `${pendingCount} transaction${pendingCount !== 1 ? "s" : ""} found` :
      'Sync Complete';

    const completionSubtitle =
      completionVariant === 'error'
        // BACKLOG-2127: prefer the provider-specific reconnect message
        // (e.g. "Outlook connection expired — reconnect to sync email") over
        // the generic "Failed: emails".
        ? (errorMessagesDuringSync.current.length > 0
            ? errorMessagesDuringSync.current.join(' ')
            : `Failed: ${errorItemsDuringSync.current.join(', ')}`) :
      completionVariant === 'pending' ? 'New transactions detected and ready for review' :
      'All data synced successfully';

    return (
      <div
        className={`${styles.card} border rounded-xl p-4 mb-4 animate-fade-in`}
        data-testid="sync-status-complete"
      >
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            {/* Icon */}
            <div
              className={`w-10 h-10 ${styles.iconBg} rounded-full flex items-center justify-center flex-shrink-0`}
            >
              {completionVariant === 'pending' ? (
                <svg
                  className="w-5 h-5 text-indigo-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                  />
                </svg>
              ) : completionVariant === 'error' ? (
                <svg
                  className="w-5 h-5 text-amber-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              ) : (
                <svg
                  className="w-5 h-5 text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
            </div>

            {/* Message */}
            <div>
              <h3
                className={`text-sm font-semibold ${styles.title}`}
              >
                {completionTitle}
              </h3>
              <p
                className={`text-xs ${styles.subtitle}`}
              >
                {completionSubtitle}
              </p>
              {completionVariant === 'error' && (
                <p className="text-xs text-amber-600 mt-1">
                  If this persists, please <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('open-support-widget', { detail: { subject: `Sync Error: ${errorItemsDuringSync.current.join(', ')}` } }))} className="underline hover:text-amber-800">submit a support ticket</button>.
                </p>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {/* BACKLOG-2127: provider-aware Reconnect CTA for a dead OAuth token.
                Gated on the TYPED reconnectProvider discriminator (not message
                text) and routes to the SAME Settings navigation as the
                SystemHealthMonitor banner. */}
            {completionVariant === 'error' && reconnectProviderDuringSync.current && onOpenSettings && (
              <button
                onClick={() => {
                  logger.info("[SyncStatusIndicator] Reconnect clicked", reconnectProviderDuringSync.current ?? undefined);
                  openEmailSettings(onOpenSettings);
                }}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
                data-testid="sync-reconnect-button"
              >
                Reconnect {reconnectProviderDuringSync.current === 'microsoft' ? 'Outlook' : 'Gmail'}
              </button>
            )}
            {completionVariant === 'pending' && onViewPending && (
              <button
                onClick={onViewPending}
                className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
              >
                Review Now
              </button>
            )}
            <button
              onClick={handleDismiss}
              className={`p-2 ${styles.dismissBtn} rounded-lg transition-colors`}
              title="Dismiss"
              aria-label="Dismiss notification"
            >
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Message cap warning */}
        {syncWarning && onOpenSettings && (
          <div className="mt-2 flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl p-3">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <p className="text-xs text-amber-700">{syncWarning}</p>
            </div>
            <button
              onClick={() => onOpenSettings?.('settings-import-filters')}
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap ml-3"
            >
              Adjust Limits
            </button>
          </div>
        )}
      </div>
    );
  }

  // Don't render if no sync is in progress and queue is empty
  if (!isAnySyncing && queue.length === 0) {
    return null;
  }

  // Don't render stale completed/errored pills after remount (e.g., parent re-render
  // after sync already completed and auto-dismissed). If we never saw a sync in this
  // mount cycle (wasSyncingRef is false) and all items are done, this is stale state
  // from a previous sync cycle — hide it until the orchestrator cleans up the queue.
  // BACKLOG-2794: 'skipped' is terminal, so a queue holding one is just as
  // stale as one holding completes and errors. Omitted, a remount after a
  // skipped run would re-show the row this guard exists to hide.
  if (!isAnySyncing && !showCompletion && !wasSyncingRef.current &&
      queue.length > 0 && queue.every(item => item.status === 'complete' || item.status === 'error' || item.status === 'skipped')) {
    return null;
  }

  // Get the currently running non-external sync's progress for percentage display
  const runningInternalItem = queue.find(item => item.status === 'running' && !item.external);
  const activeProgress = runningInternalItem?.progress ?? null;

  // Render a status pill for each sync item in queue order
  const renderPill = (type: SyncType, status: SyncItemStatus, progress: number, error?: string, phase?: string, isExternal?: boolean, cancelRequested?: boolean, coalesced?: boolean) => {
    const baseLabel = getLabelForType(type);
    // Show phase for running syncs (e.g., "Messages - querying", "iPhone - Exporting")
    const friendlyPhase = phase ? ({
      backing_up: 'Exporting',
      preparing: 'Preparing',
      extracting: 'Reading messages',
      storing: 'Saving',
      complete: 'Done',
    }[phase] ?? phase) : undefined;
    // BACKLOG-2776: once the user has pressed Cancel this pill stops reporting
    // the phase. The percentage beside it is already frozen (the orchestrator
    // drops progress updates for a cancel-requested item), and a pill that kept
    // announcing "Messages - querying" next to a frozen number would be the
    // dashboard contradicting the Settings panel about whether the cancel had
    // been heard.
    const label = status === 'running' && cancelRequested
      ? `${baseLabel} - Cancelling`
      : status === 'running' && friendlyPhase ? `${baseLabel} - ${friendlyPhase}` : baseLabel;
    const colorClass = statusColors[status];

    // BACKLOG-2794: this leg joined an import that was already running. It is
    // 'complete' — no error, and the run's completion card still reports the
    // legs that did work — but a green tick would claim this leg imported
    // something, and the import it joined may still be going. Blue and named,
    // the way a running leg is.
    if (status === 'complete' && coalesced) {
      return (
        <span
          key={type}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColors.running}`}
          data-testid={`sync-pill-${type}`}
        >
          {baseLabel} - Already importing
        </span>
      );
    }

    // BACKLOG-2794: cancelled while it was still queued, so it never ran.
    if (status === 'skipped') {
      return (
        <span
          key={type}
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colorClass}`}
          data-testid={`sync-pill-${type}`}
        >
          {baseLabel} - Skipped
        </span>
      );
    }

    // Error state - red with tooltip
    if (status === 'error') {
      return (
        <span
          key={type}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colorClass} cursor-help`}
          title={error || 'Sync failed'}
          data-testid={`sync-pill-${type}`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          {baseLabel}
        </span>
      );
    }

    // Complete state - green with checkmark
    if (status === 'complete') {
      return (
        <span
          key={type}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colorClass}`}
          data-testid={`sync-pill-${type}`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {baseLabel}
        </span>
      );
    }

    // Running state - blue with spinner for external syncs, plain for internal
    if (status === 'running') {
      return (
        <span
          key={type}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colorClass}`}
          data-testid={`sync-pill-${type}`}
        >
          {isExternal && (
            <div className="w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
          )}
          {label}
        </span>
      );
    }

    // Pending state - gray
    return (
      <span
        key={type}
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colorClass}`}
        data-testid={`sync-pill-${type}`}
      >
        {baseLabel}
      </span>
    );
  };

  // Determine background color: red if error, blue default
  const bgClass = hasError
    ? 'bg-red-50 border-red-200'
    : 'bg-blue-50 border-blue-200';
  const textClass = hasError
    ? 'text-red-800'
    : 'text-blue-800';
  const iconClass = hasError
    ? 'text-red-600'
    : 'text-blue-600';

  // Check if any external sync (e.g., iPhone) is active for "Details" link
  const activeExternalItem = queue.find(item => item.external && (item.status === 'running' || item.status === 'complete' || item.status === 'error'));

  // Show compact sync progress
  return (
    <div
      className={`${bgClass} border rounded-lg px-3 py-2 mb-3 animate-fade-in`}
      data-testid="sync-status-indicator"
    >
      {/* Status pills row - render in queue order */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {/* Spinning sync icon (counter-clockwise) */}
        <svg
          className={`w-4 h-4 ${iconClass} ${isAnySyncing ? 'animate-spin' : ''} flex-shrink-0`}
          style={isAnySyncing ? { animationDirection: 'reverse' } : undefined}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span className={`text-xs font-medium ${textClass}`}>
          {isAnySyncing ? 'Syncing:' : hasError ? 'Sync Error:' : 'Sync:'}
        </span>
        {/* Render all pills in queue order (contacts, emails, messages, iphone) */}
        {queue.map((item) => renderPill(item.type, item.status, item.progress, item.error, item.phase, item.external, item.cancelRequested, item.coalesced))}
        {/* Show progress percentage for internal syncs only */}
        {activeProgress !== null && (
          <span className="text-xs text-blue-600 ml-auto">{Math.round(activeProgress)}%</span>
        )}
        {/* "Details" link for external syncs (e.g., iPhone) */}
        {activeExternalItem && onViewSyncDetails && (
          <button
            onClick={() => { logger.info("[SyncStatusIndicator] Details clicked", activeExternalItem.type); onViewSyncDetails(activeExternalItem.type); }}
            className="ml-auto p-0.5 text-blue-500 hover:text-blue-700 transition-colors"
            data-testid="sync-view-details"
            title="View sync details"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        )}
      </div>

      {/* Progress bar hidden -- IPC flushing issue causes jumpy updates (BACKLOG-824) */}

      {/* Disabled tools notice - only show when syncing */}
      {isAnySyncing && (
        <p className="text-xs text-blue-600 mt-2 text-center">
          Audit tools are disabled during sync to ensure accurate data
        </p>
      )}
    </div>
  );
}

export default SyncStatusIndicator;
