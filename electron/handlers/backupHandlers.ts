/**
 * Backup IPC Handlers
 *
 * Handles IPC communication between the renderer process and the backup service.
 * Provides backup operations for iPhone data extraction.
 * Includes encrypted backup support (TASK-007).
 */

import { ipcMain, app } from "electron";
import log from "electron-log";
import { backupService } from "../services/backupService";
import { backupDecryptionService } from "../services/backupDecryptionService";
import { BackupOptions, BackupProgress } from "../types/backup";
import { rateLimiters } from "../utils/rateLimit";
import { toPriorBackupState } from "../services/deviceSyncOrchestrator";

import { sendToMainWindow } from "../windowRegistry";

/**
 * Register all backup-related IPC handlers
 */
export function registerBackupHandlers(): void {
  log.info("[BackupHandlers] Registering backup handlers");

  // Forward progress events to renderer
  backupService.on("progress", (progress: BackupProgress) => {
    sendToMainWindow("backup:progress", progress);
  });

  // Forward completion events to renderer
  backupService.on("complete", (result) => {
    sendToMainWindow("backup:complete", result);
  });

  // Forward error events to renderer
  backupService.on("error", (error: Error) => {
    log.error("[BackupHandlers] Backup error:", error);
    sendToMainWindow("backup:error", { message: error.message });
  });

  /**
   * Get backup capabilities
   * Returns information about what the backup system can do
   */
  ipcMain.handle("backup:capabilities", async () => {
    try {
      return await backupService.checkCapabilities();
    } catch (error) {
      log.error("[BackupHandlers] Error getting capabilities:", error);
      return {
        supportsDomainFiltering: false,
        supportsIncremental: true,
        supportsEncryption: true,
        availableDomains: [],
      };
    }
  });

  /**
   * Get current backup status
   */
  ipcMain.handle("backup:status", () => {
    return backupService.getStatus();
  });

  /**
   * Check backup status for a specific device (returns last sync time, size, etc.)
   * @param udid Device UDID
   */
  ipcMain.handle("backup:check-status", async (_, udid: string) => {
    log.info("[BackupHandlers] Checking backup status for device:", udid);

    try {
      if (!udid) {
        throw new Error("Device UDID is required");
      }

      // BACKLOG-2931: the connect screen calls this on every device connect. Read the
      // recorded size (walk and record only when there is none), as the sync's own check
      // does — without it each connect walked the whole backup (BACKLOG-3816: ~135 s on
      // a large one). `isComplete` comes from the index files, not the size, so the
      // answer below is the same either way; only the latency changes.
      const status = await backupService.checkBackupStatus(udid, { useRecordedSize: true });

      // BACKLOG-2931: the SAME usability mapping the sync records (BACKLOG-2907/2938),
      // so the connect screen's sentence and the progress banner cannot disagree.
      const priorBackup = toPriorBackupState(status);

      // BACKLOG-2917: the IPC boundary repeated the collapse it was handed. A failed
      // check and a genuinely absent backup both returned `exists: false`, so even a
      // correct three-state value in the main process would have arrived in the
      // renderer as two. `state` crosses the boundary intact.
      //
      // Renderer caller: useIPhoneSync (BACKLOG-2931), on device connect and after a
      // sync completes.
      if (status.state === "unknown") {
        return {
          success: true,
          state: "unknown" as const,
          reason: status.reason,
          lastSyncTime: null,
          priorBackup,
        };
      }

      if (status.state === "absent") {
        return {
          success: true,
          state: "absent" as const,
          lastSyncTime: null,
          priorBackup,
        };
      }

      return {
        success: true,
        state: "present" as const,
        priorBackup,
        isComplete: status.isComplete,
        // BACKLOG-2911: the device did not report the snapshot as finished.
        isInterrupted: status.isInterrupted,
        lastSyncTime: status.lastModified.toISOString(),
        // BACKLOG-2917: `null` means the size could not be measured. It is NOT 0.
        sizeBytes: status.size.measured ? status.size.bytes : null,
      };
    } catch (error) {
      log.error("[BackupHandlers] Error checking backup status:", error);
      return {
        success: false,
        error: (error as Error).message,
        // BACKLOG-2931: nothing was established; the connect screen claims neither.
        priorBackup: "unknown" as const,
      };
    }
  });

  /**
   * Check if a device requires encrypted backup (TASK-007)
   * @param udid Device UDID
   */
  ipcMain.handle("backup:check-encryption", async (_, udid: string) => {
    log.info("[BackupHandlers] Checking encryption status for device:", udid);

    try {
      if (!udid) {
        throw new Error("Device UDID is required");
      }

      const encryptionInfo = await backupService.checkEncryptionStatus(udid);

      return {
        success: true,
        isEncrypted: encryptionInfo.isEncrypted,
        needsPassword: encryptionInfo.needsPassword,
      };
    } catch (error) {
      log.error("[BackupHandlers] Error checking encryption:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Start a backup operation
   * @param options BackupOptions with device UDID and optional settings
   *
   * Rate limited: 30 second cooldown per device to prevent backup spam.
   * Backups are very expensive operations (full device backup, can take hours).
   */
  ipcMain.handle("backup:start", async (_, options: BackupOptions) => {
    log.info("[BackupHandlers] Starting backup for device:", options.udid);

    try {
      // Validate options
      if (!options.udid) {
        throw new Error("Device UDID is required");
      }

      // Rate limit check - 30 second cooldown per device
      const { allowed, remainingMs } = rateLimiters.backup.canExecute(
        "backup:start",
        options.udid
      );
      if (!allowed && remainingMs !== undefined) {
        const seconds = Math.ceil(remainingMs / 1000);
        log.warn(
          `[BackupHandlers] Rate limited backup:start for device ${options.udid}. ` +
            `Retry in ${seconds}s`
        );
        return {
          success: false,
          backupPath: null,
          error: `Please wait ${seconds} seconds before starting another backup.`,
          duration: 0,
          deviceUdid: options.udid,
          isIncremental: false,
          backupSize: 0,
          rateLimited: true,
        };
      }

      const result = await backupService.startBackup(options);

      log.info("[BackupHandlers] Backup completed:", {
        success: result.success,
        duration: result.duration,
        size: result.backupSize,
        isIncremental: result.isIncremental,
        isEncrypted: result.isEncrypted,
      });

      return result;
    } catch (error) {
      log.error("[BackupHandlers] Backup failed:", error);
      return {
        success: false,
        backupPath: null,
        error: (error as Error).message,
        duration: 0,
        deviceUdid: options.udid,
        isIncremental: false,
        backupSize: 0,
      };
    }
  });

  /**
   * Check if an existing backup is encrypted (TASK-007)
   */
  ipcMain.handle("backup:is-encrypted", async (_, backupPath: string) => {
    log.info("[BackupHandlers] Checking if backup is encrypted:", backupPath);

    try {
      if (!backupPath) {
        throw new Error("Backup path is required");
      }

      const isEncrypted =
        await backupDecryptionService.isBackupEncrypted(backupPath);

      return {
        success: true,
        isEncrypted,
      };
    } catch (error) {
      log.error("[BackupHandlers] Encryption check failed:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Cancel an in-progress backup
   */
  ipcMain.handle("backup:cancel", () => {
    log.info("[BackupHandlers] Cancelling backup");
    backupService.cancelBackup();
    return { success: true };
  });

  /**
   * List all existing backups
   */
  ipcMain.handle("backup:list", async () => {
    try {
      return await backupService.listBackups();
    } catch (error) {
      log.error("[BackupHandlers] Error listing backups:", error);
      return [];
    }
  });

  /**
   * Delete a specific backup
   * @param backupPath Path to the backup to delete
   */
  ipcMain.handle("backup:delete", async (_, backupPath: string) => {
    log.info("[BackupHandlers] Deleting backup:", backupPath);

    try {
      await backupService.deleteBackup(backupPath);
      return { success: true };
    } catch (error) {
      log.error("[BackupHandlers] Error deleting backup:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Clean up old backups
   * @param keepCount Number of backups to keep per device
   */
  ipcMain.handle("backup:cleanup", async (_, keepCount: number = 1) => {
    log.info("[BackupHandlers] Cleaning up old backups, keeping:", keepCount);

    try {
      await backupService.cleanupOldBackups(keepCount);
      return { success: true };
    } catch (error) {
      log.error("[BackupHandlers] Error cleaning up backups:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Clean up decrypted files after extraction (TASK-007)
   */
  ipcMain.handle("backup:cleanup-decrypted", async (_, backupPath: string) => {
    log.info("[BackupHandlers] Cleaning up decrypted files:", backupPath);

    try {
      await backupService.cleanupDecryptedFiles(backupPath);
      return { success: true };
    } catch (error) {
      log.error("[BackupHandlers] Error cleaning up decrypted files:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Clean up running backup on app quit
  app.on("before-quit", () => {
    const status = backupService.getStatus();
    if (status.isRunning) {
      log.info("[BackupHandlers] App quitting, cancelling running backup");
      backupService.cancelBackup();
    }
  });

  log.info("[BackupHandlers] Backup handlers registered");
}

/**
 * Export the backup service for direct access if needed
 */
export { backupService };
