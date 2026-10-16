/**
 * useLoginHandlers Hook
 *
 * Manages login-related handlers: login success, pending OAuth, and deep link auth.
 * Extracted from useAuthFlow for single-responsibility decomposition.
 */

import { useCallback } from "react";
import type { PendingOAuthData, DeepLinkAuthData } from "../../../../components/Login";
import type { Subscription } from "../../../../../electron/types/models";
import type { AppStep } from "../../types";
import type { User, PlatformInfo, AppAction } from "../../machine/types";
import logger from '../../../../utils/logger';
import { normalizeAuthProvider } from '../../../../utils/authProvider';

export interface UseLoginHandlersOptions {
  login: (
    user: {
      id: string;
      email: string;
      display_name?: string;
      avatar_url?: string;
    },
    token: string,
    provider: string,
    subscription: Subscription | undefined,
    isNewUser: boolean,
  ) => void;
  stateMachineDispatch?: React.Dispatch<AppAction>;
  platform?: { isMacOS: boolean; isWindows: boolean };
  onSetCurrentStep: (step: AppStep) => void;
  setIsNewUserFlow: (value: boolean) => void;
  setPendingOAuthData: (data: PendingOAuthData | null) => void;
}

/** Dispatch LOGIN_SUCCESS to state machine if dispatch and platform are available. */
function dispatchLoginSuccess(
  dispatch: React.Dispatch<AppAction> | undefined,
  platformOpts: { isMacOS: boolean; isWindows: boolean } | undefined,
  user: { id: string; email: string; displayName?: string; avatarUrl?: string },
  isNewUser: boolean,
): void {
  if (!dispatch || !platformOpts) return;
  const stateMachineUser: User = { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl };
  const platformInfo: PlatformInfo = { isMacOS: platformOpts.isMacOS, isWindows: platformOpts.isWindows, hasIPhone: false };
  dispatch({ type: "LOGIN_SUCCESS", user: stateMachineUser, platform: platformInfo, isNewUser });
}

export function useLoginHandlers({
  login, stateMachineDispatch, platform, onSetCurrentStep, setIsNewUserFlow, setPendingOAuthData,
}: UseLoginHandlersOptions) {
  const handleLoginSuccess = useCallback(
    (
      user: { id: string; email: string; display_name?: string; avatar_url?: string },
      token: string, provider: string, subscriptionData: Subscription | undefined, isNewUser: boolean,
    ): void => {
      setIsNewUserFlow(isNewUser);
      setPendingOAuthData(null);
      login(user, token, provider, subscriptionData, isNewUser);
      dispatchLoginSuccess(stateMachineDispatch, platform,
        { id: user.id, email: user.email, displayName: user.display_name, avatarUrl: user.avatar_url }, isNewUser);
    },
    [login, stateMachineDispatch, platform, setIsNewUserFlow, setPendingOAuthData],
  );

  const handleLoginPending = useCallback(
    (oauthData: PendingOAuthData): void => { setPendingOAuthData(oauthData); },
    [setPendingOAuthData],
  );

  /**
   * TASK-1507B: Handle successful deep link authentication.
   * Called when browser OAuth completes and returns via deep link with license validation.
   * NOTE: Token storage is already handled by the backend (setSession) - we just update UI state.
   */
  const handleDeepLinkAuthSuccess = useCallback(
    (data: DeepLinkAuthData): void => {
      logger.debug("[useAuthFlow] Deep link auth success", { userId: data.userId || data.user?.id });
      setPendingOAuthData(null);

      // BACKLOG-546: Use isNewUser from backend (based on terms acceptance)
      const isNewUser = data.isNewUser ?? (!data.licenseStatus || data.licenseStatus.transactionCount === 0);
      setIsNewUserFlow(isNewUser);

      // TASK-1507C: Call login() to set currentUser in AuthContext
      if (data.user) {
        login(
          { id: data.user.id, email: data.user.email || "", display_name: data.user.name },
          // BACKLOG-3956: "azure" -> "microsoft"; every other value kept as-is.
          // The "google" stand-in covers only an absent value, which the main
          // process never sends (it defaults before sending).
          data.accessToken, normalizeAuthProvider(data.provider) ?? "google", undefined, isNewUser,
        );
        dispatchLoginSuccess(stateMachineDispatch, platform,
          { id: data.user.id, email: data.user.email || "", displayName: data.user.name }, isNewUser);
      }

      // New users go to onboarding (phone type selection), returning users go to dashboard
      onSetCurrentStep(isNewUser ? "phone-type-selection" : "dashboard");
    },
    [login, stateMachineDispatch, platform, onSetCurrentStep, setIsNewUserFlow, setPendingOAuthData],
  );

  return { handleLoginSuccess, handleLoginPending, handleDeepLinkAuthSuccess };
}
