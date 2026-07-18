/**
 * useEmailHandlers Hook
 *
 * Manages email onboarding handlers for connecting email accounts.
 * Handles Google and Microsoft OAuth flows for email connection.
 *
 * TASK-1603: Simplified after flow reorder (TASK-1601/1602).
 * DB is now always initialized before the email step, so:
 * - No more "pending" vs "regular" API paths
 * - Email tokens are saved directly to the database
 * - Removed setPendingEmailTokens and pending API calls
 *
 * TASK-1612: Migrated to use authService instead of direct window.api calls.
 *
 * TASK-1730: Added event emission for cross-component state propagation.
 */

import { useCallback, useMemo } from "react";
import { authService } from "@/services";
import { emitEmailConnectionChanged } from "@/utils/emailConnectionEvents";
import { emitEmailAdminConsentBlocked } from "@/utils/emailAdminConsentEvents";
import type { AppStep, PendingOnboardingData } from "../types";
import type { PendingOAuthData } from "../../../components/Login";
import { USE_NEW_ONBOARDING } from "../../routing/routeConfig";
import logger from '../../../utils/logger';

export interface UseEmailHandlersOptions {
  // Auth state - currentUserId is REQUIRED after flow reorder (DB always initialized)
  currentUserId: string | undefined;
  currentUserEmail: string | undefined;

  // Platform
  isMacOS: boolean;
  isWindows: boolean;

  // Onboarding state
  selectedPhoneType: "iphone" | "android" | null;
  needsDriverSetup: boolean;
  hasPermissions: boolean;

  // Setters
  setPendingOnboardingData: React.Dispatch<
    React.SetStateAction<PendingOnboardingData>
  >;
  setHasEmailConnected: (
    connected: boolean,
    email?: string,
    provider?: "google" | "microsoft"
  ) => void;
  setCurrentStep: (step: AppStep) => void;

  // Email onboarding API
  completeEmailOnboarding: () => Promise<void>;
}

export interface UseEmailHandlersReturn {
  handleEmailOnboardingComplete: () => Promise<void>;
  handleEmailOnboardingSkip: () => Promise<void>;
  handleEmailOnboardingBack: () => void;
  handleStartGoogleEmailConnect: () => Promise<void>;
  handleStartMicrosoftEmailConnect: () => Promise<void>;
}

