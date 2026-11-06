/**
 * useLogoutHandler Hook
 *
 * Manages logout logic: calls logout, dispatches state machine action,
 * and resets UI state.
 * Extracted from useAuthFlow for single-responsibility decomposition.
 */

import { useCallback } from "react";
import type { AppStep } from "../../types";
import type { AppAction } from "../../machine/types";

export interface UseLogoutHandlerOptions {
  logout: () => Promise<void>;
  stateMachineDispatch?: React.Dispatch<AppAction>;
  onCloseProfile: () => void;
  onSetHasSelectedPhoneType: (value: boolean) => void;
  onSetSelectedPhoneType: (value: "iphone" | "android" | null) => void;
  onSetCurrentStep: (step: AppStep) => void;
  setIsNewUserFlow: (value: boolean) => void;
  /** BACKLOG-4120: close Learn mode over the main screen, so it never reopens for the next user. */
  onCloseLearn?: () => void;
}

export function useLogoutHandler({
  logout,
  stateMachineDispatch,
  onCloseProfile,
  onSetHasSelectedPhoneType,
  onSetSelectedPhoneType,
  onSetCurrentStep,
  setIsNewUserFlow,
  onCloseLearn,
}: UseLogoutHandlerOptions) {
  const handleLogout = useCallback(async (): Promise<void> => {
    await logout();
    // Dispatch LOGOUT to state machine to transition to "unauthenticated"
    // This ensures the UI reflects the logged-out state (redirects to login screen)
    if (stateMachineDispatch) {
      stateMachineDispatch({ type: "LOGOUT" });
    }
    onCloseProfile();
    onCloseLearn?.();
    setIsNewUserFlow(false);
    onSetHasSelectedPhoneType(false);
    onSetSelectedPhoneType(null);
    onSetCurrentStep("login");
  }, [logout, stateMachineDispatch, onCloseProfile, onSetHasSelectedPhoneType, onSetSelectedPhoneType, onSetCurrentStep, setIsNewUserFlow, onCloseLearn]);

  return { handleLogout };
}
