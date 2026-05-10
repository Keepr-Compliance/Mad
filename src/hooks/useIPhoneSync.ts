import { useState, useEffect, useCallback, useRef } from "react";
import * as Sentry from "@sentry/electron/renderer";
import type {
  iOSDevice,
  BackupProgress,
  SyncStatus,
  UseIPhoneSyncReturn,
  UserFacingError,
} from "../types/iphone";
import logger from '../utils/logger';
import { syncOrchestrator } from '../services/SyncOrchestratorService';

/**
 * Module-level sync state ref for cross-hook communication.
 * Safe in single-threaded renderer. Checked by useSessionValidator
 * to defer logout during active sync.
 */
export const syncStateRef = { isActive: false, deferredLogout: false };

/**
 * Module-level callback ref for deferred logout.
 * Set by useSessionValidator so useIPhoneSync can trigger logout after sync ends.
 */
export let deferredLogoutCallback: (() => Promise<void>) | null = null;

/**
 * Called by useSessionValidator to register the deferred logout callback.
 */
export function setDeferredLogoutCallback(cb: (() => Promise<void>) | null): void {
  deferredLogoutCallback = cb;
}

/**
 * useIPhoneSync Hook
 * Manages iPhone device detection, connection state, and sync operations
 *
 * This hook provides:
 * - Device connection monitoring via sync API
 * - Full sync flow (backup → decrypt → parse)
 * - Password prompt handling for encrypted backups
 * - Progress tracking across all phases
 * - Error state management
 *
 * Uses the sync API which orchestrates:
 * 1. Device backup via idevicebackup2
 * 2. Backup decryption (if encrypted)
 * 3. Message and contact extraction
 */
