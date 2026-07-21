/**
 * useOnboardingQueue Hook
 *
 * React hook wrapping the pure queue builder functions.
 * This is the single source of truth for onboarding step progression.
 *
 * @module onboarding/queue/useOnboardingQueue
 */

import { useMemo, useCallback, useState } from "react";
import { usePlatform } from "../../../contexts/PlatformContext";
import type { OnboardingContext, StepAction, Platform } from "../types";
import type { StepQueueEntry } from "./types";
import { buildOnboardingQueue, isQueueComplete, getActiveEntry, getVisibleEntries } from "./buildQueue";
import logger from "../../../utils/logger";

// =============================================================================
// TYPES
// =============================================================================

/**
 * External app state needed to build onboarding context.
 * Same shape as the old OnboardingAppState from useOnboardingFlow.
 */
export interface OnboardingAppState {
  phoneType: "iphone" | "android" | null;
  emailConnected: boolean | undefined;
  connectedEmail: string | null;
  emailProvider: "google" | "microsoft" | null;
  hasPermissions: boolean | undefined;
  hasSecureStorage: boolean;
  driverSetupComplete: boolean;
  termsAccepted: boolean;
  authProvider: "google" | "microsoft";
  isNewUser: boolean;
  isDatabaseInitialized: boolean;
  userId: string | null;
  isUserVerifiedInLocalDb: boolean;
  /** Whether user explicitly skipped email connection */
  emailSkipped: boolean;
  /** Whether user explicitly skipped driver setup */
  driverSkipped: boolean;
  /**
   * BACKLOG-1842 (resume-at-step fix round): true when this onboarding
   * session was resumed from the cloud marker written just before an
   * FDA-grant relaunch. See OnboardingContext.isResumedFromFdaRelaunch.
   */
  isResumedFromFdaRelaunch: boolean;
}

export interface UseOnboardingQueueOptions {
  appState: OnboardingAppState;
  onAction?: (action: StepAction) => void;
  onComplete?: () => void;
  /**
   * BACKLOG-1842 (resume-at-step fix round): step IDs to treat as already
   * complete on first build, e.g. steps whose completion isn't derivable
   * from context (contact-source, data-sync) and whose prior completion is
   * known from a consumed onboarding resume marker. Applied once via lazy
   * useState initializer — later renders manage completion the normal way.
   */
  initialManuallyCompletedIds?: readonly string[];
}

