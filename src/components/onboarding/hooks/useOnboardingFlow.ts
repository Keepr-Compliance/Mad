/**
 * useOnboardingFlow Hook
 *
 * Orchestration hook that manages onboarding flow state, step navigation,
 * and action handling. Connects the step registry, flow definitions, and
 * shell components.
 *
 * @module onboarding/hooks/useOnboardingFlow
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { usePlatform } from "../../../contexts/PlatformContext";
import { getFlowSteps } from "../flows";
import { logNavigation, logStepVisibility, logStateChange } from "../../../appCore/state/machine/debug";
import type {
  OnboardingStep,
  OnboardingContext,
  OnboardingStepId,
  StepAction,
  Platform,
} from "../types";
import logger from '../../../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

/**
 * External app state needed to build onboarding context.
 */
export interface OnboardingAppState {
  /** User's selected phone type */
  phoneType: "iphone" | "android" | null;
  /** Whether email is connected (undefined = unknown/loading) */
  emailConnected: boolean | undefined;
  /** Connected email address */
  connectedEmail: string | null;
  /** Email provider */
  emailProvider: "google" | "microsoft" | null;
  /** Whether permissions are granted (undefined = unknown/loading) */
  hasPermissions: boolean | undefined;
  /** Whether secure storage is set up (macOS) */
  hasSecureStorage: boolean;
  /** Whether driver is set up */
  driverSetupComplete: boolean;
  /** Whether terms are accepted */
  termsAccepted: boolean;
  /** Authentication provider */
  authProvider: "google" | "microsoft";
  /** Whether user is new */
  isNewUser: boolean;
  /** Whether database is initialized */
  isDatabaseInitialized: boolean;
  /** Current user ID */
  userId: string | null;
  /** Whether user has been verified in local database */
  isUserVerifiedInLocalDb: boolean;
}

/**
 * Options for the useOnboardingFlow hook.
 */
export interface UseOnboardingFlowOptions {
  /** Initial step index (default: 0) */
  initialStepIndex?: number;
  /** Initial step ID - takes precedence over initialStepIndex */
  initialStepId?: string;
  /** Callback when flow completes */
  onComplete?: () => void;
  /** Callback for action handling - parent processes and updates app state */
  onAction?: (action: StepAction) => void;
  /** External app state for context building */
  appState: OnboardingAppState;
}

/**
 * Return type for the useOnboardingFlow hook.
 */
