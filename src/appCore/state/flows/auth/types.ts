/**
 * Auth Flow Types
 *
 * Type definitions for the useAuthFlow hook and its sub-hooks.
 * Extracted to keep the composition hook under 100 lines.
 */

import type { PendingOAuthData, DeepLinkAuthData } from "../../../../components/Login";
import type { Subscription } from "../../../../../electron/types/models";
import type { PendingOnboardingData, AppStep } from "../../types";
import type { AppAction } from "../../machine/types";

/** Default pending onboarding state */
export const DEFAULT_PENDING_ONBOARDING: PendingOnboardingData = {
  termsAccepted: false,
  phoneType: null,
  emailConnected: false,
  emailProvider: null,
};

export interface UseAuthFlowOptions {
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
  logout: () => Promise<void>;
  acceptTerms: () => Promise<void>;
  declineTerms: () => Promise<void>;
  /**
   * Clear needsTermsAcceptance flag in AuthContext.
   * Called after terms are accepted to Supabase (pre-DB flow).
   */
  clearTermsRequirement: () => void;
  isAuthenticated: boolean;
  /**
   * Current user ID (from AuthContext).
   * Used for terms acceptance when DB is not initialized.
   */
  currentUserId: string | null;
  onCloseProfile: () => void;
  onSetHasSelectedPhoneType: (value: boolean) => void;
  onSetSelectedPhoneType: (value: "iphone" | "android" | null) => void;
  onSetCurrentStep: (step: AppStep) => void;
  /**
   * Optional dispatch function to dispatch LOGIN_SUCCESS to state machine.
   * When provided, handleLoginSuccess will dispatch LOGIN_SUCCESS after login.
   */
  stateMachineDispatch?: React.Dispatch<AppAction>;
  /**
   * Platform info for LOGIN_SUCCESS action.
   * Required when stateMachineDispatch is provided.
   */
  platform?: { isMacOS: boolean; isWindows: boolean };
}

export interface UseAuthFlowReturn {
  // State
  isNewUserFlow: boolean;
  pendingOAuthData: PendingOAuthData | null;
  pendingOnboardingData: PendingOnboardingData;

  // Setters for orchestrator
  setIsNewUserFlow: (value: boolean) => void;
  setPendingOAuthData: (data: PendingOAuthData | null) => void;
  setPendingOnboardingData: React.Dispatch<
    React.SetStateAction<PendingOnboardingData>
  >;

  // Handlers
  handleLoginSuccess: (
    user: {
      id: string;
      email: string;
      display_name?: string;
      avatar_url?: string;
    },
    token: string,
    provider: string,
    subscriptionData: Subscription | undefined,
    isNewUser: boolean,
  ) => void;
  handleLoginPending: (oauthData: PendingOAuthData) => void;
  /** TASK-1507B: Handle deep link auth success from browser OAuth flow */
  handleDeepLinkAuthSuccess: (data: DeepLinkAuthData) => void;
  handleLogout: () => Promise<void>;
  handleAcceptTerms: () => Promise<void>;
  handleDeclineTerms: () => Promise<void>;
}