export interface UseOnboardingQueueReturn {
  /** Full queue with all entries (including skipped) */
  queue: StepQueueEntry[];
  /** Only applicable/visible entries */
  visibleEntries: StepQueueEntry[];
  /** Currently active entry, or undefined if queue complete */
  activeEntry: StepQueueEntry | undefined;
  /** Active step's Content component and meta */
  activeStep: StepQueueEntry["step"] | undefined;
  /** Current index within visible entries */
  currentIndex: number;
  /** Whether the entire queue is complete */
  isComplete: boolean;
  /** Onboarding context */
  context: OnboardingContext;
  /** Platform */
  platform: Platform;
  /** Navigate to next visible step */
  goToNext: () => void;
  /** Navigate to previous visible step */
  goToPrevious: () => void;
  /** Handle a step action (dispatches to parent + handles navigation) */
  handleAction: (action: StepAction) => void;
  /** Handle skip for current step */
  handleSkip: () => void;
  /** Whether current step can be skipped */
  canSkip: boolean;
  /** Whether next button should be disabled */
  isNextDisabled: boolean;
  /** Whether on the first visible step */
  isFirstStep: boolean;
  /** Whether on the last visible step */
  isLastStep: boolean;
  /** Total visible steps */
  totalSteps: number;
  /** Whether viewing a past step via back navigation */
  isViewingPastStep: boolean;
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useOnboardingQueue(
  options: UseOnboardingQueueOptions
): UseOnboardingQueueReturn {
  const { appState, onAction, onComplete, initialManuallyCompletedIds } = options;
  const { platform } = usePlatform();

  // Back navigation override: when set, forces this index as the active step
  // instead of the queue's computed active step. Reset on any forward action.
  const [backOverrideIndex, setBackOverrideIndex] = useState<number | null>(null);

  // Steps manually advanced past via goToNext (for steps whose isComplete
  // can't be derived from context, like contact-source and data-sync).
  // BACKLOG-1842: seeded from initialManuallyCompletedIds (resume marker) on
  // first build only — lazy initializer, not re-applied on re-render.
  const [manuallyCompletedIds, setManuallyCompletedIds] = useState<Set<string>>(
    () => new Set(initialManuallyCompletedIds ?? [])
  );

  // Build context from app state
  const context: OnboardingContext = useMemo(
    () => ({
      platform,
      phoneType: appState.phoneType,
      emailConnected: appState.emailConnected,
      connectedEmail: appState.connectedEmail,
      emailSkipped: appState.emailSkipped,
      driverSkipped: appState.driverSkipped,
      driverSetupComplete: appState.driverSetupComplete,
      permissionsGranted: appState.hasPermissions,
      termsAccepted: appState.termsAccepted,
      emailProvider: appState.emailProvider,
      authProvider: appState.authProvider,
      isNewUser: appState.isNewUser,
      isDatabaseInitialized: appState.isDatabaseInitialized,
      userId: appState.userId,
      isUserVerifiedInLocalDb: appState.isUserVerifiedInLocalDb,
      isResumedFromFdaRelaunch: appState.isResumedFromFdaRelaunch,
    }),
    [platform, appState]
  );

  // Build the queue - rebuilds when context or manual completions change.
  // Manual completions are applied post-build: steps in manuallyCompletedIds
  // are marked complete, then active/pending statuses are re-derived.
  const queue = useMemo(() => {
    const rawQueue = buildOnboardingQueue(platform, context);
    if (manuallyCompletedIds.size === 0) return rawQueue;

    let foundActive = false;
    return rawQueue.map((entry) => {
      if (!entry.applicable) return entry; // skipped stays skipped

      const isManuallyComplete = manuallyCompletedIds.has(entry.step.meta.id);
      if (isManuallyComplete || entry.status === "complete") {
        return { ...entry, status: "complete" as const };
      }
      if (!foundActive) {
        foundActive = true;
        return { ...entry, status: "active" as const };
      }
      return { ...entry, status: "pending" as const };
    });
  }, [platform, context, manuallyCompletedIds]);

  // Derived values
  const visibleEntries = useMemo(() => getVisibleEntries(queue), [queue]);
  const queueActiveEntry = useMemo(() => getActiveEntry(queue), [queue]);
  const queueComplete = useMemo(() => isQueueComplete(queue), [queue]);

  // BACKLOG-1455: Debug logging for onboarding queue state (visible in browser DevTools)
  // eslint-disable-next-line no-console
  console.log(
    '[QUEUE-DEBUG] Active step:', queueActiveEntry?.step.meta.id ?? '(none)',
    'Queue:', visibleEntries.map(e => `${e.step.meta.id}(${e.status})`).join(' -> ')
  );

  // Resolve the effective active entry: back override takes precedence
  const activeEntry = useMemo(() => {
    if (backOverrideIndex !== null && backOverrideIndex >= 0 && backOverrideIndex < visibleEntries.length) {
      return visibleEntries[backOverrideIndex];
    }
    return queueActiveEntry;
  }, [backOverrideIndex, visibleEntries, queueActiveEntry]);

  const currentIndex = useMemo(() => {
    if (!activeEntry) return visibleEntries.length - 1; // Queue complete, point to last
    return visibleEntries.findIndex(
      (e: StepQueueEntry) => e.step.meta.id === activeEntry.step.meta.id
    );
  }, [visibleEntries, activeEntry]);

  const isFirstStep = currentIndex === 0;
  const isLastStep = currentIndex === visibleEntries.length - 1;
  const isViewingPastStep = backOverrideIndex !== null;

  // Check if current step can proceed
  const canProceed = useMemo(() => {
    if (!activeEntry) return false;
    if (activeEntry.step.meta.canProceed) {
      return activeEntry.step.meta.canProceed(context);
    }
    return true;
  }, [activeEntry, context]);

  const canSkip = activeEntry?.step.meta.skip?.enabled ?? false;

  // isNextDisabled: only use canProceed. The isStepComplete predicate is for
  // the queue builder (auto-marking steps done), not for button state.
  // Steps that need to block the Continue button define canProceed for that.
  const isNextDisabled = !canProceed;

  // Navigation
  const goToNext = useCallback(() => {
    // Clear any back override — we're moving forward
    setBackOverrideIndex(null);

    // If we're at the last visible step, signal completion.
    if (currentIndex >= visibleEntries.length - 1) {
      onComplete?.();
      return;
    }

    // For steps whose isComplete is context-driven (e.g. phone-type, email-connect),
    // the queue auto-advances when context changes. But for steps with
    // isComplete: () => false (e.g. contact-source, data-sync), we need to
    // manually mark them complete so the queue advances.
    if (activeEntry && activeEntry.status !== "complete") {
      setManuallyCompletedIds((prev) => {
        const next = new Set(prev);
        next.add(activeEntry.step.meta.id);
        return next;
      });
    }
  }, [currentIndex, visibleEntries.length, onComplete, activeEntry]);

  const goToPrevious = useCallback(() => {
    // Navigate back by overriding the active index to the previous visible step.
    // The queue itself is still a pure function of context — we just display
    // an earlier step until the user moves forward again.
    if (currentIndex > 0) {
      setBackOverrideIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  // Action handler
  const handleAction = useCallback(
    (action: StepAction) => {
      // Only clear back override on explicit forward navigation actions.
      // Context-update actions (like USER_VERIFIED_IN_LOCAL_DB from auto-running
      // steps) should NOT snap the user forward when they're reviewing a past step.
      const forwardActions = [
        "SELECT_PHONE",
        "NAVIGATE_NEXT",
        "EMAIL_CONNECTED",
        "EMAIL_SKIPPED",
        "PERMISSION_GRANTED",
        "SECURE_STORAGE_SETUP",
        "DRIVER_SETUP_COMPLETE",
        "DRIVER_SKIPPED",
        "TERMS_ACCEPTED",
        "CONTINUE_EMAIL_ONLY",
        "CONNECT_EMAIL_START",
        "ONBOARDING_COMPLETE",
      ];
      if (forwardActions.includes(action.type)) {
        setBackOverrideIndex(null);
      }

      // Dispatch to parent first (updates app state → context → queue rebuilds)
      onAction?.(action);

      // Handle navigation-specific actions
      switch (action.type) {
        case "SELECT_PHONE":
          // BACKLOG-1455: Don't call goToNext() here — phone-type's isComplete
          // predicate (phoneType !== null) auto-advances the queue when context
          // updates. Calling goToNext() causes a race: the queue advances before
          // phoneType is set, skipping android-coming-soon and flash-mounting
          // account-verification.
          break;

        case "EMAIL_CONNECTED":
        case "EMAIL_SKIPPED":
        case "PERMISSION_GRANTED":
        case "DRIVER_SETUP_COMPLETE":
        case "DRIVER_SKIPPED":
        case "TERMS_ACCEPTED":
        case "CONTINUE_EMAIL_ONLY":
          // Explicitly advance past steps that may not have context-driven isComplete.
          goToNext();
          break;

        case "NAVIGATE_NEXT":
          goToNext();
          break;

        case "SECURE_STORAGE_SETUP":
          // DB init is async - context will update when DB is ready,
          // triggering queue rebuild automatically
          break;

        case "NAVIGATE_BACK":
          goToPrevious();
          break;

        case "ONBOARDING_COMPLETE":
          onComplete?.();
          break;

        case "GO_BACK_SELECT_IPHONE":
          // Navigate back to phone-type step.
          // The parent onAction dispatches PHONE_TYPE_RESET which sets phoneType = null,
          // causing the queue to rebuild with phone-type as incomplete.
          // We must also clear manuallyCompletedIds — phone-type was marked manually
          // complete when the user originally selected a phone type (goToNext added it).
          // Without clearing, the manual override keeps phone-type "complete" even
          // though the context says it's incomplete, causing the queue to skip forward.
          setManuallyCompletedIds(new Set());
          setBackOverrideIndex(0); // phone-type is always index 0 in visible entries
          break;

        case "USER_VERIFIED_IN_LOCAL_DB":
          // Context update triggers queue rebuild
          break;

        case "CONNECT_EMAIL_START":
        case "TERMS_DECLINED":
          // No navigation needed
          break;

        default:
          logger.warn(`[Queue] Unknown action type: ${(action as StepAction).type}`);
      }
    },
    [onAction, goToNext, goToPrevious, onComplete]
  );

  // Handle skip
  const handleSkip = useCallback(() => {
    const skipConfig = activeEntry?.step.meta.skip;
    if (skipConfig?.enabled) {
      switch (activeEntry?.step.meta.id) {
        case "email-connect":
          handleAction({ type: "EMAIL_SKIPPED" });
          break;
        case "apple-driver":
        case "driver-setup":
          handleAction({ type: "DRIVER_SKIPPED" });
          break;
        case "contact-source":
          handleAction({ type: "NAVIGATE_NEXT" });
          break;
        default:
          goToNext();
      }
    }
  }, [activeEntry, handleAction, goToNext]);

  return {
    queue,
    visibleEntries,
    activeEntry,
    activeStep: activeEntry?.step,
    currentIndex,
    isComplete: queueComplete,
    context,
    platform,
    goToNext,
    goToPrevious,
    handleAction,
    handleSkip,
    canSkip,
    isNextDisabled,
    isFirstStep,
    isLastStep,
    totalSteps: visibleEntries.length,
    isViewingPastStep,
  };
}