export interface UseOnboardingFlowReturn {
  /** All steps in the flow (filtered by shouldShow) */
  steps: OnboardingStep[];
  /** All steps in the flow (unfiltered) */
  allSteps: OnboardingStep[];
  /** Current step index */
  currentIndex: number;
  /** Current step */
  currentStep: OnboardingStep;
  /** Current step metadata */
  currentStepMeta: OnboardingStep["meta"];
  /** Onboarding context */
  context: OnboardingContext;
  /** Navigate to next step */
  goToNext: () => void;
  /** Navigate to previous step */
  goToPrevious: () => void;
  /** Navigate to specific step by ID */
  goToStep: (stepId: OnboardingStepId) => void;
  /** Handle step action */
  handleAction: (action: StepAction) => void;
  /** Handle skip for current step */
  handleSkip: () => void;
  /** Whether flow is complete */
  isComplete: boolean;
  /** Whether on first step */
  isFirstStep: boolean;
  /** Whether on last step */
  isLastStep: boolean;
  /** Whether current step can be skipped */
  canSkip: boolean;
  /** Whether next button should be disabled */
  isNextDisabled: boolean;
  /** Current platform */
  platform: Platform;
  /** Total visible steps count */
  totalSteps: number;
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

/**
 * Hook that orchestrates the onboarding flow.
 *
 * @param options - Hook configuration options
 * @returns Flow state and navigation functions
 *
 * @example
 * ```tsx
 * const {
 *   currentStep,
 *   goToNext,
 *   goToPrevious,
 *   handleAction,
 *   context,
 * } = useOnboardingFlow({
 *   appState: { phoneType: null, emailConnected: false, ... },
 *   onComplete: () => navigate('/dashboard'),
 *   onAction: (action) => dispatch(action),
 * });
 * ```
 */
export function useOnboardingFlow(
  options: UseOnboardingFlowOptions
): UseOnboardingFlowReturn {
  const { initialStepId, onComplete, onAction, appState } = options;
  const { platform } = usePlatform();

  // Get all steps for this platform
  const allSteps = useMemo(() => {
    try {
      return getFlowSteps(platform);
    } catch {
      // Return empty array if flow not found (shouldn't happen in production)
      logger.error(`[Onboarding] Failed to get flow for platform: ${platform}`);
      return [];
    }
  }, [platform]);

  // Build context from app state
  const context: OnboardingContext = useMemo(
    () => ({
      platform,
      phoneType: appState.phoneType,
      emailConnected: appState.emailConnected,
      connectedEmail: appState.connectedEmail,
      emailSkipped: false, // Will be tracked via actions
      driverSkipped: false, // Will be tracked via actions
      driverSetupComplete: appState.driverSetupComplete,
      permissionsGranted: appState.hasPermissions,
      termsAccepted: appState.termsAccepted,
      emailProvider: appState.emailProvider,
      authProvider: appState.authProvider,
      isNewUser: appState.isNewUser,
      isDatabaseInitialized: appState.isDatabaseInitialized,
      userId: appState.userId,
      isUserVerifiedInLocalDb: appState.isUserVerifiedInLocalDb,
      // BACKLOG-1842: this legacy hook (superseded by useOnboardingQueue) has
      // no resume-marker wiring; always false here.
      isResumedFromFdaRelaunch: false,
    }),
    [platform, appState]
  );

  // Filter steps based on shouldShow
  const steps = useMemo(() => {
    logStateChange('useOnboardingFlow', 'FILTERING_STEPS', {
      emailConnected: context.emailConnected,
      permissionsGranted: context.permissionsGranted,
      phoneType: context.phoneType,
      platform: context.platform,
      isDatabaseInitialized: context.isDatabaseInitialized,
      isNewUser: context.isNewUser,
    });

    const filtered = allSteps.filter((step) => {
      if (step.meta.shouldShow) {
        const shouldShow = step.meta.shouldShow(context);

        // Detailed visibility logging for each step
        const relevantContext: Record<string, unknown> = {};
        switch (step.meta.id) {
          case 'phone-type':
            relevantContext.phoneType = context.phoneType;
            break;
          case 'secure-storage':
            relevantContext.isDatabaseInitialized = context.isDatabaseInitialized;
            break;
          case 'account-verification':
            relevantContext.isDatabaseInitialized = context.isDatabaseInitialized;
            relevantContext.isUserVerifiedInLocalDb = context.isUserVerifiedInLocalDb;
            break;
          case 'email-connect':
            relevantContext.emailConnected = context.emailConnected;
            relevantContext['emailConnected !== true'] = context.emailConnected !== true;
            break;
          case 'permissions':
            relevantContext.permissionsGranted = context.permissionsGranted;
            relevantContext['permissionsGranted !== true'] = context.permissionsGranted !== true;
            break;
          case 'apple-driver':
            relevantContext.phoneType = context.phoneType;
            relevantContext.driverSetupComplete = context.driverSetupComplete;
            break;
        }

        logStepVisibility(
          step.meta.id,
          shouldShow,
          `shouldShow(context) returned ${shouldShow}`,
          relevantContext
        );
        return shouldShow;
      }
      logStepVisibility(step.meta.id, true, 'no shouldShow predicate', {});
      return true;
    });

    logger.debug(
      `%c[STEPS] Visible: ${filtered.map(s => s.meta.id).join(' → ')}`,
      'background: #2E8B57; color: white; font-weight: bold; padding: 2px 8px;'
    );
    return filtered;
  }, [allSteps, context]);

  // Current step state - track by ID to handle dynamic filtering
  const [currentStepId, setCurrentStepId] = useState<string | null>(() => {
    if (initialStepId) {
      const step = steps.find(s => s.meta.id === initialStepId);
      if (step) return step.meta.id;
    }
    return steps[0]?.meta.id ?? null;
  });

  // Derive index from ID - handles array changes automatically
  const currentIndex = useMemo(() => {
    if (!currentStepId) return 0;
    const idx = steps.findIndex(s => s.meta.id === currentStepId);
    if (idx >= 0) return idx;

    // Current step was filtered out - find next available step
    const allIdx = allSteps.findIndex(s => s.meta.id === currentStepId);
    for (let i = allIdx + 1; i < allSteps.length; i++) {
      const nextIdx = steps.findIndex(s => s.meta.id === allSteps[i].meta.id);
      if (nextIdx >= 0) return nextIdx;
    }
    return Math.max(0, steps.length - 1);
  }, [currentStepId, steps, allSteps]);

  // Effect to update currentStepId when current step is filtered out
  useEffect(() => {
    if (!currentStepId || steps.length === 0) return;

    const exists = steps.some(s => s.meta.id === currentStepId);
    if (!exists) {
      // Step was filtered - find and set next available step
      const allIdx = allSteps.findIndex(s => s.meta.id === currentStepId);
      for (let i = allIdx + 1; i < allSteps.length; i++) {
        const nextStep = steps.find(s => s.meta.id === allSteps[i].meta.id);
        if (nextStep) {
          setCurrentStepId(nextStep.meta.id);
          return;
        }
      }
      // No next step - go to last available
      setCurrentStepId(steps[steps.length - 1]?.meta.id ?? null);
    }
  }, [currentStepId, steps, allSteps]);

  // Current step (with safety check)
  const currentStep = steps[currentIndex] ?? steps[0];
  const currentStepMeta = currentStep?.meta;

  // Check if step can proceed (for disabling next button)
  const canProceed = useMemo(() => {
    if (!currentStep) return false;
    if (currentStep.meta.canProceed) {
      return currentStep.meta.canProceed(context);
    }
    // Default: can always proceed
    return true;
  }, [currentStep, context]);

  // Check if step is complete (for progress tracking)
  const isStepComplete = useMemo(() => {
    if (!currentStep) return false;
    if (currentStep.meta.isStepComplete) {
      return currentStep.meta.isStepComplete(context);
    }
    // Default: not complete until action is taken
    return false;
  }, [currentStep, context]);

  // Navigation: Go to next step
  const goToNext = useCallback(() => {
    const fromStep = steps[currentIndex]?.meta.id || 'unknown';
    if (currentIndex < steps.length - 1) {
      const toStep = steps[currentIndex + 1].meta.id;
      logNavigation(fromStep, toStep, 'goToNext()');
      logStateChange('useOnboardingFlow', 'GO_TO_NEXT', {
        fromStep,
        toStep,
        currentIndex,
        nextIndex: currentIndex + 1,
        visibleSteps: steps.map(s => s.meta.id),
        totalSteps: steps.length,
      });
      setCurrentStepId(toStep);
    } else {
      logNavigation(fromStep, 'COMPLETE', 'goToNext() - last step');
      // Flow complete
      onComplete?.();
    }
  }, [currentIndex, steps, onComplete]);

  // Navigation: Go to previous step
  const goToPrevious = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentStepId(steps[currentIndex - 1].meta.id);
    }
  }, [currentIndex, steps]);

  // Navigation: Go to specific step
  const goToStep = useCallback(
    (stepId: OnboardingStepId) => {
      const step = steps.find((s) => s.meta.id === stepId);
      if (step) {
        setCurrentStepId(step.meta.id);
      } else {
        logger.warn(`[Onboarding] Step "${stepId}" not found in current flow`);
      }
    },
    [steps]
  );

  // Action handler - processes actions and may advance flow
  const handleAction = useCallback(
    (action: StepAction) => {
      // First, pass action to parent for state updates
      onAction?.(action);

      // Then handle navigation based on action type
      switch (action.type) {
        case "SELECT_PHONE":
          // After phone selection, advance to next step
          // Note: If Android is selected, shouldShow on next steps may filter them
          goToNext();
          break;

        case "EMAIL_CONNECTED":
        case "EMAIL_SKIPPED":
          goToNext();
          break;

        case "PERMISSION_GRANTED":
          goToNext();
          break;

        case "SECURE_STORAGE_SETUP":
          // For first-time macOS users, navigation is handled by OnboardingFlow
          // which waits for DB init to complete before calling goToNext()
          // Only advance immediately if DB is already initialized (returning user scenario)
          if (context.isDatabaseInitialized) {
            goToNext();
          }
          // Otherwise, OnboardingFlow's effect will handle navigation
          break;

        case "DRIVER_SETUP_COMPLETE":
        case "DRIVER_SKIPPED":
          goToNext();
          break;

        case "TERMS_ACCEPTED":
          goToNext();
          break;

        case "TERMS_DECLINED":
          // Don't advance - user must accept terms
          break;

        case "NAVIGATE_NEXT":
          goToNext();
          break;

        case "NAVIGATE_BACK":
          goToPrevious();
          break;

        case "ONBOARDING_COMPLETE":
          onComplete?.();
          break;

        case "GO_BACK_SELECT_IPHONE":
          // Navigate back to phone-type step
          goToStep("phone-type");
          break;

        case "CONTINUE_EMAIL_ONLY":
          // Continue with email-only flow (Android users)
          goToNext();
          break;

        case "CONNECT_EMAIL_START":
          // Don't navigate - OAuth flow will handle this
          break;

        case "USER_VERIFIED_IN_LOCAL_DB":
          // User verified - the step's shouldShow will now return false,
          // triggering automatic advancement via step filtering effect
          // No explicit navigation needed here
          break;

        default:
          // Unknown action - log warning
          logger.warn(`[Onboarding] Unknown action type: ${(action as StepAction).type}`);
      }
    },
    [onAction, goToNext, goToPrevious, goToStep, onComplete]
  );

  // Handle skip for current step
  const handleSkip = useCallback(() => {
    const skipConfig = currentStep?.meta.skip;
    if (skipConfig?.enabled) {
      // Dispatch appropriate skip action based on current step
      switch (currentStep.meta.id) {
        case "email-connect":
          handleAction({ type: "EMAIL_SKIPPED" });
          break;
        case "apple-driver":
        case "driver-setup":
          handleAction({ type: "DRIVER_SKIPPED" });
          break;
        default:
          // Generic skip - just advance
          goToNext();
      }
    }
  }, [currentStep, handleAction, goToNext]);

  // Derived state
  const isFirstStep = currentIndex === 0;
  const isLastStep = currentIndex === steps.length - 1;
  const isComplete = currentIndex >= steps.length;
  const canSkip = currentStep?.meta.skip?.enabled ?? false;
  const isNextDisabled = !canProceed || (!isStepComplete && currentStep?.meta.isStepComplete !== undefined);

  return {
    steps,
    allSteps,
    currentIndex,
    currentStep,
    currentStepMeta,
    context,
    goToNext,
    goToPrevious,
    goToStep,
    handleAction,
    handleSkip,
    isComplete,
    isFirstStep,
    isLastStep,
    canSkip,
    isNextDisabled,
    platform,
    totalSteps: steps.length,
  };
}
