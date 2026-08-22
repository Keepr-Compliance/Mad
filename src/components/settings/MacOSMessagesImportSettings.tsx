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
// BACKLOG-2749: the ONE pre-import dialog. It replaces the inline amber cap
// prompt and the inline red space-refusal block — surfaces that each worked out
// the same decision from whatever numbers were nearest to hand, and
// contradicted each other on the founder's machine (2026-08-22).
import {
  ImportPlanDialog,
  type ImportPlanDialogReason,
  type FittingWindowCandidate,
  type FittingWindowStatus,
} from "./ImportPlanDialog";
import type { MessageImportPlanFacts } from "@electron/types/ipc/window-api-messages";
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

/**
 * Cap shown when the user has stored NO `maxMessages` preference.
 *
 * BACKLOG-2749: must equal `DEFAULT_MAX_MESSAGES` in
 * `electron/services/importPlan.ts`, which is what the resolver actually
 * enforces. Duplicated here for the same reason `DEFAULT_LOOKBACK_MONTHS` is —
 * the renderer cannot value-import from `electron/` — and pinned by
 * `__tests__/MacOSMessagesImportSettings.onePlanDialog-2749.test.tsx`.
 *
 * It exists because the absent key was being read as "Unlimited". The panel did
 * `maxMessages ?? null`, and `null` is what this dropdown writes for an explicit
 * Unlimited, so a user who had only ever changed the LOOKBACK — which leaves
 * `maxMessages` absent through the preferences deep-merge, the exact shape
 * BACKLOG-2561 documented — saw "Unlimited" while their run was capped at
 * 50,000 by `resolveMaxMessages`. That is this item's own invariant broken in
 * the quietest possible way: the setting said one thing and the run did another,
 * with no dialog in between because the panel believed there was no cap to
 * disclose. It is the renderer half of BACKLOG-2733, which was fixed in the
 * resolver alone.
 */
const DEFAULT_MAX_MESSAGES = 50000;

/**
 * BACKLOG-2749: drop the orchestrator's cap sentence from a completion warning.
 *
 * `SyncOrchestratorService` builds it as `totalAvailable - messagesImported` —
 * the window minus what THIS RUN downloaded. A delta import skips messages it
 * already has, so those already-present messages get counted as excluded: the
 * founder's restore reported **659,619 messages excluded by import limit** when
 * the true figure was 645,576 (708,400 − 62,824). The number is wrong in the
 * alarming direction, and it is the last thing he reads after a long import.
 *
 * The correct sentence is rendered by this panel from the plan the run was
 * consented to (`runCoverageRef`). This function removes the wrong one so the
 * two cannot both be on screen — while PRESERVING the disk-space clause the
 * orchestrator appends to the same string, which is accurate and is the only
 * notice that attachments were skipped.
 *
 * It is a targeted removal of one known producer's one known sentence, and it
 * is deliberately anchored (`^`) so it can only ever strip a leading cap
 * clause. The durable fix is arithmetic the orchestrator itself does not do —
 * it would need the admitted count on the import result, which lives in
 * `macOSMessagesImportService` and `SyncOrchestratorService`, both owned by
 * other engineers this cycle. Recorded as a residual: until that lands, the
 * DASHBOARD's sync indicator still renders the wrong figure.
 */
