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
import { authService } from "@/services";
import type { AppStep, PendingOnboardingData } from "../types";
import type { PendingOAuthData } from "../../../components/Login";
import { USE_NEW_ONBOARDING } from "../../routing/routeConfig";
import logger from '../../../utils/logger';

export interface UsePhoneHandlersOptions {
  // Auth state
  pendingOAuthData: PendingOAuthData | null;
  isAuthenticated: boolean;
  currentUserId: string | undefined;

  // Platform
  isWindows: boolean;

  // Phone type API
  selectedPhoneType: "iphone" | "android" | null;
  setSelectedPhoneType: (phoneType: "iphone" | "android" | null) => void;
  setHasSelectedPhoneType: (value: boolean) => void;
  setNeedsDriverSetup: (value: boolean) => void;
  savePhoneType: (phoneType: "iphone" | "android") => Promise<boolean>;

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
  pendingOAuthData,
  isAuthenticated,
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
    if (pendingOAuthData && !isAuthenticated) {
      setSelectedPhoneType("iphone");
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "iphone" }));
      // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
      // This ensures the step order from macosFlow.ts is respected (phone-type -> email-connect -> secure-storage -> permissions)
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
      return;
    }

    if (!currentUserId) return;

    const success = await savePhoneType("iphone");
    if (success) {
      setHasSelectedPhoneType(true);
      // Windows flow: Phone Type -> Email -> Driver Setup -> Dashboard
      // macOS flow: Phone Type -> Email -> Secure Storage -> Permissions -> Dashboard
      // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
    } else {
      // DB not initialized (first-time macOS user after auth) - store in pending data
      // and let OnboardingFlow handle navigation. DB will be initialized at secure-storage step.
      setSelectedPhoneType("iphone");
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "iphone" }));
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
    }
  }, [
    pendingOAuthData,
    isAuthenticated,
    currentUserId,
    setSelectedPhoneType,
    setPendingOnboardingData,
    setCurrentStep,
    savePhoneType,
    setHasSelectedPhoneType,
  ]);

  const handleSelectAndroid = useCallback(async (): Promise<void> => {
    if (pendingOAuthData && !isAuthenticated) {
      setSelectedPhoneType("android");
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "android" }));
      return;
    }

    if (!currentUserId) return;

    const success = await savePhoneType("android");
    if (success) {
      setHasSelectedPhoneType(true);
    } else {
      // DB not initialized — store in pending data, let OnboardingFlow handle navigation
      setSelectedPhoneType("android");
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "android" }));
    }
  }, [
    pendingOAuthData,
    isAuthenticated,
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
    if (pendingOAuthData && !isAuthenticated) {
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "android" }));
      // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
      return;
    }

    if (!currentUserId) return;

    const success = await savePhoneType("android");
    if (success) {
      setHasSelectedPhoneType(true);
      // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
    } else {
      // DB not initialized (first-time macOS user after auth) - store in pending data
      setSelectedPhoneType("android");
      setPendingOnboardingData((prev) => ({ ...prev, phoneType: "android" }));
      if (!USE_NEW_ONBOARDING) {
        setCurrentStep("email-onboarding");
      }
    }
  }, [
    pendingOAuthData,
    isAuthenticated,
    currentUserId,
    setPendingOnboardingData,
    setCurrentStep,
    savePhoneType,
    setHasSelectedPhoneType,
  ]);

  const handlePhoneTypeChange = useCallback(
    async (phoneType: "iphone" | "android"): Promise<void> => {
      if (pendingOAuthData && !isAuthenticated) {
        setSelectedPhoneType(phoneType);
        setPendingOnboardingData((prev) => ({ ...prev, phoneType }));
        return;
      }

      if (!currentUserId) return;
      await savePhoneType(phoneType);
    },
    [
      pendingOAuthData,
      isAuthenticated,
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

    // On Windows, driver setup is the last step - now navigate to dashboard
    if (pendingOAuthData && !isAuthenticated) {
      // Pre-DB flow: need to initialize database before going to dashboard
      const result = await authService.completePendingLogin(pendingOAuthData);
      if (!result.success) {
        logger.error(
          "[usePhoneHandlers] Failed to complete pending login:",
          result.error,
        );
      }
    }
    // Navigation to dashboard is handled by the onboarding flow hook's onComplete callback
  }, [
    pendingOAuthData,
    isAuthenticated,
    setNeedsDriverSetup,
    setHasSelectedPhoneType,
    setHasCompletedEmailOnboarding,
  ]);

  const handleAppleDriverSetupSkip = useCallback(async (): Promise<void> => {
    // Mark all onboarding as complete - even if skipped, we're done with onboarding on Windows
    setNeedsDriverSetup(false);
    setHasSelectedPhoneType(true);
    setHasCompletedEmailOnboarding(true);

    // Same logic as complete - driver setup is the last onboarding step on Windows
    if (pendingOAuthData && !isAuthenticated) {
      const result = await authService.completePendingLogin(pendingOAuthData);
      if (!result.success) {
        logger.error(
          "[usePhoneHandlers] Failed to complete pending login:",
          result.error,
        );
      }
    }
    // Note: Don't call setCurrentStep here - let the onboarding flow hook handle navigation
  }, [
    pendingOAuthData,
    isAuthenticated,
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
