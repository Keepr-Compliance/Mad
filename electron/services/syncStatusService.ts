/**
 * Sync Status Service
 *
 * Provides a unified view of all sync/backup operations.
 * Used by the UI to prevent users from triggering multiple
 * concurrent sync operations.
 *
 * TASK-904: Created to expose backup/sync state to the renderer.
 */

import { backupService } from "./backupService";
import { deviceSyncOrchestrator, SyncPhase } from "./deviceSyncOrchestrator";
import type { BackupStatus } from "../types/backup";

/**
 * Unified sync status returned to the UI
 */
export interface SyncStatus {
  /** True if any backup/sync operation is currently running */
  isAnyOperationRunning: boolean;
  /** True if an iPhone backup is in progress */
  backupInProgress: boolean;
  /** True if email/message sync is in progress (not backup) */
  emailSyncInProgress: boolean;
  /** Human-readable label for the current operation, or null if idle */
  currentOperation: string | null;
  /** Current sync phase from orchestrator */
  syncPhase: SyncPhase;
}

/**
 * SyncStatusService - Aggregates status from all sync-related services
 *
 * This service provides a single source of truth for the UI to check
 * whether any sync operation is running, preventing users from
 * triggering overlapping operations.
 *
 * @example
 * ```typescript
 * const status = syncStatusService.getStatus();
 * if (status.isAnyOperationRunning) {
 *   console.log('Busy:', status.currentOperation);
 * }
 * ```
 */
class SyncStatusService {
  /**
   * Get the current unified sync status
   *
   * Aggregates status from:
   * - BackupService (iPhone backup via idevicebackup2)
   * - DeviceSyncOrchestrator (complete sync flow including parsing)
   *
   * @returns Current sync status
   */
  getStatus(): SyncStatus {
    const backupStatus: BackupStatus = backupService.getStatus();
    const orchestratorStatus = deviceSyncOrchestrator.getStatus();
    const orchestratorRunning = orchestratorStatus.isRunning;

    return {
      isAnyOperationRunning: backupStatus.isRunning || orchestratorRunning,
      backupInProgress: backupStatus.isRunning,
      emailSyncInProgress: orchestratorRunning && !backupStatus.isRunning,
      currentOperation: orchestratorStatus.removingUnfinishedBackup
        ? // BACKLOG-3598 (SR I2): a failed or stopped backup's folder is being removed.
          "Cleaning up the unfinished backup"
        : this.getCurrentOperationLabel(
            backupStatus,
            orchestratorRunning,
            orchestratorStatus.phase
          ),
      syncPhase: orchestratorStatus.phase,
    };
  }

  /**
   * Get a human-readable label for the current operation
   *
   * @param backupStatus - Current backup service status
   * @param orchestratorRunning - Whether orchestrator is running
   * @param phase - Current sync phase
   * @returns Human-readable operation label or null if idle
   */
  private getCurrentOperationLabel(
    backupStatus: BackupStatus,
    orchestratorRunning: boolean,
    phase: SyncPhase
  ): string | null {
    if (backupStatus.isRunning) {
      return "iPhone backup in progress";
    }

    if (orchestratorRunning) {
      // Map phase to user-friendly message
      switch (phase) {
        case "backup":
          return "iPhone backup in progress";
        case "decrypting":
          return "Decrypting backup data";
        case "parsing-contacts":
          return "Parsing contacts";
        case "parsing-messages":
          return "Parsing messages";
        case "resolving":
          return "Resolving contact names";
        case "cleanup":
          return "Cleaning up";
        case "complete":
          return null; // Operation finished
        case "error":
          return null; // Let UI handle error state
        default:
          return "Sync in progress";
      }
    }

    return null;
  }
}

export const syncStatusService = new SyncStatusService();
