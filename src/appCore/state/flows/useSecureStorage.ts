/**
 * useSecureStorage Hook
 *
 * Manages secure storage initialization and keychain state.
 * Handles:
 * - Checking if encryption key store exists
 * - Database initialization
 *
 * There is no Windows-specific initialization here, despite what this docblock
 * claimed until BACKLOG-3253. `autoInitializesStorage()` (platformInit.ts)
 * picks between two branches that call the identical IPC with identical
 * dispatches; DPAPI-vs-Keychain lives entirely inside Electron `safeStorage`.
 *
 * @module appCore/state/flows/useSecureStorage
 *
 * ## State Machine Integration
 *
 * This hook derives all state from the state machine.
 * The LoadingOrchestrator handles actual initialization.
 *
 * BACKLOG-3253 deleted the first-run-macOS deferral, so `deferredDbInit` is no
 * longer produced anywhere and `initializeSecureStorage()` always takes its
 * "already initialized" return. The deferred branch is kept, inert, until the
 * flag itself is removed (see the follow-up noted on BACKLOG-3253).
 *
 * Requires the state machine feature flag to be enabled.
 * If disabled, throws an error - legacy code paths have been removed.
 *
 * TASK-1612: Migrated to use systemService and settingsService instead of direct window.api calls.
 */

import { useCallback } from "react";
import { systemService, settingsService } from "@/services";
import type { PendingOnboardingData } from "../types";
import type { PendingOAuthData } from "../../../components/Login";
import type { Subscription } from "../../../../electron/types/models";
import {
  useOptionalMachineState,
  selectIsDatabaseInitialized,
  selectIsCheckingSecureStorage,
  selectIsInitializingDatabase,
  selectIsDeferredDbInit,
} from "../machine";
import logger from '../../../utils/logger';

// Interface kept for API compatibility - callers still pass these props
// but they are not used (state machine is source of truth)
interface UseSecureStorageOptions {
  isWindows: boolean;
  isMacOS: boolean;
  pendingOAuthData: PendingOAuthData | null;
  pendingOnboardingData: PendingOnboardingData;
  isAuthenticated: boolean;
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
    isNewUser: boolean
  ) => void;
  onPendingOAuthClear: () => void;
  onPendingOnboardingClear: () => void;
  onPhoneTypeSet: (hasSelected: boolean) => void;
  onEmailOnboardingComplete: (completed: boolean, connected: boolean) => void;
  onNewUserFlowSet: (isNew: boolean) => void;
  onNeedsDriverSetup: (needs: boolean) => void;
}

interface UseSecureStorageReturn {
  hasSecureStorageSetup: boolean;
  isCheckingSecureStorage: boolean;
  isDatabaseInitialized: boolean;
  isInitializingDatabase: boolean;
  initializeSecureStorage: () => Promise<boolean>;
}

export function useSecureStorage(
  // Options kept for API compatibility but not used - state machine is source of truth
  _options: UseSecureStorageOptions
): UseSecureStorageReturn {
  const machineState = useOptionalMachineState();

  if (!machineState) {
    throw new Error(
      "useSecureStorage requires state machine to be enabled. " +
        "Legacy code paths have been removed."
    );
  }

  const { state } = machineState;

  // Derive boolean states from state machine
  const isDatabaseInitialized = selectIsDatabaseInitialized(state);
  const isCheckingSecureStorage = selectIsCheckingSecureStorage(state);
  const isInitializingDatabase = selectIsInitializingDatabase(state);

  // hasSecureStorageSetup is true once we're past the storage check phase
  const hasSecureStorageSetup =
    state.status !== "loading" || state.phase !== "checking-storage";

  const { dispatch } = machineState;

  // Check if DB init was deferred (first-time macOS users)
  // Use the dedicated selector for accurate detection
  const isDeferredDbInit = selectIsDeferredDbInit(state);

  // initializeSecureStorage: triggers DB init for first-time macOS users
  // After DB init succeeds, syncs any queued data (like phone type) to the database
  const initializeSecureStorage = useCallback(
    async (): Promise<boolean> => {
      // For first-time macOS users with deferred DB init, trigger it now
      // This is the point where the user has been informed about the Keychain prompt
      if (isDeferredDbInit) {
        try {
          dispatch({ type: "DB_INIT_STARTED" });

          const result = await systemService.initializeSecureStorage();

          dispatch({
            type: "DB_INIT_COMPLETE",
            success: result.success,
            error: result.error,
          });

          // After successful DB init, sync any queued phone type to the database
          if (result.success && state.status === "onboarding" && state.selectedPhoneType) {
            const userId = state.user.id;
            const phoneType = state.selectedPhoneType;
            try {
              const syncResult = await settingsService.setPhoneType(userId, phoneType);
              if (syncResult.success) {
                logger.info("[useSecureStorage] Synced queued phone type to DB:", phoneType);
              } else {
                logger.warn("[useSecureStorage] Failed to sync phone type to DB:", syncResult.error);
              }
            } catch (syncError) {
              // Log but don't fail - phone type is already in state
              logger.warn("[useSecureStorage] Failed to sync phone type to DB:", syncError);
            }
          }

          return result.success;
        } catch (error) {
          dispatch({
            type: "DB_INIT_COMPLETE",
            success: false,
            error: error instanceof Error ? error.message : "Database initialization failed",
          });
          return false;
        }
      }

      // For returning users or Windows, DB is already initialized
      return true;
    },
    [dispatch, isDeferredDbInit, state]
  );

  return {
    hasSecureStorageSetup,
    isCheckingSecureStorage,
    isDatabaseInitialized,
    isInitializingDatabase,
    initializeSecureStorage,
  };
}
