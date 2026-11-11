/**
 * useNavigationFlow Hook
 *
 * Manages navigation state and step transitions.
 * Derives the current step from the state machine - no effects needed.
 *
 * @module appCore/state/flows/useNavigationFlow
 *
 * ## State Machine Integration
 *
 * This hook derives navigation state purely from the state machine.
 * Navigation is derived, not pushed - components render based on derived step.
 *
 * Requires the state machine feature flag to be enabled.
 * If disabled, throws an error - legacy code paths have been removed.
 */

import { useState, useCallback } from "react";
import type { AppStep, PendingOnboardingData } from "../types";
import {
  useOptionalMachineState,
  deriveAppStep,
  derivePageTitle,
} from "../machine";

export interface UseNavigationFlowOptions {
  // Auth state
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  needsTermsAcceptance: boolean;

  // Platform
  isMacOS: boolean;
  isWindows: boolean;

  // Pending data
  pendingOnboardingData: PendingOnboardingData;

  // Storage state
  isCheckingSecureStorage: boolean;
  isDatabaseInitialized: boolean;
  isInitializingDatabase: boolean;
  initializeSecureStorage: () => Promise<boolean>;

  // Onboarding state
  hasSelectedPhoneType: boolean;
  isLoadingPhoneType: boolean;
  needsDriverSetup: boolean;
  hasCompletedEmailOnboarding: boolean;
  hasEmailConnected: boolean;
  isCheckingEmailOnboarding: boolean;

  // Permissions
  hasPermissions: boolean;

  // Modal state (for terms modal control)
  showTermsModal: boolean;
  onSetShowTermsModal: (show: boolean) => void;
}

export interface UseNavigationFlowReturn {
  // State
  currentStep: AppStep;
  showSetupPromptDismissed: boolean;
  isTourActive: boolean;

  // Setters
  setCurrentStep: (step: AppStep) => void;
  setIsTourActive: (active: boolean) => void;

  // Navigation methods
  goToStep: (step: AppStep) => void;
  goToEmailOnboarding: () => void;

  // Handlers
  handleDismissSetupPrompt: () => void;

  // Utility
  getPageTitle: () => string;
}

export function useNavigationFlow(
  // Options kept for API compatibility but not used - state machine is source of truth
  _options: UseNavigationFlowOptions
): UseNavigationFlowReturn {
  const machineState = useOptionalMachineState();

  // UI-only local state - not part of the state machine
  const [showSetupPromptDismissed, setShowSetupPromptDismissed] =
    useState<boolean>(false);
  const [isTourActive, setIsTourActive] = useState<boolean>(false);

  if (!machineState) {
    throw new Error(
      "useNavigationFlow requires state machine to be enabled. " +
        "Legacy code paths have been removed."
    );
  }

  const { state, dispatch } = machineState;

  // Derive currentStep from state machine - pure derivation, no effects
  const currentStep = deriveAppStep(state);

  // Setters are no-ops - navigation is derived from state machine
  const setCurrentStep = useCallback((_step: AppStep) => {
    // No-op: navigation is derived from state machine, not imperatively set
  }, []);

  // Navigation methods are also no-ops
  // Navigation happens by dispatching actions that change state
  const goToStep = useCallback((_step: AppStep) => {
    // No-op: state machine drives navigation
  }, []);

  const goToEmailOnboarding = useCallback(() => {
    // Dispatch START_EMAIL_SETUP action to transition from ready to onboarding
    // This allows users to connect their email from the dashboard after skipping initial setup
    dispatch({ type: "START_EMAIL_SETUP" });
  }, [dispatch]);

  // handleDismissSetupPrompt works - it's a UI-only concern
  const handleDismissSetupPrompt = useCallback((): void => {
    setShowSetupPromptDismissed(true);
  }, []);

  // getPageTitle uses the derived step
  const getPageTitle = useCallback((): string => {
    return derivePageTitle(currentStep);
  }, [currentStep]);

  return {
    currentStep,
    showSetupPromptDismissed,
    isTourActive,
    setCurrentStep,
    setIsTourActive,
    goToStep,
    goToEmailOnboarding,
    handleDismissSetupPrompt,
    getPageTitle,
  };
}
