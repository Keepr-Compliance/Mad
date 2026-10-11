/**
 * useEmailOnboardingApi Hook
 *
 * Handles email onboarding status checks and completion.
 * Checks:
 * - Whether user has completed email onboarding
 * - Whether user has any email connected
 *
 * @module appCore/state/flows/useEmailOnboardingApi
 *
 * ## State Machine Integration
 *
 * This hook derives all state from the state machine.
 * Values are read-only; setters are no-ops (state machine is source of truth).
 *
 * Requires the state machine feature flag to be enabled.
 * If disabled, throws an error - legacy code paths have been removed.
 *
 * TASK-1612: Migrated to use authService instead of direct window.api calls.
 */

import { useCallback, useRef } from "react";
import { authService } from "@/services";
import {
  useOptionalMachineState,
  selectHasCompletedEmailOnboarding,
  selectHasEmailConnected,
} from "../machine";
import logger from '../../../utils/logger';

interface UseEmailOnboardingApiOptions {
  userId: string | undefined;
}

interface UseEmailOnboardingApiReturn {
  hasCompletedEmailOnboarding: boolean;
  hasEmailConnected: boolean;
  isCheckingEmailOnboarding: boolean;
  setHasCompletedEmailOnboarding: (completed: boolean) => void;
  /**
   * Mark email as connected. During onboarding, dispatches EMAIL_CONNECTED action
   * to update state machine.
   *
   * @param connected - Whether email is connected
   * @param email - The connected email address (required for state machine)
   * @param provider - The email provider (required for state machine)
   * @param anyStillConnected - On a disconnect: another mailbox is still
   *   connected (BACKLOG-3888). Omitted = none.
   */
  setHasEmailConnected: (
    connected: boolean,
    email?: string,
    provider?: "google" | "microsoft",
    anyStillConnected?: boolean
  ) => void;
  completeEmailOnboarding: () => Promise<void>;
}

export function useEmailOnboardingApi({
  userId: _userId,
}: UseEmailOnboardingApiOptions): UseEmailOnboardingApiReturn {
  const machineState = useOptionalMachineState();

  if (!machineState) {
    throw new Error(
      "useEmailOnboardingApi requires state machine to be enabled. " +
        "Legacy code paths have been removed."
    );
  }

  const { state, dispatch } = machineState;

  // BACKLOG-3673: latest state for callbacks that must keep a stable identity.
  const stateRef = useRef(state);
  stateRef.current = state;

  // BACKLOG-3673 (closes BACKLOG-3338's missing writer): the account's answer
  // to the email step is recorded ONCE per run, by whichever path answers it
  // first -- connecting a mailbox during setup, or skipping.
  const emailAnswerRecordedRef = useRef(false);

  // Derive hasCompletedEmailOnboarding from state machine
  const hasCompletedEmailOnboarding = selectHasCompletedEmailOnboarding(state);

  // Derive hasEmailConnected from state machine
  const hasEmailConnected = selectHasEmailConnected(state);

  // Loading if we're in loading phase before user data
  const isCheckingEmailOnboarding =
    state.status === "loading" &&
    [
      "checking-storage",
      "initializing-db",
      "loading-auth",
      "loading-user-data",
    ].includes(state.phase);

  // Setters are no-ops - state machine is source of truth
  const setHasCompletedEmailOnboarding = useCallback(
    (_completed: boolean) => {
      // No-op: state machine is source of truth
    },
    []
  );

  const setHasEmailConnected = useCallback(
    (
      connected: boolean,
      email?: string,
      provider?: "google" | "microsoft",
      anyStillConnected?: boolean
    ) => {
      if (connected && email && provider) {
        // BACKLOG-3673: connecting a mailbox DURING SETUP answers the email
        // step. Before this, only Skip recorded that answer on the server, so
        // an account that connected was asked the email step again on every
        // new computer. Fire-and-log: the answer only seeds a later resume.
        const current = stateRef.current;
        if (current.status === "onboarding" && !emailAnswerRecordedRef.current) {
          emailAnswerRecordedRef.current = true;
          const answeringUserId = current.user.id;
          void authService
            .completeEmailOnboarding(answeringUserId)
            .then((result) => {
              if (!result.success) {
                logger.warn(
                  "[useEmailOnboardingApi] Recording the email-step answer failed:",
                  result.error
                );
              }
            })
            .catch((error: unknown) => {
              logger.warn(
                "[useEmailOnboardingApi] Recording the email-step answer failed:",
                error
              );
            });
        }

        // Dispatch EMAIL_CONNECTED to update state machine
        dispatch({
          type: "EMAIL_CONNECTED",
          email,
          provider,
        });
      } else if (!connected && provider) {
        // TASK-1730: Dispatch EMAIL_DISCONNECTED to update state machine
        dispatch({
          type: "EMAIL_DISCONNECTED",
          provider,
          ...(anyStillConnected === true ? { anyStillConnected: true } : {}),
        });
      }
      // If missing provider info, no-op (state machine is source of truth)
    },
    [dispatch]
  );

  // completeEmailOnboarding persists to API and dispatches onboarding step complete
  const completeEmailOnboarding = useCallback(async (): Promise<void> => {
    // userId comes from state machine
    const currentUserId =
      state.status === "ready" || state.status === "onboarding"
        ? state.user.id
        : null;

    if (!currentUserId) return;

    try {
      emailAnswerRecordedRef.current = true;
      const result = await authService.completeEmailOnboarding(currentUserId);
      if (!result.success) {
        logger.warn(
          "[useEmailOnboardingApi] API call failed but continuing:",
          result.error
        );
      }

      // Dispatch onboarding step complete
      dispatch({
        type: "ONBOARDING_STEP_COMPLETE",
        step: "email-connect",
      });
    } catch (error) {
      logger.error(
        "[useEmailOnboardingApi] Failed to complete email onboarding:",
        error
      );
    }
  }, [state, dispatch]);

  return {
    hasCompletedEmailOnboarding,
    hasEmailConnected,
    isCheckingEmailOnboarding,
    setHasCompletedEmailOnboarding,
    setHasEmailConnected,
    completeEmailOnboarding,
  };
}
