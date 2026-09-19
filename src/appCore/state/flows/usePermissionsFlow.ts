/**
 * usePermissionsFlow Hook
 *
 * Manages macOS permissions checking and granting.
 * Also handles app location checking for move-to-Applications prompts.
 *
 * TASK-1612: Migrated to use systemService instead of direct window.api calls.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { systemService } from "@/services";
import type { AppStep } from "../types";
import type { AppAction } from "../machine/types";
import logger from '../../../utils/logger';

export interface UsePermissionsFlowOptions {
  isWindows: boolean;
  onSetShowMoveAppPrompt: (show: boolean) => void;
  onSetCurrentStep: (step: AppStep) => void;
  stateMachineDispatch?: React.Dispatch<AppAction>;
}

export interface UsePermissionsFlowReturn {
  // State
  hasPermissions: boolean;
  appPath: string;

  // Setters
  setHasPermissions: (value: boolean) => void;

  // Handlers
  handlePermissionsGranted: () => void;
  checkPermissions: () => Promise<void>;
}

export function usePermissionsFlow({
  isWindows,
  onSetShowMoveAppPrompt,
  onSetCurrentStep,
  stateMachineDispatch,
}: UsePermissionsFlowOptions): UsePermissionsFlowReturn {
  // Default to true to avoid flicker for returning users
  // The actual status will be verified by the effect below
  const [hasPermissions, setHasPermissions] = useState<boolean>(true);
  const [appPath, setAppPath] = useState<string>("");

  const checkPermissions = useCallback(async (): Promise<void> => {
    if (isWindows) {
      setHasPermissions(true);
      return;
    }
    const result = await systemService.checkAllPermissions();
    // Set based on actual permission status from service result
    if (result.success && result.data) {
      setHasPermissions(result.data.allGranted);
    } else {
      // On error, default to false to trigger permission prompts
      setHasPermissions(false);
    }
  }, [isWindows]);

  const checkAppLocation = useCallback(async (): Promise<void> => {
    try {
      // checkAppLocation is macOS-specific - for now skip on Windows
      // TODO: Implement checkAppLocation in systemBridge for macOS
      const result = { shouldPrompt: false, appPath: "" };
      setAppPath(result.appPath || "");
      const hasIgnored = localStorage.getItem("ignoreMoveAppPrompt");
      if (result.shouldPrompt && !hasIgnored) {
        onSetShowMoveAppPrompt(true);
      }
    } catch (error) {
      logger.error("[usePermissionsFlow] Error checking app location:", error);
    }
  }, [onSetShowMoveAppPrompt]);

  // Initial permission and app location check
  useEffect(() => {
    checkPermissions();
    checkAppLocation();
  }, [checkPermissions, checkAppLocation]);

  const handlePermissionsGranted = useCallback((): void => {
    setHasPermissions(true);
    // Dispatch to state machine to complete the permissions step.
    //
    // BACKLOG-3275: FDA_GRANTED first, and it is what records the capability.
    // The step completion that follows records only where the user is. This
    // hook is reached from handlePermissionsGranted, i.e. after the permission
    // check reported the capability is present — so this is the one place
    // entitled to assert it.
    if (stateMachineDispatch) {
      stateMachineDispatch({ type: "FDA_GRANTED" });
      stateMachineDispatch({ type: "ONBOARDING_STEP_COMPLETE", step: "permissions" });
    }
    // Legacy fallback (no-op if state machine is enabled)
    onSetCurrentStep("dashboard");
  }, [onSetCurrentStep, stateMachineDispatch]);

  return useMemo(
    () => ({
      hasPermissions,
      appPath,
      setHasPermissions,
      handlePermissionsGranted,
      checkPermissions,
    }),
    [hasPermissions, appPath, handlePermissionsGranted, checkPermissions],
  );
}
