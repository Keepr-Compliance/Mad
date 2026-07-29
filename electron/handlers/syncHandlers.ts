/**
 * Sync IPC Handlers
 *
 * Handles IPC communication between renderer and main process
 * for iPhone sync operations on Windows.
 */

import { ipcMain, BrowserWindow } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import { redactId } from "../utils/redactSensitive";
import {
  DeviceSyncOrchestrator,
  deviceSyncOrchestrator,
  SyncProgress,
  SyncResult,
} from "../services/deviceSyncOrchestrator";
import { iPhoneSyncStorageService } from "../services/iPhoneSyncStorageService";
import { autoLinkNewMessagesForUser, expandAttachedThreadsForUser } from "../services/autoLinkService";
import sessionService from "../services/sessionService";
import type { iOSDevice } from "../types/device";
import { rateLimiters } from "../utils/rateLimit";
import { syncStatusService } from "../services/syncStatusService";
import supabaseService from "../services/supabaseService";

let orchestrator: DeviceSyncOrchestrator | null = null;
let mainWindowRef: BrowserWindow | null = null;
let currentUserId: string | null = null;
// Track user ID at sync start to prevent race conditions
let syncSessionUserId: string | null = null;
// TASK-2121: Track device info at sync start for Supabase persistence
let syncSessionDeviceUdid: string | null = null;
let syncSessionDeviceName: string | null = null;
// TASK-2110: Cancellation signal ref shared between sync:cancel and persistence
const persistCancelSignal = { cancelled: false };

/**
 * Send event to renderer process
 */
function sendToRenderer(channel: string, data: unknown): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data);
  }
}

/**
 * Get the current user ID, trying multiple sources
 * 1. Use currentUserId if already set via setSyncUserId
 * 2. Fall back to loading from session file
 * 3. Fall back to Supabase auth session (SDK may have a valid session even if local file is missing)
 *
 * BACKLOG-1630: Enhanced with Supabase fallback and Sentry alerting.
 * Without a user ID the entire sync runs but saves nothing — a data loss scenario.
 */
async function getCurrentUserIdForSync(): Promise<string | null> {
  // First try the cached currentUserId
  if (currentUserId) {
    return currentUserId;
  }

  // Fall back to loading from session file
  log.info("[SyncHandlers] currentUserId not set, attempting to load from session...");
  try {
    const session = await sessionService.loadSession();
    if (session?.user?.id) {
      log.info("[SyncHandlers] Loaded user ID from session file", { userId: redactId(session.user.id) });
      // Also update currentUserId for future calls
      currentUserId = session.user.id;
      return session.user.id;
    }
  } catch (error) {
    log.error("[SyncHandlers] Failed to load session for user ID", { error });
  }

  // BACKLOG-1630: Fall back to Supabase auth session
  // The Supabase SDK may have a valid session even when the local session file is missing
  // (e.g., after deep-link login where the session was set on the SDK but file write failed)
  log.info("[SyncHandlers] Session file fallback failed, trying Supabase auth session...");
  try {
    const supabaseUserId = supabaseService.getAuthUserId();
    if (supabaseUserId) {
      log.info("[SyncHandlers] Loaded user ID from Supabase auth session", { userId: redactId(supabaseUserId) });
      currentUserId = supabaseUserId;
      return supabaseUserId;
    }
  } catch (error) {
    log.error("[SyncHandlers] Failed to get user ID from Supabase auth", { error });
  }

  // BACKLOG-1630: Last resort — try Supabase SDK getSession() which may have tokens even if
  // getAuthUserId() (which uses a cached field) is empty
  try {
    const { data: { session: supaSession } } = await supabaseService.getClient().auth.getSession();
    if (supaSession?.user?.id) {
      log.info("[SyncHandlers] Loaded user ID from Supabase SDK session", { userId: redactId(supaSession.user.id) });
      currentUserId = supaSession.user.id;
      return supaSession.user.id;
    }
  } catch (error) {
    log.error("[SyncHandlers] Failed to get user ID from Supabase SDK session", { error });
  }

  log.warn("[SyncHandlers] Could not determine user ID from any source");
  return null;
}

/**
 * Register sync-related IPC handlers
 * @param mainWindow - The main BrowserWindow
 * @param userId - The current user's ID (optional, can be set later via setCurrentUserId)
 */