export function useIPhoneSync(): UseIPhoneSyncReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [device, setDevice] = useState<iOSDevice | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // TASK-2276: Structured error for rich UI display
  const [userError, setUserError] = useState<UserFacingError | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [pendingPassword, setPendingPassword] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [isWaitingForPasscode, setIsWaitingForPasscode] = useState(false);
  // TASK-910: Sync lock state
  const [syncLocked, setSyncLocked] = useState(false);
  const [lockReason, setLockReason] = useState<string | null>(null);
  // BACKLOG-1582: Trust state — device visible but not yet trusted
  const [needsTrust, setNeedsTrust] = useState(false);
  const [needsTrustUdid, setNeedsTrustUdid] = useState<string | null>(null);
  // BACKLOG-1620/1621: Tools missing state — libimobiledevice not installed
  const [toolsMissing, setToolsMissing] = useState(false);

  // Track cleanup functions
  const cleanupRef = useRef<(() => void)[]>([]);
  // Track current progress phase for disconnect handler (avoids stale closure)
  const progressPhaseRef = useRef<BackupProgress["phase"] | null>(null);

  /**
   * Check unified sync status to detect if another operation is running
   * TASK-910: Prevents users from triggering concurrent syncs
   */
  const checkSyncStatus = useCallback(async () => {
    try {
      // Use type assertion to access getUnifiedStatus
      // Type is defined in window.d.ts but TypeScript infers narrower type from deviceBridge.ts
      type SyncApiWithUnifiedStatus = {
        getUnifiedStatus?: () => Promise<{
          isAnyOperationRunning: boolean;
          currentOperation: string | null;
        }>;
      };
      const syncApi = window.api?.sync as SyncApiWithUnifiedStatus | undefined;
      if (!syncApi?.getUnifiedStatus) {
        logger.warn("[useIPhoneSync] getUnifiedStatus not available");
        return;
      }

      const status = await syncApi.getUnifiedStatus();
      setSyncLocked(status.isAnyOperationRunning);
      setLockReason(status.currentOperation);

      // If an iPhone sync is running but our local state is idle (e.g., after
      // hot reload), reconnect by setting syncStatus to "syncing". The IPC
      // event listeners are already set up and will populate progress.
      if (
        status.isAnyOperationRunning &&
        status.currentOperation?.toLowerCase().includes("iphone")
      ) {
        setSyncStatus((current) => {
          if (current === "idle") {
            logger.info("[useIPhoneSync] Reconnecting to in-progress iPhone sync");
            return "syncing";
          }
          return current;
        });
        // Defer orchestrator registration to next microtask so React finishes
        // batching the state updates above before notifyListeners fires setState in App
        queueMicrotask(() => syncOrchestrator.registerExternalSync('iphone'));
        setProgress((current) => {
          if (!current) {
            return { phase: "backing_up", percent: 0, message: "Reconnecting to sync..." };
          }
          return current;
        });
      }
    } catch (err) {
      logger.error("[useIPhoneSync] Failed to check sync status:", err);
    }
  }, []);

  // Set up device detection and event listeners
  useEffect(() => {
    // Check if the sync API is available
    const syncApi = window.api?.sync;
    const deviceApi = window.api?.device;

    if (!syncApi && !deviceApi) {
      logger.warn("[useIPhoneSync] Neither sync nor device API available");
      return;
    }

    const cleanups: (() => void)[] = [];

    // Helper to handle device connection
    const handleDeviceConnected = async (device: unknown) => {
      const connectedDevice = device as iOSDevice;
      const mappedDevice: iOSDevice = {
        udid: connectedDevice.udid,
        name: connectedDevice.name,
        productType: connectedDevice.productType,
        productVersion: connectedDevice.productVersion,
        serialNumber: connectedDevice.serialNumber,
        isConnected: true,
      };
      setIsConnected(true);
      setDevice(mappedDevice);
      setError(null);
      // BACKLOG-1582: Clear trust state on successful connection
      setNeedsTrust(false);
      setNeedsTrustUdid(null);
      logger.debug("[useIPhoneSync] Device connected:", mappedDevice.name);

      // TASK-2121: Fetch persisted lastSyncTime from Supabase for this device
      try {
        const syncApi = window.api?.sync as {
          getIPhoneLastSyncTime?: (udid: string) => Promise<{ lastSyncTime: string | null }>;
        } | undefined;

        if (syncApi?.getIPhoneLastSyncTime) {
          const result = await syncApi.getIPhoneLastSyncTime(connectedDevice.udid);
          if (result.lastSyncTime) {
            setLastSyncTime(new Date(result.lastSyncTime));
          } else {
            setLastSyncTime(null);
          }
        } else {
          setLastSyncTime(null);
        }
      } catch (err) {
        logger.warn("[useIPhoneSync] Failed to fetch last sync time from Supabase:", err);
        setLastSyncTime(null);
      }
    };

    // === SET UP EVENT LISTENERS FIRST (before starting detection) ===
    if (syncApi) {
      // Device connected via sync API
      if (syncApi.onDeviceConnected) {
        const unsub = syncApi.onDeviceConnected(handleDeviceConnected);
        cleanups.push(unsub);
      }

      // Device disconnected via sync API
      if (syncApi.onDeviceDisconnected) {
        const unsub = syncApi.onDeviceDisconnected(() => {
          logger.debug("[useIPhoneSync] Device disconnected");
          setIsConnected(false);
          setDevice(null);
          // Only show error if sync is in a phase that requires the device
          // Phases that require device: preparing, backing_up
          // Phases safe to disconnect: extracting, storing, complete
          setSyncStatus((current) => {
            if (current === "syncing") {
              const currentPhase = progressPhaseRef.current;
              // Only show error if still in backup phase (device required)
              if (currentPhase === "backing_up" || currentPhase === "preparing") {
                setError("Device disconnected during sync");
                // Defer orchestrator notification to avoid setState-during-render
                queueMicrotask(() => {
                  syncOrchestrator.completeExternalSync('iphone', {
                    status: 'error',
                    error: 'Device disconnected during sync',
                  });
                });
                return "error";
              }
              // In extracting/storing phases, disconnect is fine - just log it
              logger.debug("[useIPhoneSync] Device disconnected but in safe phase:", currentPhase);
            }
            return current;
          });
        });
        cleanups.push(unsub);
      }

      // Sync progress updates
      if (syncApi.onProgress) {
        const unsub = syncApi.onProgress((syncProgress) => {
          // Ignore progress events after cancel
          if (!syncStateRef.isActive) return;
          // Map sync progress to BackupProgress format
          let phase: BackupProgress["phase"] = "backing_up";
          if (syncProgress.phase === "backup") {
            phase = "backing_up";
          } else if (syncProgress.phase === "decrypting") {
            phase = "extracting";
          } else if (
            syncProgress.phase === "parsing_messages" ||
            syncProgress.phase === "parsing_contacts" ||
            syncProgress.phase === "resolving"
          ) {
            phase = "extracting";
          } else if (syncProgress.phase === "complete") {
            phase = "complete";
          }

          // Extract bytes/files info from backupProgress if available
          // The backupProgress field contains detailed backup stats from idevicebackup2
          const progressWithBackup = syncProgress as {
            phase: string;
            overallProgress: number;
            message?: string;
            estimatedTotalBytes?: number;
            backupProgress?: {
              bytesTransferred?: number;
              filesTransferred?: number;
            };
          };

          // Update ref for disconnect handler (avoids stale closure)
          progressPhaseRef.current = phase;
          const percent = syncProgress.overallProgress ?? 0;
          setProgress({
            phase,
            percent,
            message: syncProgress.message,
            bytesProcessed: progressWithBackup.backupProgress?.bytesTransferred,
            processedFiles: progressWithBackup.backupProgress?.filesTransferred,
            estimatedTotalBytes: progressWithBackup.estimatedTotalBytes,
          });

          // TASK-2119: Update orchestrator with progress
          syncOrchestrator.updateExternalSync('iphone', { progress: percent, phase });
        });
        cleanups.push(unsub);
      }

      // Password required event
      if (syncApi.onPasswordRequired) {
        const unsub = syncApi.onPasswordRequired(() => {
          logger.debug("[useIPhoneSync] Password required for encrypted backup");
          setNeedsPassword(true);
        });
        cleanups.push(unsub);
      }

      // Passcode waiting event (user needs to enter passcode on iPhone)
      if (syncApi.onWaitingForPasscode) {
        const unsub = syncApi.onWaitingForPasscode(() => {
          logger.debug("[useIPhoneSync] Waiting for user to enter passcode on iPhone");
          setIsWaitingForPasscode(true);
          setProgress((prev) => ({
            phase: "backing_up",
            percent: prev?.percent ?? 0,
            message: "Your iPhone is preparing the export...",
          }));
        });
        cleanups.push(unsub);
      }

      // Passcode entered event (user entered passcode, backup starting)
      if (syncApi.onPasscodeEntered) {
        const unsub = syncApi.onPasscodeEntered(() => {
          logger.info("[useIPhoneSync] User entered passcode, backup starting");
          setIsWaitingForPasscode(false);
          setProgress((prev) => ({
            phase: "backing_up",
            percent: prev?.percent ?? 0,
            message: "Passcode accepted! iPhone is preparing backup...",
          }));
        });
        cleanups.push(unsub);
      }

      // Sync error events
      // TASK-2276: Handle enriched error payload with optional userError field
      if (syncApi.onError) {
        const unsub = syncApi.onError((err) => {
          // Ignore errors from a cancelled sync — cancelSync already reset state
          if (err.message?.toLowerCase().includes("cancelled") || err.message?.toLowerCase().includes("canceled")) {
            logger.info("[useIPhoneSync] Ignoring error from cancelled sync:", err.message);
            return;
          }
          logger.error("[useIPhoneSync] Sync error:", err.message);
          setSyncStatus("error");
          setError(err.message);

          // TASK-2276: Extract structured error for rich UI display
          const enrichedErr = err as { message: string; userError?: UserFacingError };
          if (enrichedErr.userError) {
            logger.info("[useIPhoneSync] Received structured user error:", enrichedErr.userError.code);
            setUserError(enrichedErr.userError);
          } else {
            setUserError(null);
          }

          // TASK-2119: Notify orchestrator of error
          syncOrchestrator.completeExternalSync('iphone', { status: 'error', error: err.message });
        });
        cleanups.push(unsub);
      }

      // Sync complete event (extraction done, now storing to DB)
      if (syncApi.onComplete) {
        interface SyncResultType {
          success: boolean;
          messageCount?: number;
          contactCount?: number;
          conversationCount?: number;
          error?: string;
        }
        const unsub = syncApi.onComplete((data: unknown) => {
          const result = data as SyncResultType;
          logger.info("[useIPhoneSync] Sync extraction complete:", {
            messages: result.messageCount ?? 0,
            contacts: result.contactCount ?? 0,
            conversations: result.conversationCount ?? 0,
          });

          if (result.success) {
            // Extraction complete, now storing to DB (status will update via onStorageComplete)
            setSyncStatus("syncing");
            setProgress({
              phase: "storing",
              percent: 0,
              message: `Saving ${(result.messageCount ?? 0).toLocaleString()} messages to database...`,
            });
          } else {
            setSyncStatus("error");
            setError(result.error || "Sync failed");
          }
          setNeedsPassword(false);
        });
        cleanups.push(unsub);
      }

      // Storage complete event (messages saved to DB)
      // Use type assertion since window.d.ts may not have this method yet
      const syncApiWithStorage = syncApi as typeof syncApi & {
        onStorageComplete?: (
          callback: (result: {
            messagesStored: number;
            contactsStored: number;
            duration: number;
          }) => void
        ) => () => void;
        onStorageError?: (callback: (err: { error: string }) => void) => () => void;
      };

      if (syncApiWithStorage.onStorageComplete) {
        const unsub = syncApiWithStorage.onStorageComplete((result) => {
          logger.info("[useIPhoneSync] Storage complete:", {
            messagesStored: result.messagesStored,
            contactsStored: result.contactsStored,
            duration: result.duration,
          });

          setSyncStatus("complete");
          setLastSyncTime(new Date());
          setProgress({
            phase: "complete",
            percent: 100,
            message: `Saved ${result.messagesStored.toLocaleString()} messages and ${result.contactsStored} contacts`,
          });

          // TASK-2119: Notify orchestrator that iPhone sync is complete
          syncOrchestrator.completeExternalSync('iphone', { status: 'complete' });
        });
        cleanups.push(unsub);
      }

      // Storage error event
      if (syncApiWithStorage.onStorageError) {
        const unsub = syncApiWithStorage.onStorageError((err) => {
          logger.error("[useIPhoneSync] Storage error:", err.error);
          // Still mark as complete since extraction succeeded, just storage failed
          setSyncStatus("complete");
          setProgress({
            phase: "complete",
            percent: 100,
            message: "Messages extracted but failed to save to database",
          });

          // TASK-2119: Notify orchestrator (storage error is still "complete" from sync perspective)
          syncOrchestrator.completeExternalSync('iphone', { status: 'complete' });
        });
        cleanups.push(unsub);
      }
    }

    // === FALLBACK: DEVICE API EVENT LISTENERS ===
    if (!syncApi && deviceApi) {
      // Device connected via device API
      if (deviceApi.onConnected) {
        const unsub = deviceApi.onConnected((connectedDevice) => {
          const mappedDevice: iOSDevice = {
            udid: connectedDevice.udid,
            name: connectedDevice.name,
            productType: connectedDevice.productType,
            productVersion: connectedDevice.productVersion,
            serialNumber: connectedDevice.serialNumber,
            isConnected: connectedDevice.isConnected,
          };
          setIsConnected(true);
          setDevice(mappedDevice);
          setError(null);
        });
        cleanups.push(unsub);
      }

      // Device disconnected via device API
      if (deviceApi.onDisconnected) {
        const unsub = deviceApi.onDisconnected(() => {
          setIsConnected(false);
          setDevice(null);
          // Only show error if sync is in a phase that requires the device
          setSyncStatus((current) => {
            if (current === "syncing") {
              const currentPhase = progressPhaseRef.current;
              // Only show error if still in backup phase (device required)
              if (currentPhase === "backing_up" || currentPhase === "preparing") {
                setError("Device disconnected during sync");
                return "error";
              }
              // In extracting/storing phases, disconnect is fine
              logger.debug("[useIPhoneSync] Device disconnected but in safe phase:", currentPhase);
            }
            return current;
          });
        });
        cleanups.push(unsub);
      }
    }

    // === NOW START DEVICE DETECTION (after all listeners are set up) ===
    // This order ensures we don't miss any events
    logger.info("[useIPhoneSync] Starting device detection...");

    // BACKLOG-1354: Breadcrumb when device detection starts in renderer
    Sentry.addBreadcrumb({
      category: "iphone.detection",
      message: "Device detection started from renderer",
      level: "info",
      data: {
        hasSyncApi: !!syncApi,
        hasDeviceApi: !!deviceApi,
      },
    });

    // BACKLOG-1582: Listen for device-needs-trust events
    // BACKLOG-1627: Enhanced with trust reason for differentiated UI guidance
    if (deviceApi) {
      type TrustEventData = { udid: string; reason?: "locked" | "trust_pending" | "unknown" };
      type DeviceApiWithTrust = { onNeedsTrust?: (cb: (data: TrustEventData) => void) => () => void };
      const deviceApiTyped = deviceApi as DeviceApiWithTrust;
      if (deviceApiTyped.onNeedsTrust) {
        const unsub = deviceApiTyped.onNeedsTrust((data) => {
          logger.info("[useIPhoneSync] Device needs trust:", data.udid, "reason:", data.reason);
          setNeedsTrust(true);
          setNeedsTrustUdid(data.udid);

          // BACKLOG-1627: Show differentiated user guidance based on trust error reason
          const guidance = mapTrustReasonToGuidance(data.reason);
          setUserError(guidance);
        });
        cleanups.push(unsub);
      }
    }

    // BACKLOG-1620/1621: Listen for tools-missing and tools-available events
    if (deviceApi) {
      if (deviceApi.onToolsMissing) {
        const unsub = deviceApi.onToolsMissing(() => {
          logger.warn("[useIPhoneSync] Tools missing — libimobiledevice not found");
          setToolsMissing(true);
          // BACKLOG-1702: Branch guidance by platform \u2014 Mac uses libimobiledevice
          // via brew, Windows uses Apple's iTunes drivers from the Microsoft Store.
          const isMac = process.platform === "darwin";
          setUserError({
            code: "MISSING_DRIVERS",
            title: isMac ? "iPhone sync tools not installed" : "Apple drivers not installed",
            description: isMac
              ? "Keepr needs libimobiledevice to communicate with your iPhone."
              : "Your computer needs Apple\u2019s tools to communicate with your iPhone.",
            actionSuggestion: isMac
              ? "Open Terminal and run: brew install libimobiledevice \u2014 then quit and reopen Keepr."
              : "Install iTunes from the Microsoft Store, then reconnect your iPhone and try again.",
          });
        });
        cleanups.push(unsub);
      }
      if (deviceApi.onToolsAvailable) {
        const unsub = deviceApi.onToolsAvailable(() => {
          logger.info("[useIPhoneSync] Tools now available — clearing missing state");
          setToolsMissing(false);
          setUserError(null);
        });
        cleanups.push(unsub);
      }
    }

    if (syncApi?.startDetection) {
      syncApi.startDetection();
    } else if (deviceApi?.startDetection) {
      deviceApi.startDetection();
    }

    // Store cleanups for later
    cleanupRef.current = cleanups;

    // Cleanup on unmount
    return () => {
      if (syncApi?.stopDetection) {
        syncApi.stopDetection();
      } else if (deviceApi?.stopDetection) {
        deviceApi.stopDetection();
      }
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  // TASK-910: Check sync status on mount and poll while component is mounted
  useEffect(() => {
    checkSyncStatus();
    // Poll every 5 seconds while component is mounted
    const interval = setInterval(checkSyncStatus, 5000);
    return () => clearInterval(interval);
  }, [checkSyncStatus]);

  // TASK-2109: Track sync state in module-level ref for cross-hook communication
  useEffect(() => {
    if (syncStatus === "syncing") {
      syncStateRef.isActive = true;
    } else if (syncStatus === "idle" || syncStatus === "complete" || syncStatus === "error") {
      syncStateRef.isActive = false;

      // If logout was deferred while sync was running, trigger it now
      if (syncStateRef.deferredLogout) {
        syncStateRef.deferredLogout = false;
        logger.info("[useIPhoneSync] Sync ended, triggering deferred logout");
        if (deferredLogoutCallback) {
          void deferredLogoutCallback();
        }
      }
    }
  }, [syncStatus]);

  // Start sync operation
  const startSync = useCallback(async () => {
    // TASK-2109: Block new syncs if a deferred logout is pending
    if (syncStateRef.deferredLogout) {
      logger.warn("[useIPhoneSync] Sync blocked - deferred logout pending");
      setError("Session expired. Please sign in again.");
      return;
    }

    if (!device) {
      logger.error("[useIPhoneSync] Cannot start sync: No device connected");

      // BACKLOG-1354: Breadcrumb when user tries to sync but no device detected
      // On Windows with drivers installed, this suggests trust/USB issue
      Sentry.addBreadcrumb({
        category: "iphone.detection",
        message: "Sync attempted with 0 devices detected",
        level: "warning",
        data: {
          platform: navigator.platform,
          hint: "No device connected when user initiated sync — possible trust dialog not shown or USB restriction",
        },
      });

      // BACKLOG-1582: Run diagnostics to give user actionable guidance
      try {
        type DiagnosticStep = { name: string; status: "pass" | "fail" | "skip"; error?: string };
        type DiagnosticResult = { success: boolean; steps?: DiagnosticStep[] };
        const deviceApi = window.api?.device as { runDiagnostics?: () => Promise<DiagnosticResult> } | undefined;
        if (deviceApi?.runDiagnostics) {
          const result = await deviceApi.runDiagnostics();
          if (result.success && result.steps) {
            const failedStep = result.steps.find((s: DiagnosticStep) => s.status === "fail");
            if (failedStep) {
              const guidance = mapDiagnosticToGuidance(failedStep);
              logger.info("[useIPhoneSync] Diagnostic guidance:", guidance.title);
              setUserError(guidance);
              setError(guidance.title);
              return;
            }
          }
        }
      } catch (err) {
        logger.warn("[useIPhoneSync] Diagnostic check failed (non-fatal):", err);
      }

      setError("No device connected");
      return;
    }

    const syncApi = window.api?.sync;
    if (!syncApi?.start) {
      logger.error("[useIPhoneSync] Sync API not available");
      setError("Sync service not available");
      return;
    }

    // TASK-910: Check if another sync is running before starting
    type SyncApiWithUnifiedStatus = {
      getUnifiedStatus?: () => Promise<{
        isAnyOperationRunning: boolean;
        currentOperation: string | null;
      }>;
    };
    const syncApiTyped = window.api?.sync as SyncApiWithUnifiedStatus | undefined;
    if (syncApiTyped?.getUnifiedStatus) {
      try {
        const status = await syncApiTyped.getUnifiedStatus();
        if (status.isAnyOperationRunning) {
          logger.warn("[useIPhoneSync] Sync blocked - another operation running:", status.currentOperation);
          setSyncLocked(true);
          setLockReason(status.currentOperation);
          return;
        }
      } catch (err) {
        logger.error("[useIPhoneSync] Failed to check sync status:", err);
        // Continue with sync attempt if status check fails
      }
    }

    setSyncStatus("syncing");
    setError(null);
    setUserError(null); // TASK-2276: Clear structured error on new sync
    setNeedsPassword(false);
    setProgress({
      phase: "preparing",
      percent: 0,
      message: "Preparing to sync...",
    });

    // TASK-2119: Register with orchestrator so iPhone appears in unified sync UI
    syncOrchestrator.registerExternalSync('iphone');

    try {
      logger.info("[useIPhoneSync] Starting sync for device:", device.udid);

      // If we have a pending password, include it
      const result = await syncApi.start({
        udid: device.udid,
        password: pendingPassword ?? undefined,
        forceFullBackup: false,
      });

      // Clear pending password after use
      setPendingPassword(null);

      if (!result) {
        logger.error("[useIPhoneSync] Sync returned null result");
        setSyncStatus("error");
        setError("Sync service returned no result");
        return;
      }

      // Result handling is done via onComplete callback
      // But we handle immediate errors here
      if (!result.success && result.error) {
        // If the error is from a cancel, treat as clean idle — not an error
        if (result.error.toLowerCase().includes("cancelled")) {
          logger.info("[useIPhoneSync] Sync was cancelled, ignoring error result");
          return;
        }
        logger.error("[useIPhoneSync] Sync failed:", result.error);
        setSyncStatus("error");
        setError(result.error);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "An unexpected error occurred";
      if (errorMessage.toLowerCase().includes("cancelled") || errorMessage.toLowerCase().includes("canceled")) {
        logger.info("[useIPhoneSync] Sync was cancelled, ignoring catch error");
        return;
      }
      logger.error("[useIPhoneSync] Sync error:", errorMessage);
      setSyncStatus("error");
      setError(errorMessage);
    }
  }, [device, pendingPassword]);

  // Submit password for encrypted backups
  const submitPassword = useCallback(
    async (password: string) => {
      if (!device) {
        logger.error(
          "[useIPhoneSync] Cannot submit password: No device connected"
        );
        setError("No device connected");
        return;
      }

      logger.info("[useIPhoneSync] Password submitted, retrying sync");
      setError(null);
      setPendingPassword(password);
      setNeedsPassword(false);

      // Retry sync with password
      const syncApi = window.api?.sync;
      if (!syncApi?.start) {
        setError("Sync service not available");
        return;
      }

      setProgress({
        phase: "preparing",
        percent: 0,
        message: "Verifying password...",
      });

      try {
        const result = await syncApi.start({
          udid: device.udid,
          password: password,
        });

        // Clear pending password
        setPendingPassword(null);

        if (!result?.success && result?.error) {
          if (
            result.error.includes("password") ||
            result.error.includes("decrypt")
          ) {
            setNeedsPassword(true);
            setError("Incorrect password. Please try again.");
          } else {
            setSyncStatus("error");
            setError(result.error);
          }
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "An unexpected error occurred";
        logger.error("[useIPhoneSync] Password submit error:", errorMessage);
        setNeedsPassword(true);
        setError(errorMessage);
        setPendingPassword(null);
      }
    },
    [device]
  );

  // Cancel ongoing sync
  const cancelSync = useCallback(async () => {
    logger.info("[useIPhoneSync] Cancelling sync");
    syncStateRef.isActive = false;

    try {
      const syncApi = window.api?.sync;
      if (syncApi?.cancel) {
        await syncApi.cancel();
      }
    } catch (err) {
      logger.warn("[useIPhoneSync] Cancel error (ignored):", err);
    }

    setSyncStatus("idle");
    setProgress(null);
    setNeedsPassword(false);
    setError(null);
    setUserError(null); // TASK-2276: Clear structured error on cancel
    setPendingPassword(null);
    setSyncLocked(false);
    setLockReason(null);

    // TASK-2119: Remove iPhone from orchestrator queue (cancel ≠ complete)
    syncOrchestrator.removeExternalSync('iphone');
  }, []);

  /** Reset state after user acknowledges sync completion (clicks Continue) */
  const dismissSync = useCallback(() => {
    logger.info("[useIPhoneSync] Dismissing sync result");
    setSyncStatus("idle");
    setProgress(null);
    setError(null);
    setUserError(null); // TASK-2276: Clear structured error on dismiss
  }, []);

  /** BACKLOG-1582: Manually request trust/pairing with the detected device */
  const requestTrust = useCallback(async () => {
    const udid = needsTrustUdid;
    if (!udid) {
      logger.warn("[useIPhoneSync] No device UDID to request trust for");
      return;
    }

    logger.info("[useIPhoneSync] Requesting trust for device:", udid);
    try {
      type DeviceApiWithTrust = { requestTrust?: (udid: string) => Promise<{ success: boolean; needsTrust?: boolean; error?: string }> };
      const deviceApi = window.api?.device as DeviceApiWithTrust | undefined;
      if (deviceApi?.requestTrust) {
        const result = await deviceApi.requestTrust(udid);
        if (result.needsTrust) {
          setUserError({
            code: "TRUST_REQUESTED",
            title: "Check your iPhone",
            description: "A \"Trust This Computer?\" prompt has been sent to your iPhone.",
            actionSuggestion: "Unlock your iPhone, tap Trust, and enter your passcode.",
          });
        } else if (result.success) {
          setNeedsTrust(false);
          setNeedsTrustUdid(null);
        }
      }
    } catch (err) {
      logger.error("[useIPhoneSync] Request trust failed:", err);
    }
  }, [needsTrustUdid]);

  return {
    isConnected,
    device,
    syncStatus,
    progress,
    error,
    userError, // TASK-2276: Structured error for rich UI display
    needsPassword,
    lastSyncTime,
    isWaitingForPasscode,
    // TASK-910: Sync lock state
    syncLocked,
    lockReason,
    // BACKLOG-1582: Trust state
    needsTrust,
    needsTrustUdid,
    // BACKLOG-1620/1621: Tools missing state
    toolsMissing,
    startSync,
    submitPassword,
    cancelSync,
    dismissSync,
    checkSyncStatus,
    requestTrust,
  };
}

/**
 * BACKLOG-1627: Map a trust error reason to user-facing guidance.
 * Called when the main process detects a trust-related error from getDeviceInfo.
 */
function mapTrustReasonToGuidance(
  reason?: "locked" | "trust_pending" | "unknown",
): UserFacingError {
  switch (reason) {
    case "locked":
      return {
        code: "DEVICE_LOCKED",
        title: "iPhone is locked",
        description: "Your iPhone needs to be unlocked before it can connect.",
        actionSuggestion: "Unlock your iPhone and tap Trust when prompted.",
      };
    case "trust_pending":
      return {
        code: "TRUST_PENDING",
        title: "Check your iPhone",
        description: "A \"Trust This Computer?\" dialog is waiting on your iPhone.",
        actionSuggestion: "Tap Trust on your iPhone to allow syncing.",
      };
    default:
      return {
        code: "TRUST_NEEDED",
        title: "Tap Trust on your iPhone",
        description: "Your iPhone was detected but needs to trust this computer before syncing.",
        actionSuggestion: "Unlock your iPhone and tap Trust when prompted. If no prompt appears, try disconnecting and reconnecting.",
      };
  }
}

/**
 * BACKLOG-1582: Map a failed diagnostic step to user-facing guidance.
 */
function mapDiagnosticToGuidance(
  failedStep: { name: string; error?: string },
): UserFacingError {
  switch (failedStep.name) {
    case "libimobiledevice_check":
      return {
        code: "MISSING_DRIVERS",
        title: "Apple drivers not installed",
        description: "Your computer needs Apple's tools to communicate with your iPhone.",
        actionSuggestion: "Install iTunes from the Microsoft Store, then reconnect your iPhone and try again.",
      };
    case "device_enumeration":
      return {
        code: "NO_DEVICE_DETECTED",
        title: "iPhone not detected",
        description: "Apple tools are installed but no iPhone was found. Make sure your phone is unlocked and connected via USB.",
        actionSuggestion: "Unlock your iPhone, tap \"Trust This Computer\" if prompted, and try a different USB cable or port.",
      };
    case "device_info":
      return {
        code: "DEVICE_INFO_FAILED",
        title: "Cannot communicate with iPhone",
        description: "Your iPhone is connected but not responding. It may need to be trusted or unlocked.",
        actionSuggestion: "Unlock your iPhone and tap \"Trust This Computer\" when prompted. If that doesn't work, try disconnecting and reconnecting.",
      };
    default:
      return {
        code: "DETECTION_FAILED",
        title: "Device detection failed",
        description: failedStep.error || "An unexpected error occurred while checking for connected devices.",
        actionSuggestion: "Try disconnecting and reconnecting your iPhone, or restart the app.",
      };
  }
}

export default useIPhoneSync;