export function stripStaleCapClause(
  warning: string | undefined
): string | undefined {
  if (!warning) return warning;
  const stripped = warning
    .replace(
      /^[\d,]+ messages excluded by import limit\. Adjust in Settings\.\s*/,
      ""
    )
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

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
  const { queue, requestSync, markCancelRequested } = useSyncOrchestrator();

  // Derive importing state from orchestrator queue
  const messagesItem = queue.find(q => q.type === 'messages');
  const isImporting = messagesItem?.status === 'running' || messagesItem?.status === 'pending';

  // BACKLOG-2335: Disable every interactive control when macOS is not the active
  // import source (or while an import is running). Without this the filter
  // selects + Import / Force Re-import buttons stay clickable but silently no-op
  // (SyncOrchestrator skips macOS import for non-`macos-native` sources), which
  // reads to the user as "Re-imported 0 messages".
  const controlsDisabled = !enabled || isImporting;

  // BACKLOG-2748: Cancel is offered ONLY while the import is actually running,
  // never while the queue item is merely 'pending'.
  //
  // BACKLOG-2776 UPDATED the reason. It used to be that a cancel arriving before
  // the main process had set `isImporting` was dropped outright; the service now
  // HOLDS such a cancel and the next run to start consumes it, so the button is
  // no longer a placebo in the sub-second window between 'running' and the
  // import taking hold. What it cannot do is span the 'pending' window: a
  // dashboard sync of ['contacts', 'emails', 'messages'] leaves the messages
  // item pending for the whole contacts+emails run — minutes — and a cancel held
  // that long would fire at an import the user has since forgotten asking to
  // stop, so the service expires it (PENDING_CANCEL_TTL_MS). The gate stays.
  // Held-cancel proof: `macOSMessagesImportService.cancel-2748.test.ts`.
  const cancelAvailable = messagesItem?.status === 'running';

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
    /**
     * BACKLOG-2775: the cancelled run was a force re-import and it rolled back,
     * so nothing changed. Carried from the main process rather than inferred
     * from `wasForceReimport`, which only records what this panel ASKED for.
     */
    rolledBack?: boolean;
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

  // BACKLOG-2748: the cancel has been sent and the import has not stopped yet.
  // The main process honours cancellation at the next batch/attachment
  // boundary, so there is a real gap between the click and the stop — the
  // button says so rather than looking dead.
  //
  // BACKLOG-2776: this lives on the orchestrator queue item, not in component
  // state, because the dashboard's SyncStatusIndicator renders the same import
  // from the same item. Component state left that indicator advancing its
  // percentage while this panel said "Cancelling…" — two surfaces disagreeing
  // about whether the user had been heard. It also survives this panel
  // unmounting, e.g. closing Settings mid-cancel.
  const cancelRequested = messagesItem?.cancelRequested === true;

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
  /**
   * Messages the SELECTION covers, before the cap (BACKLOG-2772).
   *
   * `availableCount` became what the run will actually import once the
   * estimate started applying Cap\u2032. Comparing THAT against the cap can
   * never exceed it, so the cap warning would have gone silent exactly when
   * it matters most.
   */
  const [windowCount, setWindowCount] = useState<number | null>(null);

  /**
   * BACKLOG-2749: the resolved plan's own facts, as main returned them.
   *
   * The dialog states the cap; the cap is a decision the RESOLVER makes, and it
   * is not recoverable from the counts. Under Cap' the admitted set is
   * `protected ∪ (the newest `cap` unprotected messages)`, so with deals in
   * range the admitted count is legitimately larger than the cap — the founder's
   * 50,000 limit admitting 62,823 messages. Any surface that guesses the cap
   * from the counts gets that case wrong, which is the contradiction this item
   * exists to end.
   *
   * `null` until the first estimate lands, and for a response from a main
   * process that predates BACKLOG-2749.
   */
  const [planFacts, setPlanFacts] = useState<MessageImportPlanFacts | null>(null);

  // BACKLOG-2743: Selection-time size estimate. Before this, choosing "All time"
  // showed a message count and nothing about size, so an import whose
  // attachments exceeded the disk looked identical to one that fit.
  const [sizeEstimate, setSizeEstimate] = useState<{
    attachmentBytes: number;
    attachmentCount: number;
    availableDiskBytes: number | null;
    fitsOnDisk: boolean;
  } | null>(null);

  /**
   * BACKLOG-2760: What we currently know about the selected window's size.
   *
   * `sizeEstimate === null` used to carry three different meanings at once —
   * "not asked yet", "asked and failed", and "asked, nothing to report" — and
   * every one of them left Import ENABLED. An unknown size therefore permitted
   * the copy, which is the wrong direction for a disk-capacity guard. This makes
   * the state explicit so the unknown cases can refuse.
   *
   * - `pending`     a request for THIS window is in flight (or not yet gated in)
   * - `ready`       a response for THIS window arrived; `sizeEstimate` is its verdict
   * - `unavailable` main could not size this window (`{success:false}`, or the IPC threw)
   */
  const [estimateStatus, setEstimateStatus] = useState<
    "pending" | "ready" | "unavailable"
  >("pending");

  /**
   * BACKLOG-2760: Monotonic id of the newest estimate request.
   *
   * The IPC cannot be aborted, so a superseded request WILL still resolve; the
   * only defence is to ignore its answer. Captured per effect run and compared
   * on resolution. It is never reset, which is what makes it safe under
   * StrictMode's double-invoked effects (both requests go out, only the newer
   * one is allowed to write).
   */
  const estimateRequestIdRef = useRef(0);

  /**
   * BACKLOG-2760: Whether the two async inputs to the estimate have SETTLED.
   *
   * Both are flipped in a `finally`, not on success: `loadFilterPreferences` and
   * `loadEffectiveWindow` both swallow their errors, and a failed load still
   * means "this is as much as we will ever know", so the estimate must proceed
   * from the component's defaults rather than hang pending forever.
   */
  const [prefsSettled, setPrefsSettled] = useState(false);
  const [windowSettled, setWindowSettled] = useState(false);
  const estimateInputsReady = prefsSettled && windowSettled;

  // BACKLOG-2743: "Import without attachments" — the escape hatch that makes a
  // refusal actionable. Message text is a small fraction of attachment size, so
  // this always fits when the full import does not.
  const [skipAttachments, setSkipAttachments] = useState(false);

  /**
   * BACKLOG-2749: the ONE pre-import dialog's state.
   *
   * Replaces `capPromptForce` (an inline amber prompt) and the inline red
   * space-refusal block. `reason` decides which decision it is presenting;
   * `isReimport` carries the verb through, and nothing else — under D2' both
   * modes cover the same window, so every NUMBER is identical either way.
   */
  const [dialog, setDialog] = useState<{
    reason: ImportPlanDialogReason;
    isReimport: boolean;
  } | null>(null);

  /**
   * The cap the RUN will enforce.
   *
   * Read off the resolved plan, because the plan is what enforces it. The
   * dropdown (`maxMessages`) is the user's *stated* preference and is the
   * fallback only until the first estimate lands — before which no dialog can
   * open anyway, since the window count it compares against is unknown too.
   */
  const planCap = planFacts ? planFacts.effectiveCap : maxMessages;

  // BACKLOG-2772: compare the WINDOW against the cap, not the already-capped
  // admitted count.
  const capExceeded =
    windowCount !== null && planCap !== null && windowCount > planCap;

  /**
   * BACKLOG-2749: protected audit history rides along with the cap.
   *
   * Two independently-sourced facts compared — the resolver's cap and the
   * estimate's admitted count — not one derived from the other. Under Cap' they
   * are equal exactly when nothing is protected.
   */
  const hasProtectedHistory =
    availableCount !== null && planCap !== null && availableCount > planCap;

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
  //
  // BACKLOG-2760: this effect used to run on MOUNT, against the component's
  // initial `useState(DEFAULT_LOOKBACK_MONTHS)`, before the stored preference had
  // loaded — and then again once it had. Nothing sequenced the two responses.
  // On the founder's machine (707,956 messages, ~61 GB of attachments) the cheap
  // 3-month response resolved LAST and overwrote the correct all-time one, so
  // Settings reported "12,074 messages and about 2.6 GB". 2.6 GB fits in 59 GB,
  // so `fitsOnDisk` was true and BACKLOG-2743's refusal never fired for a copy
  // that could not possibly fit. Traced from the main-process request log, which
  // shows all four requests going out with the RIGHT filters — the bug was never
  // in what was asked, only in which answer was allowed to win.
  //
  // Three changes, each load-bearing:
  //   1. GATE on `estimateInputsReady` — no estimate is requested for a window
  //      the user did not choose, so the stale answer no longer exists to race.
  //      Gating on the preference alone is not enough: a lookback of 3 months
  //      that an audit period widens to 12 would be estimated at 3 months if we
  //      fired between the two loads, which under-states in the same direction.
  //   2. SEQUENCE-GUARD every response, because the IPC cannot be aborted and a
  //      superseded request still resolves.
  //   3. Go PENDING on every run, not just the first. Without that, switching
  //      from a window that fits to one that does not leaves the old "fits"
  //      verdict on screen — and Import clickable — for as long as the new
  //      estimate takes, which on a large library is seconds of open door.
  useEffect(() => {
    if (!isMacOS) return;
    if (!estimateInputsReady) return;

    const requestId = ++estimateRequestIdRef.current;
    // Nothing known about THIS window yet. Import is refused until it is.
    setEstimateStatus("pending");
    setSizeEstimate(null);
    setAvailableCount(null);
    setWindowCount(null);
    setPlanFacts(null);

    const fetchCount = async () => {
      try {
        // BACKLOG-2772: state the SELECTION only. The audit floor used to be
        // computed here and sent back down, which made this panel one of four
        // places deciding what an import covers; main derives the deal spans
        // itself now, from the same query the export gate reads.
        const result = await window.api.messages.getImportCount(userId, {
          lookbackMonths,
        });
        // A newer window is being estimated; this answer describes a window the
        // user is no longer looking at. Dropping it is the whole fix.
        if (requestId !== estimateRequestIdRef.current) return;

        if (!result.success) {
          // `getAvailableMessageCount` returns `{success:false}` for any internal
          // failure and logs nothing. This branch used to be absent, so a failed
          // estimate silently left whatever was on screen standing.
          setEstimateStatus("unavailable");
          return;
        }

        setAvailableCount(result.filteredCount ?? result.count ?? null);
        setWindowCount(result.windowCount ?? result.count ?? null);
        // BACKLOG-2749: carried, never reconstructed. See `planFacts`.
        setPlanFacts(result.plan ?? null);
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
        setEstimateStatus("ready");
      } catch {
        if (requestId !== estimateRequestIdRef.current) return;
        setEstimateStatus("unavailable");
      }
    };
    fetchCount();
  }, [
    isMacOS,
    estimateInputsReady,
    lookbackMonths,
    effectiveWindow?.effectiveCutoffISO,
  ]);

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
    } finally {
      // BACKLOG-2760: settled, not succeeded. A failed read means the label falls
      // back to the plain lookback copy — that IS the final answer for this input,
      // so the estimate must be allowed to proceed rather than wait forever.
      setWindowSettled(true);
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
          // BACKLOG-2749: an ABSENT key is "no preference", not "Unlimited" —
          // the same distinction BACKLOG-2561 drew for the lookback and
          // BACKLOG-2733 drew inside the resolver. `?? null` showed
          // "Unlimited" in this dropdown while the resolver capped the run at
          // 50,000. Only an explicit `null` means Unlimited.
          setMaxMessages(
            messageImport.filters.maxMessages === undefined
              ? DEFAULT_MAX_MESSAGES
              : messageImport.filters.maxMessages
          );
          // BACKLOG-2743: absent preference means "import attachments" (prior behavior).
          setSkipAttachments(messageImport.filters.skipAttachments === true);
        }
      }
    } catch {
      // Silently handle - use defaults
    } finally {
      // BACKLOG-2760: settled, not succeeded — see loadEffectiveWindow. On a
      // failed read the component's defaults ARE the effective preference, so
      // estimating from them is correct; hanging pending would not be.
      setPrefsSettled(true);
    }
  };

  // TASK-1952: Save lookback months filter
  const handleLookbackChange = async (value: string) => {
    const months = value === "all" ? null : Number(value);
    setLookbackMonths(months);
    setLastResult(null);
    setDialog(null);
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
    setDialog(null);
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

  // BACKLOG-2760: the estimate has produced an answer for the CURRENT window.
  // `ready` with a null `sizeEstimate` is a real answer — main reported no
  // attachment figures for this window, so there is nothing to enforce. That is
  // not the same as not knowing, and it is unreachable in production (the
  // success path always carries the figures); it is kept permissive so a
  // response that says nothing about size cannot deadlock the panel.
  const estimateResolved = estimateStatus === "ready";

  // BACKLOG-2743: True when the attachment copy does NOT fit and the user has
  // not chosen to skip attachments. Import is BLOCKED in this state — there is
  // deliberately no "import anyway" override, because an override is exactly
  // what would let the disk fill and evict the user's Time Machine snapshots.
  //
  // BACKLOG-2760: an UNKNOWN size now blocks too. Previously the block required a
  // resolved-and-negative verdict, so "still loading" and "could not size it"
  // both sailed through — the guard's default answer was yes. A disk-capacity
  // control has to default to no.
  //
  // Still gated on `!skipAttachments`: the verdict concerns the ATTACHMENT copy,
  // and message text is a small fraction of it. Text-only always fits, so an
  // unknown attachment size must not strand the user with no way through —
  // that escape hatch is the reason the refusal is actionable at all.
  //
  // BACKLOG-2749 SPLIT this into its two halves, because they now behave
  // differently and only one of them was ever about the button.
  //
  //   - The size is UNKNOWN (pending / unavailable). Nothing can be offered,
  //     because nothing is known: the button stays disabled and the inline
  //     notice says which of the two unknowns it is. Unchanged.
  //   - The size is KNOWN and does not fit. There IS something to offer — a
  //     shorter window that does fit, or text-only — and the founder's decision
  //     (`2259031c`) is that the refusal computes that way out and presents it.
  //     So this half moved into the dialog: the button is enabled and the click
  //     opens the refusal.
  //
  // The guarantee is unchanged: there is still no path from this state to a
  // started import. The dialog offers a narrower window, text-only, or Cancel,
  // and every one of them re-verifies fit at the pre-flight.
  const spaceUnknown = !skipAttachments && !estimateResolved;
  const spaceRefused =
    !skipAttachments &&
    estimateResolved &&
    sizeEstimate !== null &&
    !sizeEstimate.fitsOnDisk;
  const spaceBlocked = spaceUnknown;

  // BACKLOG-2760: why Import is refused, for the button tooltip. Three distinct
  // reasons now share one disabled state, and "not enough space" would be a lie
  // for the two where the space is simply unknown.
  // BACKLOG-2749: the third reason ("not enough free disk space") is gone from
  // here because that state no longer disables the button — it opens the
  // refusal dialog, which says considerably more than a tooltip could.
  const spaceBlockedReason =
    estimateStatus === "pending"
      ? "Still checking how much space this import needs"
      : "Keepr could not work out how much space this import needs";

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

  /**
   * BACKLOG-2749: what the RUNNING import was told it would cover.
   *
   * Captured at the moment the run is requested, so the completion surface
   * reports the arithmetic the user consented to rather than re-deriving it
   * from whatever the panel knows afterwards. Every control is disabled for the
   * duration of the run, and these figures describe the source library plus the
   * resolved plan — neither of which the import changes.
   *
   * The ONE way it can be wrong is a run whose window is not the window the
   * estimate described, and there is exactly one such path: the refusal
   * dialog's fitting-window button, which changes the lookback and imports in
   * the same click. That path passes `windowChanged` and this ref is left null,
   * so the panel says nothing rather than something false. See `handleImport`.
   *
   * This exists because the completion surface got the arithmetic wrong. The
   * orchestrator computes `window - imported-this-run`, which counted the
   * founder's 14,042 already-present messages as EXCLUDED and told him 659,619
   * messages had been left out when the true figure was 645,576 (`a14b3a82`).
   * A delta import does not re-download what it already has, so what a run
   * FETCHES and what the store COVERS are different numbers, and only the
   * second one belongs in a sentence about exclusion.
   */
  const runCoverageRef = useRef<{
    windowCount: number;
    admittedCount: number;
    cap: number | null;
    /** The user chose "import everything", so the cap excluded nothing. */
    capOverridden: boolean;
  } | null>(null);

  /**
   * BACKLOG-2749: the completed run's coverage, for the result card.
   *
   * Separate from `lastResult` because it is a fact about the PLAN, not about
   * the outcome, and it must survive `lastResult` being rebuilt.
   */
  const [lastCoverage, setLastCoverage] = useState<{
    windowCount: number;
    admittedCount: number;
    excluded: number;
  } | null>(null);

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
    async (
      forceReimport = false,
      overrideCap = false,
      /**
       * BACKLOG-2749: this run uses a DIFFERENT window from the one the panel's
       * estimate describes, so there is no coverage it can honestly promise.
       *
       * Exactly one path sets it: the refusal dialog's fitting-window button,
       * which moves the lookback and imports in the same click. `windowCount` /
       * `availableCount` still hold the figures for the window the user just
       * declined, so reporting "covers 62,824 of 708,400" after a 12-month run
       * would put a false statement on the completion surface — the single
       * thing this item exists to stop. The panel could instead wait for the
       * new estimate, but that is a race against an IPC for a sentence it can
       * simply decline to say.
       */
      windowChanged = false
    ) => {
      if (!userId || isImporting) return;

      // BACKLOG-2329: record the path so the completion copy matches it.
      lastForceReimportRef.current = forceReimport;

      // BACKLOG-2749: record what this run was told it would cover, so the
      // completion surface can state the coverage arithmetic rather than the
      // fetch-volume one. See `runCoverageRef`.
      runCoverageRef.current =
        !windowChanged && windowCount !== null && availableCount !== null
          ? {
              windowCount,
              admittedCount: availableCount,
              cap: planCap,
              capOverridden: overrideCap,
            }
          : null;
      setLastCoverage(null);

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
    [userId, isImporting, maxMessages, requestSync, windowCount, availableCount, planCap]
  );

  // ---------------------------------------------------------------------------
  // BACKLOG-2749: the one gate every Import / Re-import click passes through.
  // ---------------------------------------------------------------------------

  /**
   * The dropdown's own windows, largest first.
   *
   * Deliberately the SAME list the "Import messages from" select offers: the
   * refusal must not invent a window the user cannot then see selected, and
   * clicking the offered button really does move that dropdown.
   */
  const LOOKBACK_PRESETS = [24, 18, 12, 9, 6, 3] as const;

  const [fittingWindow, setFittingWindow] =
    useState<FittingWindowCandidate | null>(null);
  const [fittingWindowStatus, setFittingWindowStatus] =
    useState<FittingWindowStatus>("searching");
  /** Monotonic id of the newest fitting-window search; older ones may not write. */
  const fittingSearchIdRef = useRef(0);

  /**
   * BACKLOG-2749 / founder decision `2259031c`: compute the way out.
   *
   * Asks main for a real estimate of each candidate window, LARGEST FIRST, and
   * stops at the first one that fits. Every byte figure and every fit verdict
   * is main's, resolved through the same plan the run would use — the renderer
   * only SELECTS among answers, it does not scale or interpolate one window's
   * figure into another's.
   *
   * Run on the refusal path only, from the click that opens the dialog rather
   * than from an effect. The happy path pays nothing, and doing it in the
   * action sidesteps StrictMode's double-invoked effects entirely.
   *
   * "Nothing fits" is an ANSWER, not a failure: when deal audit periods force
   * the window open, every candidate comes back the same size and no button
   * appears. That is the founder's hiding rule, and it falls out of this loop
   * rather than needing its own condition.
   */
  const findFittingWindow = useCallback(
    async (searchId: number) => {
      const candidates = LOOKBACK_PRESETS.filter(
        (months) => lookbackMonths === null || months < lookbackMonths
      );

      for (const months of candidates) {
        try {
          const result = await window.api.messages.getImportCount(userId, {
            lookbackMonths: months,
          });
          if (searchId !== fittingSearchIdRef.current) return;
          if (
            result.success &&
            result.fitsOnDisk !== false &&
            result.attachmentBytes !== undefined
          ) {
            setFittingWindow({
              lookbackMonths: months,
              attachmentBytes: result.attachmentBytes,
            });
            setFittingWindowStatus("found");
            return;
          }
        } catch (error) {
          // A candidate we cannot size is a candidate we cannot offer. Try the
          // next, shorter one — never assume it fits.
          logger.error(
            "[MacOSMessagesImportSettings] Fitting-window estimate failed:",
            error
          );
          if (searchId !== fittingSearchIdRef.current) return;
        }
      }

      if (searchId !== fittingSearchIdRef.current) return;
      setFittingWindowStatus("none");
    },
    [userId, lookbackMonths]
  );

  /**
   * Decide which surface a click on Import / Force Re-import reaches.
   *
   * ORDER IS LOAD-BEARING. The space refusal outranks the cap choice: an import
   * that cannot fit on the disk must not be offered a choice between two sizes
   * of import that both fail, and "Import all N messages" is the larger of the
   * two.
   */
  const beginImport = useCallback(
    (forceReimport: boolean) => {
      if (spaceRefused) {
        const searchId = ++fittingSearchIdRef.current;
        setFittingWindow(null);
        setFittingWindowStatus("searching");
        setDialog({ reason: "space", isReimport: forceReimport });
        void findFittingWindow(searchId);
        return;
      }
      if (capExceeded) {
        setDialog({ reason: "cap", isReimport: forceReimport });
        return;
      }
      handleImport(forceReimport);
    },
    [spaceRefused, capExceeded, findFittingWindow, handleImport]
  );

  /** Close the dialog and abandon any fitting-window search still running. */
  const closeDialog = useCallback(() => {
    fittingSearchIdRef.current += 1;
    setDialog(null);
  }, []);

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

      // BACKLOG-2749: state the COVERAGE this run was consented to, computed
      // the way the founder settled it — window MINUS admitted coverage.
      //
      // Only when the limit genuinely left something out: a run whose window
      // fits under the cap excluded nothing, and an "import everything" run
      // cleared the cap for itself so it excluded nothing either. Saying "0
      // outside your limit" in those cases would be noise about a limit that
      // did not act.
      const coverage = runCoverageRef.current;
      setLastCoverage(
        coverage && !coverage.capOverridden &&
          coverage.windowCount > coverage.admittedCount
          ? {
              windowCount: coverage.windowCount,
              admittedCount: coverage.admittedCount,
              excluded: coverage.windowCount - coverage.admittedCount,
            }
          : null
      );

      setLastResult({
        success: true,
        messagesImported,
        // BACKLOG-2748: a cancelled run completes rather than errors, so it
        // arrives here — and must be reported as a cancel with the partial
        // count it really kept, not as "Successfully imported N new messages".
        cancelled: messagesItem.cancelled || undefined,
        // BACKLOG-2775: distinguishes "you stopped it and kept N" from "you
        // stopped it and nothing changed".
        rolledBack: messagesItem.rolledBack || undefined,
        wasForceReimport,
        // BACKLOG-2749: `wasCapped` used to be "the orchestrator sent SOME
        // warning", which conflated the cap warning with the disk-space one.
        // It is a fact about the plan, and the plan is what recorded it.
        wasCapped:
          (coverage && !coverage.capOverridden &&
            coverage.windowCount > coverage.admittedCount) || undefined,
        // BACKLOG-2743: surface the warning text itself. The pre-flight
        // free-space refusal arrives on this channel, and discarding it would
        // report unqualified success while attachments were silently skipped.
        //
        // BACKLOG-2749: minus the cap clause. See `stripStaleCapClause`.
        warning: stripStaleCapClause(messagesItem.warning),
      });
    } else if (messagesItem?.status === 'error') {
      setLastResult({
        success: false,
        messagesImported: 0,
        error: safeErrorMessage(messagesItem.error, 'Import failed'),
      });
    }
  }, [messagesItem?.status, messagesItem?.error, messagesItem?.warning, messagesItem?.importedCount, messagesItem?.cancelled, messagesItem?.rolledBack]);

  // BACKLOG-2748: the "Cancelling..." state is cleared when the run leaves
  // 'running' — otherwise the NEXT import would render its Cancel button
  // already disabled and mid-cancel. BACKLOG-2776 moved that clearing to the
  // orchestrator, which owns the flag and drops it on the same transition that
  // marks the item complete or errored.

  /**
   * BACKLOG-2748: stop the running import.
   *
   * Sends the main-process cancel (which aborts the import between message
   * batches and between attachment copies) and does NOT call
   * `syncOrchestrator.cancel()`, which would empty the queue and abandon the
   * in-flight import, leaving the main process importing while the UI claimed to
   * be idle. Letting the import return normally is what produces the honest
   * result — a partial count for a delta import, "nothing changed" for a rolled
   * back force re-import (BACKLOG-2775).
   *
   * BACKLOG-2776: the IPC goes first and the acknowledgement second, both in
   * this tick. `cancelImport()` is a fire-and-forget `send` that returns
   * immediately — there is no round trip to wait for — so ordering it first
   * costs nothing and means the UI can never show "Cancelling…" for a cancel
   * that was never dispatched.
   */
  const handleCancelImport = useCallback(() => {
    try {
      window.api.messages.cancelImport();
    } catch (err) {
      logger.error("[MacOSMessagesImportSettings] Cancel import failed:", err);
      return;
    }
    markCancelRequested('messages');
  }, [markCancelRequested]);


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

        {/* Active filter / effective-window indicator (BACKLOG-2286)
            ────────────────────────────────────────────────────────────────
            BACKLOG-2749: "up to {cap} messages" is TRUE only while nothing is
            protected. With a deal's audit period in range, Cap' fetches that
            period complete and does not count it against the cap, so the run
            covers MORE than the cap — the founder's 50,000 limit covering
            62,823 messages. Leaving the phrase alone would have left this panel
            saying "up to 50,000" three lines above a dialog saying 62,823,
            which is the exact contradiction (`1e8baa69`) this item is fixing;
            moving the header out of the dialog and leaving its twin on the
            panel would have fixed nothing.

            So the phrase states the cap when the cap is the whole story, and
            states the COVERAGE when it is not. `hasProtectedHistory` compares
            the resolver's cap against the estimate's admitted count — two
            facts, neither derived from the other. */}
        {isAuditDriven ? (
          <div className="mt-2">
            <p className="text-xs text-blue-600">
              Auto-importing messages back to{" "}
              {formatEffectiveCutoff(effectiveWindow!.effectiveCutoffISO!)}
              {maxMessages !== null &&
                (hasProtectedHistory
                  ? `, covering ${availableCount!.toLocaleString()} messages (your ${planCap!.toLocaleString()} newest plus your deals' protected history)`
                  : `, up to ${maxMessages.toLocaleString()} messages`)}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              This covers your transactions&rsquo; audit periods. The setting
              below only applies if you want to reach back even further.
            </p>
          </div>
        ) : (
          (lookbackMonths !== null || maxMessages !== null) && (
            <p className="text-xs text-blue-600 mt-2">
              {hasProtectedHistory
                ? lookbackMonths !== null
                  ? `Importing last ${lookbackMonths} months, covering ${availableCount!.toLocaleString()} messages (your ${planCap!.toLocaleString()} newest plus your deals' protected history)`
                  : `Covering ${availableCount!.toLocaleString()} messages — your ${planCap!.toLocaleString()} newest, plus your deals' protected history`
                : lookbackMonths !== null && maxMessages !== null
                  ? `Importing last ${lookbackMonths} months, up to ${maxMessages.toLocaleString()} messages`
                  : lookbackMonths !== null
                    ? `Importing messages from the last ${lookbackMonths} months`
                    : `Importing up to ${maxMessages!.toLocaleString()} messages`}
            </p>
          )
        )}

        {/* Pre-import cap info */}
        {/* BACKLOG-2772: the WINDOW, not `availableCount`. `availableCount` is
            now what the run will import — the cap already applied — so with a
            50,000 cap and no deals it IS 50,000, and this sentence would have
            read "contains 50,000 messages, which exceeds the 50,000 limit". */}
        {/* BACKLOG-2749: `planCap`, not `maxMessages` — and this line CRASHED
            before it was, which is the same defect in its most literal form.
            `capExceeded` had been repointed at the plan's cap while the
            sentence still read the dropdown; pressing "Import all N messages"
            sets the dropdown to null for the run, so the condition stayed true
            against the plan's 50,000 while the sentence dereferenced a null.
            Two readers of one fact, exactly as before, only this time the
            disagreement was loud instead of quiet. Caught by
            `onePlanDialog-2749`'s import-everything case. */}
        {!isImporting && capExceeded && (
          <p className="text-xs text-amber-600 mt-2">
            This time period contains {windowCount!.toLocaleString()} messages,
            which exceeds the {planCap!.toLocaleString()} limit.
          </p>
        )}

        {/* BACKLOG-2743: Size estimate for the selected window. Real numbers
            only — messages, attachment size, and the user's own free space.
            Deliberately NOT worded as "may slow your computer": this is a disk
            capacity fact, and a vague warning trains people to dismiss it. */}
        {!isImporting && estimateResolved && sizeEstimate !== null && sizeEstimate.attachmentCount > 0 && (
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

        {/* BACKLOG-2760: the size for this window is not known yet. Import is
            refused meanwhile, so say why rather than leaving a dead button. */}
        {!isImporting && !skipAttachments && estimateStatus === "pending" && (
          <p
            data-testid="import-estimate-pending"
            className="text-xs text-gray-500 mt-2 flex items-center gap-2"
          >
            <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
            Checking how much space this import needs&hellip;
          </p>
        )}

        {/* BACKLOG-2760: the size could not be determined. The import is refused
            rather than attempted, because the failure mode this guard exists for
            — filling the disk and evicting the user's Time Machine snapshots —
            is not one worth risking on an unread number. */}
        {!isImporting && !skipAttachments && estimateStatus === "unavailable" && (
          <p
            data-testid="import-estimate-unavailable"
            className="text-xs text-amber-700 mt-2"
          >
            Keepr could not work out how much space this import needs, so it will
            not start. Try again, or import the message text without attachment
            files.
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

      {/* BACKLOG-2743: The attachment copy does not fit.
          ────────────────────────────────────────────────────────────────
          BACKLOG-2749 moved the DECISION out of this inline block and into the
          one dialog, where the founder's computed way-out lives ("Import last
          12 months — 8.2 GB"). What stays here is the FACT, so the user learns
          it before clicking rather than after — and the sentence is the one
          that was here, unchanged.

          There is still no "import anyway" on any surface: macOS would make
          room by deleting the user's local Time Machine snapshots, which is the
          failure this guard exists for. */}
      {!isImporting && spaceRefused && sizeEstimate && (
        <div
          data-testid="import-space-notice"
          className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded"
        >
          <p className="text-xs text-amber-800 font-medium">
            {/* "up to": the figure is an upper bound by construction — identical
                files are copied once, and that is not subtracted here. */}
            This import needs up to {formatGb(sizeEstimate.attachmentBytes)} for attachments
            {sizeEstimate.availableDiskBytes !== null && (
              <> but only {formatGb(sizeEstimate.availableDiskBytes)} is available</>
            )}
            . It will not start.
          </p>
          <p className="text-xs text-amber-700 mt-1">
            Press Import to see the periods that would fit.
          </p>
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
            // BACKLOG-2775: a cancelled FORCE re-import kept nothing and lost
            // nothing — its clear and its re-import shared one transaction that
            // rolled back. Reusing the delta wording here would read as
            // "0 messages were imported", which is the sentence the founder saw
            // after the run that emptied his store, and it would tell him
            // nothing about whether his messages had survived.
            lastResult.rolledBack ? (
              <>
                Re-import cancelled. <strong>Nothing changed</strong> — your
                existing messages are untouched.
              </>
            ) : (
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
            )
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
          {/* BACKLOG-2749: what the store now COVERS, and what the limit left
              out — window minus admitted coverage.

              The founder's live restore reported "659,619 messages excluded by
              import limit". That was 708,400 − 48,781: the window minus what
              that run downloaded, which counted his 14,042 already-present
              messages as excluded. A delta import does not re-fetch what it
              already has, so fetch volume and coverage are different numbers
              and only coverage belongs in a sentence about exclusion. The true
              figure was 645,576, and it is stated from the plan the run was
              consented to rather than reconstructed afterwards. */}
          {lastResult.success && !lastResult.cancelled && lastCoverage && (
            <span
              data-testid="import-coverage"
              className="block mt-1 text-gray-700"
            >
              Your messages for this period now cover{" "}
              <strong>{lastCoverage.admittedCount.toLocaleString()}</strong> of{" "}
              {lastCoverage.windowCount.toLocaleString()} —{" "}
              {lastCoverage.excluded.toLocaleString()} older messages stay
              outside your import limit. Adjust in Settings.
            </span>
          )}
          {/* BACKLOG-2743: non-fatal notice alongside a successful import —
              e.g. the pre-flight refused the attachment copy for disk space.
              BACKLOG-2749: the orchestrator's cap clause has already been
              stripped from this string — see `stripStaleCapClause`. */}
          {lastResult.success && lastResult.warning && (
            <span data-testid="import-warning" className="block mt-1 text-amber-700">
              {lastResult.warning}
            </span>
          )}
        </div>
      )}

      {/*
        BACKLOG-2749 — THE ONE PRE-IMPORT DIALOG.

        What was here: an inline amber card with its own copy of the counts and
        its own three buttons. Above it, a size line. Above that, a header
        reading "Importing up to 50,000 messages". Three surfaces describing one
        decision, and on the founder's machine they disagreed.

        The dialog is GIVEN its numbers; it derives none. `effectiveCap` comes
        off the resolved plan rather than the dropdown, because the plan is what
        the run enforces — and under Cap' the admitted count exceeds the cap
        whenever a deal's audit period is in range, which is precisely the case
        no surface here used to describe correctly.
      */}
      {dialog !== null &&
        !isImporting &&
        windowCount !== null &&
        availableCount !== null && (
          <ImportPlanDialog
            reason={dialog.reason}
            isReimport={dialog.isReimport}
            windowCount={windowCount}
            admittedCount={availableCount}
            effectiveCap={planCap}
            overrides={planFacts?.overrides ?? []}
            attachmentBytes={sizeEstimate?.attachmentBytes ?? null}
            availableDiskBytes={sizeEstimate?.availableDiskBytes ?? null}
            fittingWindow={fittingWindow}
            fittingWindowStatus={fittingWindowStatus}
            onKeepLimit={() => {
              closeDialog();
              handleImport(dialog.isReimport);
            }}
            onImportEverything={() => {
              closeDialog();
              handleImport(dialog.isReimport, true);
            }}
            onChooseWindow={async (months) => {
              closeDialog();
              // Move the dropdown the user can see, save it, THEN run. The
              // founder's standing invariant for this button is that clicking
              // it succeeds to the run stage; the run's own pre-flight
              // re-verifies fit exactly as it does for every other path.
              await handleLookbackChange(String(months));
              // `windowChanged`: this run covers the window just chosen, not
              // the one the panel's estimate still describes.
              handleImport(dialog.isReimport, false, true);
            }}
            onTextOnly={async () => {
              closeDialog();
              await handleSkipAttachmentsChange(true);
              handleImport(dialog.isReimport);
            }}
            onCancel={closeDialog}
          />
        )}

      <div className="flex gap-2">
        <button
          // BACKLOG-2749: ONE gate. It decides which surface the click reaches
          // — the space refusal, the cap choice, or the run itself — so the two
          // entry points cannot drift into different rules.
          onClick={() => beginImport(false)}
          // BACKLOG-2760: refused while the size of this window is UNKNOWN. A
          // disk-capacity guard defaults to no.
          // BACKLOG-2749: a KNOWN doesn't-fit no longer disables the button; it
          // opens the refusal dialog, which offers a window that does fit. The
          // import is still refused — no path from that dialog starts a run
          // that does not fit.
          disabled={controlsDisabled || spaceBlocked}
          title={spaceBlocked ? spaceBlockedReason : undefined}
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
          {/* BACKLOG-2749 / founder `c2300351`: "switch the design of the
              cancel button and the Re-Import&Unlink so the cancel is red and
              the re import and unlink is gray." His INTENT — the safe way out
              prominent, the destructive action hard to hit by accident — is
              implemented; the literal colour swap is not, and deliberately.

              Red on a button is the convention for "this one is destructive".
              Painting Cancel red teaches the eye that the red button is the one
              to avoid, which on this dialog is the opposite of the truth and,
              worse, transfers to every other confirm in the app. So: Cancel
              becomes the PROMINENT default action, and "Re-import & unlink"
              becomes recessive while still reading as destructive (outlined,
              red text). Confirm the final styling with the founder at QA. */}
          <div className="flex items-center gap-3 justify-end">
            <button
              onClick={() => {
                setShowForceWarning(false);
                // BACKLOG-2749: the same one gate the Import button uses, so
                // the space refusal and the cap choice cannot apply to one
                // entry point and not the other.
                beginImport(true);
              }}
              data-testid="force-reimport-confirm"
              className="px-4 py-2 bg-white border border-red-300 text-red-700 hover:bg-red-50 rounded-lg font-medium transition-all"
            >
              Re-import &amp; unlink
            </button>
            <button
              onClick={() => setShowForceWarning(false)}
              data-testid="force-reimport-cancel"
              className="px-4 py-2 bg-blue-500 text-white hover:bg-blue-600 rounded-lg font-semibold transition-all"
            >
              Cancel
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

          {/* BACKLOG-2748: the way out of a running import. Inside the
              `isImporting` block so it cannot outlive the run it cancels, and
              gated on `cancelAvailable` so it is never offered in the window
              where the cancel would reach nothing (see that derivation).

              BACKLOG-2776: it is now DISABLED after the first press, reversing
              2748's deliberate choice to leave it clickable. That choice existed
              to let the user re-send a cancel that had been dropped in the gap
              before the main process was importing — the founder pressed twice
              for exactly that reason. The service now holds a cancel across that
              gap, so a second press can add nothing, and a button that still
              invites one implies the first press might not have counted. */}
          {cancelAvailable && (
            <>
              <button
                type="button"
                onClick={handleCancelImport}
                disabled={cancelRequested}
                data-testid="cancel-import"
                className={`mt-2 px-3 py-1.5 text-xs font-medium rounded border transition-all ${
                  cancelRequested
                    ? "border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed"
                    : "border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                }`}
              >
                {cancelRequested
                  ? "Cancelling — finishing current step…"
                  : "Cancel import"}
              </button>
              {cancelRequested && (
                <p className="text-xs text-gray-500 mt-1">
                  {/* BACKLOG-2775: what survives a cancel depends on which kind
                      of run this is, and the difference is the whole point of
                      that item — a force re-import keeps nothing because it
                      rolls back, a delta import keeps everything it stored. */}
                  {lastForceReimportRef.current
                    ? "Your existing messages are untouched — a cancelled re-import changes nothing."
                    : "Finishing the current batch — messages already imported are kept."}
                </p>
              )}
            </>
          )}
        </div>
      )}
      </div>{/* /BACKLOG-2335 muted controls region */}
    </div>
  );
}

export default MacOSMessagesImportSettings;
