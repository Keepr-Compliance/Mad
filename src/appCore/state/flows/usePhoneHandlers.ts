/**
 * usePhoneHandlers Hook
 *
 * Manages phone type selection and driver setup handlers.
 * Handles iPhone/Android selection and Apple driver setup flows.
 *
 * IMPORTANT: When USE_NEW_ONBOARDING is enabled, these handlers should NOT
 * call setCurrentStep() - navigation is handled by OnboardingFlow's
 * useOnboardingFlow hook which respects the step order defined in macosFlow.ts.
 * The handlers should only update state (phone type, etc.).
 *
 * TASK-1612: Migrated to use authService instead of direct window.api calls.
 */

import { useCallback, useMemo } from "react";
import type { AppStep, PendingOnboardingData } from "../types";
import type { SavePhoneTypeResult } from "./usePhoneTypeApi";
import { USE_NEW_ONBOARDING } from "../../routing/routeConfig";

export interface UsePhoneHandlersOptions {
  // Auth state
  currentUserId: string | undefined;

  // Platform
  isWindows: boolean;

  // Phone type API
  selectedPhoneType: "iphone" | "android" | null;
  setSelectedPhoneType: (phoneType: "iphone" | "android" | null) => void;
  setHasSelectedPhoneType: (value: boolean) => void;
  setNeedsDriverSetup: (value: boolean) => void;
  savePhoneType: (phoneType: "iphone" | "android") => Promise<SavePhoneTypeResult>;

  // Email onboarding
  setHasCompletedEmailOnboarding: (value: boolean) => void;

  // Pending data
  setPendingOnboardingData: React.Dispatch<
    React.SetStateAction<PendingOnboardingData>
  >;

  // Navigation
  setCurrentStep: (step: AppStep) => void;
}

export interface UsePhoneHandlersReturn {
  handleSelectIPhone: () => Promise<void>;
  handleSelectAndroid: () => Promise<void>;
  handleAndroidGoBack: () => void;
  handleAndroidContinueWithEmail: () => Promise<void>;
  handlePhoneTypeChange: (phoneType: "iphone" | "android") => Promise<void>;
  handleAppleDriverSetupComplete: () => Promise<void>;
  handleAppleDriverSetupSkip: () => Promise<void>;
}

export function usePhoneHandlers({
  currentUserId,
  isWindows: _isWindows,
  selectedPhoneType: _selectedPhoneType,
  setSelectedPhoneType,
  setHasSelectedPhoneType,
  setNeedsDriverSetup,
  savePhoneType,
  setHasCompletedEmailOnboarding,
  setPendingOnboardingData,
  setCurrentStep,
}: UsePhoneHandlersOptions): UsePhoneHandlersReturn {
  const handleSelectIPhone = useCallback(async (): Promise<void> => {
    if (!currentUserId) return;

    const result = await savePhoneType("iphone");
    // BACKLOG-4030: a cancelled local save stays on the phone-type step. The
    // notice is already raised; nothing is queued as pending.
    if (result.status === "local-cancelled") return;
    if (result.status === "saved") {
      setHasSelectedPhoneType(true);
      // Windows flow: Phone Type -> Email -> Driver Setup -> Dashboard
      // macOS flow: Phone Type -> Email -> Secure Storage -> Permissions -> Dashboard
      // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
    } else {
      // no-user / error: keep the answer in pending data and let OnboardingFlow
      // handle navigation. (A closed DB is not this branch: savePhoneType
      // returns "saved" and queues the answer in the state machine.)
      setSelectedPhoneType("iphone");
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "iphone" }));
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
    }
  }, [
    currentUserId,
    setSelectedPhoneType,
    setPendingOnboardingData,
    setCurrentStep,
    savePhoneType,
    setHasSelectedPhoneType,
  ]);

  const handleSelectAndroid = useCallback(async (): Promise<void> => {
    if (!currentUserId) return;

    const result = await savePhoneType("android");
    // BACKLOG-4030: a cancelled local save stays on the phone-type step.
    if (result.status === "local-cancelled") return;
    if (result.status === "saved") {
      setHasSelectedPhoneType(true);
    } else {
      // no-user / error — store in pending data, let OnboardingFlow handle navigation
      setSelectedPhoneType("android");
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "android" }));
    }
  }, [
    currentUserId,
    setSelectedPhoneType,
    setPendingOnboardingData,
    setCurrentStep,
    savePhoneType,
    setHasSelectedPhoneType,
  ]);

  const handleAndroidGoBack = useCallback((): void => {
    setSelectedPhoneType(null);
    setPendingOnboardingData((prev) => ({ ...prev, phoneType: null }));
    setCurrentStep("phone-type-selection");
  }, [setSelectedPhoneType, setPendingOnboardingData, setCurrentStep]);

  const handleAndroidContinueWithEmail = useCallback(async (): Promise<void> => {
    if (!currentUserId) return;

    const result = await savePhoneType("android");
    // BACKLOG-4030: a cancelled local save stays on the phone-type step.
    if (result.status === "local-cancelled") return;
    if (result.status === "saved") {
      setHasSelectedPhoneType(true);
      // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
    } else {
      // no-user / error - store in pending data
      setSelectedPhoneType("android");
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "android" }));
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
    }
  }, [
    currentUserId,
    setPendingOnboardingData,
    setCurrentStep,
    savePhoneType,
    setHasSelectedPhoneType,
  ]);

  const handlePhoneTypeChange = useCallback(
    async (phoneType: "iphone" | "android"): Promise<void> => {
      if (!currentUserId) return;
      await savePhoneType(phoneType);
    },
    [
      currentUserId,
      setSelectedPhoneType,
      setPendingOnboardingData,
      savePhoneType,
    ],
  );

  const handleAppleDriverSetupComplete = useCallback(async (): Promise<void> => {
    // Mark all onboarding as complete - driver setup is the final step on Windows
    setNeedsDriverSetup(false);
    setHasSelectedPhoneType(true);
    setHasCompletedEmailOnboarding(true);
    // hasEmailConnected should already be true from email step

    // Navigation to dashboard is handled by the onboarding flow hook's onComplete callback
  }, [
    setNeedsDriverSetup,
    setHasSelectedPhoneType,
    setHasCompletedEmailOnboarding,
  ]);

  const handleAppleDriverSetupSkip = useCallback(async (): Promise<void> => {
    // Mark all onboarding as complete - even if skipped, we're done with onboarding on Windows
    setNeedsDriverSetup(false);
    setHasSelectedPhoneType(true);
    setHasCompletedEmailOnboarding(true);

    // Note: Don't call setCurrentStep here - let the onboarding flow hook handle navigation
  }, [
    setNeedsDriverSetup,
    setHasSelectedPhoneType,
    setHasCompletedEmailOnboarding,
  ]);

  return useMemo(
    () => ({
      handleSelectIPhone,
      handleSelectAndroid,
      handleAndroidGoBack,
      handleAndroidContinueWithEmail,
      handlePhoneTypeChange,
      handleAppleDriverSetupComplete,
      handleAppleDriverSetupSkip,
    }),
    [
      handleSelectIPhone,
      handleSelectAndroid,
      handleAndroidGoBack,
      handleAndroidContinueWithEmail,
      handlePhoneTypeChange,
      handleAppleDriverSetupComplete,
      handleAppleDriverSetupSkip,
    ],
  );
}
