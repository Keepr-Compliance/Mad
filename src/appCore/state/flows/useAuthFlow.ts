/**
 * useAuthFlow Hook - Authentication state and handler composition.
 * TASK-1612: Migrated to authService. TASK-2099: Decomposed into sub-hooks.
 */
import { useState, useMemo } from "react";
import type { PendingOAuthData } from "../../../components/Login";
import type { PendingOnboardingData } from "../types";
import { useLoginHandlers } from "./auth/useLoginHandlers";
import { useLogoutHandler } from "./auth/useLogoutHandler";
import { useTermsHandlers } from "./auth/useTermsHandlers";
import { DEFAULT_PENDING_ONBOARDING } from "./auth/types";
import type { UseAuthFlowOptions, UseAuthFlowReturn } from "./auth/types";

// Re-export interfaces for public API compatibility
export type { UseAuthFlowOptions, UseAuthFlowReturn } from "./auth/types";

export function useAuthFlow({
  login,
  logout,
  declineTerms,
  clearTermsRequirement,
  isAuthenticated,
  currentUserId,
  onCloseProfile,
  onCloseLearn,
  onSetHasSelectedPhoneType,
  onSetSelectedPhoneType,
  onSetCurrentStep,
  stateMachineDispatch,
  platform,
}: UseAuthFlowOptions): UseAuthFlowReturn {
  const [isNewUserFlow, setIsNewUserFlow] = useState<boolean>(false);
  const [pendingOAuthData, setPendingOAuthData] =
    useState<PendingOAuthData | null>(null);
  const [pendingOnboardingData, setPendingOnboardingData] =
    useState<PendingOnboardingData>(DEFAULT_PENDING_ONBOARDING);

  const { handleLoginSuccess, handleLoginPending, handleDeepLinkAuthSuccess } =
    useLoginHandlers({
      login,
      stateMachineDispatch,
      platform,
      onSetCurrentStep,
      setIsNewUserFlow,
      setPendingOAuthData,
    });

  const { handleLogout } = useLogoutHandler({
    logout,
    stateMachineDispatch,
    onCloseProfile,
    onSetHasSelectedPhoneType,
    onSetSelectedPhoneType,
    onSetCurrentStep,
    setIsNewUserFlow,
    onCloseLearn,
  });

  const { handleAcceptTerms, handleDeclineTerms } = useTermsHandlers({
    pendingOAuthData,
    isAuthenticated,
    currentUserId,
    clearTermsRequirement,
    declineTerms,
    onSetCurrentStep,
    setPendingOAuthData,
    setPendingOnboardingData,
  });

  return useMemo(
    () => ({
      isNewUserFlow,
      pendingOAuthData,
      pendingOnboardingData,
      setIsNewUserFlow,
      setPendingOAuthData,
      setPendingOnboardingData,
      handleLoginSuccess,
      handleLoginPending,
      handleDeepLinkAuthSuccess,
      handleLogout,
      handleAcceptTerms,
      handleDeclineTerms,
    }),
    [
      isNewUserFlow,
      pendingOAuthData,
      pendingOnboardingData,
      handleLoginSuccess,
      handleLoginPending,
      handleDeepLinkAuthSuccess,
      handleLogout,
      handleAcceptTerms,
      handleDeclineTerms,
    ],
  );
}
