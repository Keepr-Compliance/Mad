/**
 * usePhoneTypeApi Hook
 *
 * Handles phone type selection and persistence.
 * Checks:
 * - User's stored phone type from database
 * - Windows + iPhone driver setup requirements
 *
 * @module appCore/state/flows/usePhoneTypeApi
 *
 * ## State Machine Integration
 *
 * This hook derives all state from the state machine.
 * Values are read-only; setters are no-ops (state machine is source of truth).
 *
 * Requires the state machine feature flag to be enabled.
 * If disabled, throws an error - legacy code paths have been removed.
 *
 * TASK-1612: Migrated to use settingsService instead of direct window.api calls.
 */

import { useCallback } from "react";
import { settingsService } from "@/services";
import type { PhoneType } from "../types";
import {
  useOptionalMachineState,
  selectHasSelectedPhoneType,
  selectPhoneType,
  selectIsDatabaseInitialized,
} from "../machine";
import logger from '../../../utils/logger';

interface UsePhoneTypeApiOptions {
  userId: string | undefined;
  isWindows: boolean;
}

interface UsePhoneTypeApiReturn {
  hasSelectedPhoneType: boolean;
  selectedPhoneType: PhoneType;
  isLoadingPhoneType: boolean;
  needsDriverSetup: boolean;
  setHasSelectedPhoneType: (selected: boolean) => void;
  setSelectedPhoneType: (type: PhoneType) => void;
  setNeedsDriverSetup: (needs: boolean) => void;
  savePhoneType: (phoneType: "iphone" | "android") => Promise<boolean>;
}

export function usePhoneTypeApi({
  userId: _userId,
  isWindows: _isWindows,
}: UsePhoneTypeApiOptions): UsePhoneTypeApiReturn {
  const machineState = useOptionalMachineState();

  if (!machineState) {
    throw new Error(
      "usePhoneTypeApi requires state machine to be enabled. " +
        "Legacy code paths have been removed."
    );
  }

  const { state, dispatch } = machineState;

  // Derive hasSelectedPhoneType from state machine
  const hasSelectedPhoneType = selectHasSelectedPhoneType(state);

  // Loading if we're in loading phase before user data
  const isLoadingPhoneType =
    state.status === "loading" &&
    [
      "checking-storage",
      "initializing-db",
      "loading-auth",
      "loading-user-data",
    ].includes(state.phase);

  // Get phone type from state machine
  const selectedPhoneType = selectPhoneType(state);

  // Derive needsDriverSetup from state machine
  // When ready, it's in userData; when onboarding, derive from platform
  const needsDriverSetup =
    state.status === "ready"
      ? state.userData.needsDriverSetup
      : state.status === "onboarding" &&
        state.platform.isWindows &&
        state.platform.hasIPhone;

  // Setters are no-ops - state machine is source of truth
  const setHasSelectedPhoneType = useCallback((_selected: boolean) => {
    // No-op: state machine is source of truth
  }, []);

  const setSelectedPhoneType = useCallback((_type: PhoneType) => {
    // No-op: state machine is source of truth
  }, []);

  const setNeedsDriverSetup = useCallback((_needs: boolean) => {
    // No-op: state machine is source of truth
  }, []);

  /**
   * Save phone type to storage and dispatch step completion.
   *
   * TASK-1600: Saves to Supabase first (always available after auth),
   * then to local DB when initialized. This allows phone-type selection
   * to work before database initialization.
   *
   * TASK-1612: Migrated to use settingsService instead of direct window.api calls.
   *
   * Storage priority:
   * 1. Supabase cloud (always available after auth)
   * 2. Local SQLite (when initialized, for offline support)
   * 3. State machine (source of truth for UI)
   */
  const savePhoneType = useCallback(
    async (phoneType: "iphone" | "android"): Promise<boolean> => {
      // userId comes from state machine
      const currentUserId =
        state.status === "ready" || state.status === "onboarding"
          ? state.user.id
          : null;

      if (!currentUserId) return false;

      try {
        // 1. Save to Supabase first (always available after auth)
        // TASK-1600: This allows phone type selection before DB init
        const cloudResult = await settingsService.setPhoneTypeCloud(
          currentUserId,
          phoneType
        );

        if (!cloudResult.success) {
          // Log but don't fail - graceful degradation
          logger.warn(
            "[usePhoneTypeApi] Failed to save to Supabase, continuing:",
            cloudResult.error
          );
        } else {
          logger.debug(
            "[usePhoneTypeApi] Phone type saved to Supabase:",
            phoneType
          );
        }

        // BACKLOG-1842: Persist the messages import source when the user picks
        // Android, so the dashboard sync path (useAutoRefresh /
        // SyncOrchestratorService) never imports local macOS iMessages for an
        // Android user. Those readers gate macOS messages on the persisted
        // `messages.source` preference, which defaults to 'macos-native' and is
        // otherwise only written by the post-onboarding Settings UI. Before the
        // FDA reorder (BACKLOG-1842) PermissionsStep guarded this with an
        // explicit phoneType==='android' check; setting the preference once here
        // fixes every reader with no per-read fallback. Stored in Supabase
        // (cloud) like setPhoneTypeCloud above, so it works before local DB init.
        // Best-effort: a failure is non-fatal (log-but-continue).
        if (phoneType === "android") {
          try {
            const prefResult = await settingsService.updatePreferences(
              currentUserId,
              { messages: { source: "android-companion" } }
            );
            if (!prefResult.success) {
              logger.warn(
                "[usePhoneTypeApi] Failed to set Android messages source, continuing:",
                prefResult.error
              );
            }
          } catch (prefError) {
            logger.warn(
              "[usePhoneTypeApi] Error setting Android messages source:",
              prefError
            );
          }
        }

        // 2. Try local DB if initialized (for offline support)
        const isDbReady = selectIsDatabaseInitialized(state);

        if (isDbReady) {
          try {
            const localResult = await settingsService.setPhoneType(
              currentUserId,
              phoneType
            );
            if (!localResult.success) {
              logger.warn(
                "[usePhoneTypeApi] Failed to save to local DB:",
                localResult.error
              );
            }
          } catch (localError) {
            // Log but don't fail - Supabase is primary storage
            logger.warn(
              "[usePhoneTypeApi] Error saving to local DB:",
              localError
            );
          }
        } else {
          logger.debug(
            "[usePhoneTypeApi] Local DB not initialized, phone type queued in state"
          );
        }

        // 3. Dispatch onboarding step complete with the selected phone type
        // This ensures the reducer uses the user's actual selection,
        // not platform detection (fixes TASK-1180 onboarding loop bug)
        dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "phone-type",
          phoneType,
        });

        return true;
      } catch (error) {
        logger.error("[usePhoneTypeApi] Error saving phone type:", error);
        return false;
      }
    },
    [state, dispatch]
  );

  return {
    hasSelectedPhoneType,
    selectedPhoneType,
    isLoadingPhoneType,
    needsDriverSetup,
    setHasSelectedPhoneType,
    setSelectedPhoneType,
    setNeedsDriverSetup,
    savePhoneType,
  };
}