export function registerSyncHandlers(mainWindow: BrowserWindow, userId?: string): void {
  mainWindowRef = mainWindow;
  orchestrator = deviceSyncOrchestrator;
  if (userId) {
    currentUserId = userId;
  }

  // Set up event forwarding to renderer
  setupEventForwarding();

  // Start sync operation
  // Rate limited: 10 second cooldown per device to prevent sync spam.
  // Syncs involve device communication and database writes.
  ipcMain.handle(
    "sync:start",
    async (
      _,
      options: { udid: string; password?: string; forceFullBackup?: boolean },
    ) => {
      log.info("[SyncHandlers] Starting sync", { udid: options.udid });

      // Rate limit check - 10 second cooldown per device
      const { allowed, remainingMs } = rateLimiters.sync.canExecute(
        "sync:start",
        options.udid
      );
      if (!allowed && remainingMs !== undefined) {
        const seconds = Math.ceil(remainingMs / 1000);
        log.warn(
          `[SyncHandlers] Rate limited sync:start for device ${options.udid}. ` +
            `Retry in ${seconds}s`
        );
        return {
          success: false,
          messages: [],
          contacts: [],
          conversations: [],
          error: `Please wait ${seconds} seconds before starting another sync.`,
          duration: 0,
          rateLimited: true,
        };
      }

      // Capture user ID at sync start to prevent race conditions
      // This ensures data is saved to the correct user even if login state changes during sync
      syncSessionUserId = await getCurrentUserIdForSync();
      if (!syncSessionUserId) {
        // BACKLOG-1630: Block sync when no user ID is available.
        // Without a user ID the entire sync runs (potentially hours) but saves nothing.
        // This is a data loss scenario — alert via Sentry and return an error immediately.
        const errorMsg = "Cannot start sync: no authenticated user found. Please sign out and sign back in.";
        log.error("[SyncHandlers] No user ID available at sync start - blocking sync to prevent data loss");
        Sentry.captureMessage("Sync blocked: no user ID available at sync start", {
          level: "error",
          tags: { component: "sync", operation: "sync:start", severity: "data_loss_prevention" },
        });
        return {
          success: false,
          messages: [],
          contacts: [],
          conversations: [],
          error: errorMsg,
          duration: 0,
        };
      }
      log.info("[SyncHandlers] User ID captured for sync persistence", { userId: redactId(syncSessionUserId) });

      // TASK-2121: Capture device UDID for Supabase lastSyncTime persistence
      syncSessionDeviceUdid = options.udid;

      // Check if sync is stuck and force reset if needed
      const status = orchestrator?.getStatus();
      if (status?.isRunning) {
        log.warn("[SyncHandlers] Sync appears stuck, forcing reset before starting");
        orchestrator?.forceReset();
      }

      try {
        const result = await orchestrator!.sync(options);
        return result;
      } catch (error) {
        log.error("[SyncHandlers] Sync error", { error });
        // Reset state on error
        orchestrator?.forceReset();
        syncSessionUserId = null; // Clear session user ID on error
        syncSessionDeviceUdid = null; // TASK-2121: Clear device UDID on error
        syncSessionDeviceName = null;
        return {
          success: false,
          messages: [],
          contacts: [],
          conversations: [],
          error: error instanceof Error ? error.message : "Unknown error",
          duration: 0,
        };
      }
    },
  );

  // Cancel sync operation
  ipcMain.handle("sync:cancel", () => {
    log.info("[SyncHandlers] Cancelling sync");
    orchestrator?.cancel();
    // TASK-2110: Signal persistence phase to stop and roll back
    persistCancelSignal.cancelled = true;
    return { success: true };
  });

  // Force reset sync state (for recovery from stuck state)
  ipcMain.handle("sync:reset", () => {
    log.info("[SyncHandlers] Force resetting sync state");
    orchestrator?.forceReset();
    return { success: true };
  });

  // Get current sync status
  ipcMain.handle("sync:status", () => {
    return orchestrator?.getStatus() || { isRunning: false, phase: "idle" };
  });

  // Get unified sync status (aggregates backup + orchestrator state)
  // TASK-904: Exposes combined sync state to UI for preventing concurrent operations
  ipcMain.handle("sync:getUnifiedStatus", () => {
    return syncStatusService.getStatus();
  });

  // Process existing backup without running new backup (for testing)
  ipcMain.handle(
    "sync:process-existing",
    async (_, options: { udid: string; password?: string }) => {
      log.info("[SyncHandlers] Processing existing backup", { udid: options.udid });

      // Capture user ID at sync start to prevent race conditions
      syncSessionUserId = await getCurrentUserIdForSync();
      if (!syncSessionUserId) {
        // BACKLOG-1630: Block sync when no user ID is available
        const errorMsg = "Cannot start sync: no authenticated user found. Please sign out and sign back in.";
        log.error("[SyncHandlers] No user ID available at sync start - blocking sync to prevent data loss");
        Sentry.captureMessage("Sync blocked: no user ID available at sync start", {
          level: "error",
          tags: { component: "sync", operation: "sync:process-existing", severity: "data_loss_prevention" },
        });
        return {
          success: false,
          messages: [],
          contacts: [],
          conversations: [],
          error: errorMsg,
          duration: 0,
        };
      }
      log.info("[SyncHandlers] User ID captured for sync persistence", { userId: redactId(syncSessionUserId) });

      // Check if sync is stuck and force reset if needed
      const status = orchestrator?.getStatus();
      if (status?.isRunning) {
        log.warn("[SyncHandlers] Sync appears stuck, forcing reset before processing");
        orchestrator?.forceReset();
      }

      try {
        const result = await orchestrator!.processExistingBackup(options.udid, options.password);
        return result;
      } catch (error) {
        log.error("[SyncHandlers] Process existing backup error", { error });
        orchestrator?.forceReset();
        syncSessionUserId = null; // Clear session user ID on error
        return {
          success: false,
          messages: [],
          contacts: [],
          conversations: [],
          error: error instanceof Error ? error.message : "Unknown error",
          duration: 0,
        };
      }
    }
  );

  // Get connected devices
  ipcMain.handle("sync:devices", () => {
    return orchestrator?.getConnectedDevices() || [];
  });

  // Start device detection polling
  ipcMain.handle("sync:start-detection", (_, intervalMs?: number) => {
    log.info("[SyncHandlers] Starting device detection");
    orchestrator?.startDeviceDetection(intervalMs);

    // Return any already-connected devices immediately
    const devices = orchestrator?.getConnectedDevices() || [];
    log.info(`[SyncHandlers] Already connected devices: ${devices.length}`);

    // Also emit device-connected for any already-connected devices
    // This handles the race condition where device was detected before
    // the renderer set up its event listeners
    for (const device of devices) {
      log.info(`[SyncHandlers] Re-emitting device-connected for: ${device.name}`);
      sendToRenderer("sync:device-connected", device);
    }

    return { success: true, devices };
  });

  // Stop device detection polling
  ipcMain.handle("sync:stop-detection", () => {
    log.info("[SyncHandlers] Stopping device detection");
    orchestrator?.stopDeviceDetection();
    return { success: true };
  });

  // TASK-2121: Get last sync time for an iPhone device from Supabase
  ipcMain.handle("sync:get-iphone-last-sync-time", async (_, udid: string) => {
    const userId = await getCurrentUserIdForSync();
    if (!userId) return { lastSyncTime: null };

    try {
      const { data, error } = await supabaseService
        .getClient()
        .from("iphone_sync_devices")
        .select("last_sync_time")
        .eq("user_id", userId)
        .eq("device_udid", udid)
        .single();

      if (error && error.code !== "PGRST116") {
        log.warn("[SyncHandlers] Failed to get iPhone last sync time", { error: error.message });
      }
      return { lastSyncTime: data?.last_sync_time ?? null };
    } catch (err) {
      log.warn("[SyncHandlers] Error fetching iPhone last sync time", { err });
      return { lastSyncTime: null };
    }
  });

  log.info("[SyncHandlers] Registered sync IPC handlers");
}