export function useEmailHandlers({
  currentUserId,
  currentUserEmail,
  isMacOS,
  isWindows,
  selectedPhoneType,
  needsDriverSetup,
  hasPermissions,
  setPendingOnboardingData,
  setHasEmailConnected,
  setCurrentStep,
  completeEmailOnboarding,
}: UseEmailHandlersOptions): UseEmailHandlersReturn {
  /**
   * Complete email onboarding step.
   * TASK-1603: Simplified - DB is always initialized at this point.
   */
  const handleEmailOnboardingComplete = useCallback(
    async (): Promise<void> => {
      await completeEmailOnboarding();

      // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
      if (!USE_NEW_ONBOARDING) {
        // Windows iPhone users need driver setup after email onboarding
        if (isWindows && selectedPhoneType === "iphone" && needsDriverSetup) {
          setCurrentStep("apple-driver-setup");
          return;
        }

        if (hasPermissions) {
          setCurrentStep("dashboard");
        } else {
          setCurrentStep("permissions");
        }
      }
    },
    [
      isWindows,
      selectedPhoneType,
      needsDriverSetup,
      hasPermissions,
      setCurrentStep,
      completeEmailOnboarding,
    ],
  );

  /**
   * Skip email onboarding step.
   * TASK-1603: Simplified - DB is always initialized at this point.
   */
  const handleEmailOnboardingSkip = useCallback(async (): Promise<void> => {
    // Mark as skipped in pending data
    setPendingOnboardingData((prev) => ({
      ...prev,
      emailConnected: false,
    }));

    await completeEmailOnboarding();

    // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
    if (!USE_NEW_ONBOARDING) {
      // Windows iPhone users need driver setup after email onboarding
      if (isWindows && selectedPhoneType === "iphone" && needsDriverSetup) {
        setCurrentStep("apple-driver-setup");
        return;
      }

      if (hasPermissions) {
        setCurrentStep("dashboard");
      } else {
        setCurrentStep("permissions");
      }
    }
  }, [
    isWindows,
    selectedPhoneType,
    needsDriverSetup,
    hasPermissions,
    setPendingOnboardingData,
    setCurrentStep,
    completeEmailOnboarding,
  ]);

  const handleEmailOnboardingBack = useCallback((): void => {
    // When new onboarding is enabled, don't call setCurrentStep - let OnboardingFlow handle navigation
    if (!USE_NEW_ONBOARDING) {
      setCurrentStep("phone-type-selection");
    }
  }, [setCurrentStep]);

  /**
   * Start Google OAuth flow for email connection.
   * TASK-1603: Simplified - DB is always initialized at this point.
   * TASK-1612: Uses authService instead of direct window.api calls.
   * Uses direct database API (no pending fallback needed).
   */
  const handleStartGoogleEmailConnect = useCallback(async (): Promise<void> => {
    if (!currentUserId) {
      logger.error("[useEmailHandlers] No user ID available for Google OAuth");
      return;
    }

    try {
      const result = await authService.googleConnectMailbox(currentUserId);

      if (!result.success) {
        logger.error(
          "[useEmailHandlers] Failed to start Google OAuth:",
          result.error,
        );
        return;
      }

      // Set up IPC listener for OAuth completion via service
      const cleanup = authService.onMailboxConnected(
        "google",
        (connectionResult) => {
          if (connectionResult.success && connectionResult.email) {
            setHasEmailConnected(true, connectionResult.email, "google");
            // Also set email provider so EmailConnectStep shows as connected
            setPendingOnboardingData((prev) => ({
              ...prev,
              emailProvider: "google",
            }));
            // TASK-1730: Emit event for cross-component state propagation
            emitEmailConnectionChanged({
              connected: true,
              email: connectionResult.email,
              provider: "google",
            });
          }
          cleanup();
        },
      );
    } catch (error) {
      logger.error("[useEmailHandlers] Error starting Google OAuth:", error);
    }
  }, [
    currentUserId,
    setHasEmailConnected,
    setPendingOnboardingData,
  ]);

  /**
   * Start Microsoft OAuth flow for email connection.
   * TASK-1603: Simplified - DB is always initialized at this point.
   * TASK-1612: Uses authService instead of direct window.api calls.
   * Uses direct database API (no pending fallback needed).
   */
  const handleStartMicrosoftEmailConnect =
    useCallback(async (): Promise<void> => {
      if (!currentUserId) {
        logger.error("[useEmailHandlers] No user ID available for Microsoft OAuth");
        return;
      }

      try {
        const result = await authService.microsoftConnectMailbox(currentUserId);

        if (!result.success) {
          logger.error(
            "[useEmailHandlers] Failed to start Microsoft OAuth:",
            result.error,
          );
          return;
        }

        // Set up IPC listener for OAuth completion via service
        const cleanup = authService.onMailboxConnected(
          "microsoft",
          (connectionResult) => {
            if (connectionResult.success && connectionResult.email) {
              setHasEmailConnected(true, connectionResult.email, "microsoft");
              // Also set email provider so EmailConnectStep shows as connected
              setPendingOnboardingData((prev) => ({
                ...prev,
                emailProvider: "microsoft",
              }));
              // TASK-1730: Emit event for cross-component state propagation
              emitEmailConnectionChanged({
                connected: true,
                email: connectionResult.email,
                provider: "microsoft",
              });
            } else if (connectionResult.adminConsentRequired) {
              // BACKLOG-2007: the org tenant admin has not consented to Keepr.
              // Surface a targeted "Request IT approval" flow instead of a
              // silent failure. Non-blocking — the user can still skip.
              logger.warn(
                "[useEmailHandlers] Microsoft mailbox connect blocked by org admin consent",
                connectionResult.error,
              );
              emitEmailAdminConsentBlocked({
                provider: "microsoft",
                error: connectionResult.error,
              });
            }
            cleanup();
          },
        );
      } catch (error) {
        logger.error(
          "[useEmailHandlers] Error starting Microsoft OAuth:",
          error,
        );
      }
    }, [
      currentUserId,
      setHasEmailConnected,
      setPendingOnboardingData,
    ]);

  return useMemo(
    () => ({
      handleEmailOnboardingComplete,
      handleEmailOnboardingSkip,
      handleEmailOnboardingBack,
      handleStartGoogleEmailConnect,
      handleStartMicrosoftEmailConnect,
    }),
    [
      handleEmailOnboardingComplete,
      handleEmailOnboardingSkip,
      handleEmailOnboardingBack,
      handleStartGoogleEmailConnect,
      handleStartMicrosoftEmailConnect,
    ],
  );
}