/**
 * Set up event forwarding from orchestrator to renderer
 */
function setupEventForwarding(): void {
  if (!orchestrator) return;

  // Forward progress events
  orchestrator.on("progress", (progress: SyncProgress) => {
    sendToRenderer("sync:progress", progress);
  });

  // Forward phase changes
  orchestrator.on("phase", (phase: string) => {
    sendToRenderer("sync:phase", phase);
  });

  // Forward device events
  orchestrator.on("device-connected", (device: iOSDevice) => {
    log.info("[SyncHandlers] Device connected", {
      name: device.name,
      udid: device.udid,
    });
    // TASK-2121: Capture device name for Supabase persistence
    syncSessionDeviceName = device.name;
    sendToRenderer("sync:device-connected", device);
  });

  orchestrator.on("device-disconnected", (device: iOSDevice) => {
    log.info("[SyncHandlers] Device disconnected", {
      name: device.name,
      udid: device.udid,
    });
    sendToRenderer("sync:device-disconnected", device);
  });

  // Forward password required event
  orchestrator.on("password-required", () => {
    log.info("[SyncHandlers] Password required for encrypted backup");
    sendToRenderer("sync:password-required", {});
  });

  // Forward passcode waiting events (user needs to enter passcode on iPhone)
  orchestrator.on("waiting-for-passcode", () => {
    log.info("[SyncHandlers] Waiting for user to enter passcode on iPhone");
    sendToRenderer("sync:waiting-for-passcode", {});
  });

  orchestrator.on("passcode-entered", () => {
    log.info("[SyncHandlers] User entered passcode, backup starting");
    sendToRenderer("sync:passcode-entered", {});
  });

  // Forward error events
  // TASK-2276: Support enriched error payload with optional userError field.
  // The orchestrator may emit either a plain Error or an enriched object
  // { message: string, userError?: UserFacingError }. Forward the userError
  // to the renderer so the UI can display structured messages.
  orchestrator.on("error", (error: Error | { message: string; userError?: unknown }) => {
    const message = error instanceof Error ? error.message : error.message;
    const userError = error instanceof Error ? undefined : (error as { userError?: unknown }).userError;
    log.error("[SyncHandlers] Sync error event", { error: message, hasUserError: !!userError });
    sendToRenderer("sync:error", { message, ...(userError ? { userError } : {}) });
  });

  // Forward completion events and persist data
  orchestrator.on("complete", async (result: SyncResult) => {
    log.info("[SyncHandlers] Sync complete", {
      conversations: result.conversations.length,
      messages: result.messages.length,
    });

    // Send completion to renderer with counts only (NOT the full message/contact arrays)
    // Sending 627k messages over IPC would freeze the renderer
    sendToRenderer("sync:complete", {
      success: result.success,
      error: result.error,
      messageCount: result.messages.length,
      contactCount: result.contacts.length,
      conversationCount: result.conversations.length,
    });

    // Use the user ID captured at sync start (not current) to prevent race conditions
    const userIdForPersistence = syncSessionUserId;
    syncSessionUserId = null; // Clear session user ID after capturing

    // Persist to database if we have a user ID
    if (userIdForPersistence && result.success) {
      // TASK-2110: Reset cancel signal for this persistence run
      persistCancelSignal.cancelled = false;

      log.info("[SyncHandlers] Starting database persistence for user", {
        userId: redactId(userIdForPersistence),
        sessionId: result.sessionId || "none",
      });
      sendToRenderer("sync:progress", {
        phase: "storing",
        percent: 0,
        message: "Saving messages to database...",
      });

      try {
        const persistResult = await iPhoneSyncStorageService.persistSyncResult(
          userIdForPersistence,
          result,
          result.backupPath, // SPRINT-068: Pass backup path for attachment extraction
          (progress) => {
            const message =
              progress.phase === "messages"
                ? `Saving messages... ${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`
                : progress.phase === "attachments"
                ? `Saving attachments... ${progress.current} of ${progress.total}`
                : `Saving contacts... ${progress.current} of ${progress.total}`;
            sendToRenderer("sync:progress", {
              phase: "storing",
              percent: progress.percent,
              message,
            });
          },
          result.sessionId,      // TASK-2110: Session ID for rollback tagging
          persistCancelSignal    // TASK-2110: Cancel signal for early abort
        );

        // TASK-2110: Handle cancelled persistence (rollback already done by storage service)
        if (!persistResult.success && persistCancelSignal.cancelled) {
          log.info("[SyncHandlers] Database persistence cancelled and rolled back", {
            duration: persistResult.duration,
          });
          sendToRenderer("sync:storage-error", {
            error: "Sync cancelled — partial data has been cleaned up.",
          });
          // Still cleanup backup
          if (result.needsCleanup && result.backupPath && orchestrator) {
            await orchestrator.cleanupBackup(result.backupPath);
          }
          return;
        }

        log.info("[SyncHandlers] Database persistence complete", {
          messagesStored: persistResult.messagesStored,
          messagesSkipped: persistResult.messagesSkipped,
          contactsStored: persistResult.contactsStored,
          contactsSkipped: persistResult.contactsSkipped,
          attachmentsStored: persistResult.attachmentsStored,
          attachmentsSkipped: persistResult.attachmentsSkipped,
          duration: persistResult.duration,
        });

        // SPRINT-068: Cleanup backup after persistence is complete
        if (result.needsCleanup && result.backupPath && orchestrator) {
          await orchestrator.cleanupBackup(result.backupPath);
        }

        // Send final completion with storage results
        log.info("[SyncHandlers] Sending sync:storage-complete to renderer");
        sendToRenderer("sync:storage-complete", {
          messagesStored: persistResult.messagesStored,
          contactsStored: persistResult.contactsStored,
          attachmentsStored: persistResult.attachmentsStored,
          duration: persistResult.duration,
        });
        log.info("[SyncHandlers] sync:storage-complete sent successfully");

        // BACKLOG-1546: Auto-link newly synced messages to transactions.
        // Fire-and-forget — don't block the sync completion response.
        if (persistResult.messagesStored > 0 && userIdForPersistence) {
          const expandUserId = userIdForPersistence;
          autoLinkNewMessagesForUser(expandUserId)
            .catch((autoLinkError) => {
              log.warn("[SyncHandlers] Post-sync auto-link failed", {
                error: autoLinkError instanceof Error ? autoLinkError.message : "Unknown",
              });
            })
            // BACKLOG-2285: After auto-link, expand attached conversations so
            // backfilled/older synced messages are picked up in attached threads.
            .finally(() => {
              expandAttachedThreadsForUser(expandUserId).catch((expandError) => {
                log.warn("[SyncHandlers] Post-sync attached-thread expansion failed", {
                  error: expandError instanceof Error ? expandError.message : "Unknown",
                });
              });
            });
        }

        // TASK-2121: Fire-and-forget upsert of lastSyncTime to Supabase
        const deviceUdid = syncSessionDeviceUdid;
        const deviceName = syncSessionDeviceName;
        syncSessionDeviceUdid = null;
        syncSessionDeviceName = null;
        if (userIdForPersistence && deviceUdid) {
          void (async () => {
            try {
              const { error: upsertError } = await supabaseService
                .getClient()
                .from("iphone_sync_devices")
                .upsert({
                  user_id: userIdForPersistence,
                  device_udid: deviceUdid,
                  device_name: deviceName ?? null,
                  last_sync_time: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                }, { onConflict: "user_id,device_udid" });

              if (upsertError) log.warn("[SyncHandlers] Failed to persist iPhone lastSyncTime", { error: upsertError.message });
              else log.info("[SyncHandlers] iPhone lastSyncTime persisted to Supabase");
            } catch (err) {
              log.warn("[SyncHandlers] Error persisting iPhone lastSyncTime", { err });
            }
          })();
        }
      } catch (error) {
        log.error("[SyncHandlers] Database persistence failed", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        sendToRenderer("sync:storage-error", {
          error: error instanceof Error ? error.message : "Failed to save messages",
        });
        // SPRINT-068: Still cleanup backup even if persistence fails
        if (result.needsCleanup && result.backupPath && orchestrator) {
          await orchestrator.cleanupBackup(result.backupPath);
        }
      }
    } else if (!userIdForPersistence) {
      // BACKLOG-1630: This should never be reached now that sync:start blocks without a user ID,
      // but kept as a safety net. Alert via Sentry if it somehow fires.
      log.error("[SyncHandlers] No user ID available (was not set at sync start), skipping database persistence");
      Sentry.captureMessage("Sync completed but no user ID for persistence (data loss)", {
        level: "error",
        tags: { component: "sync", operation: "sync:complete", severity: "data_loss" },
        extra: {
          messageCount: result.messages.length,
          contactCount: result.contacts.length,
          conversationCount: result.conversations.length,
        },
      });
    }
  });
}

/**
 * Set the current user ID for database persistence
 * Call this after user logs in
 */
export function setSyncUserId(userId: string | null): void {
  currentUserId = userId;
  log.info("[SyncHandlers] User ID set for sync persistence", { userId: userId ? "set" : "cleared" });
}

/**
 * Cleanup sync handlers
 */
export function cleanupSyncHandlers(): void {
  if (orchestrator) {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  }
  orchestrator = null;
  mainWindowRef = null;
  currentUserId = null;
  syncSessionUserId = null;
  syncSessionDeviceUdid = null;
  syncSessionDeviceName = null;
  persistCancelSignal.cancelled = false;

  // Remove IPC handlers
  ipcMain.removeHandler("sync:start");
  ipcMain.removeHandler("sync:cancel");
  ipcMain.removeHandler("sync:reset");
  ipcMain.removeHandler("sync:status");
  ipcMain.removeHandler("sync:getUnifiedStatus");
  ipcMain.removeHandler("sync:process-existing");
  ipcMain.removeHandler("sync:devices");
  ipcMain.removeHandler("sync:start-detection");
  ipcMain.removeHandler("sync:stop-detection");
  ipcMain.removeHandler("sync:get-iphone-last-sync-time");

  log.info("[SyncHandlers] Cleaned up sync handlers");
}
