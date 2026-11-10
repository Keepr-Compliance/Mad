/**
 * Database Backup Bridge
 * TASK-2052: Preload bridge for SQLite database backup and restore operations
 *
 * NOTE: Named "databaseBackupBridge" (not "backupBridge") because "backupBridge"
 * is already used by iPhone backup in deviceBridge.ts.
 */

import { ipcRenderer } from "electron";

export const databaseBackupBridge = {
  /**
   * Create a backup of the local SQLite database
   * Opens a save dialog for the user to choose destination
   * @returns Backup result with file path and size on success
   */
  backup: () =>
    ipcRenderer.invoke("db:backup") as Promise<{
      success: boolean;
      cancelled?: boolean;
      filePath?: string;
      fileSize?: number;
      error?: string;
    }>,

  /**
   * Restore the database from a backup file
   * Opens a file picker, then shows confirmation before restoring
   * @returns Restore result
   */
  restore: () =>
    ipcRenderer.invoke("db:restore") as Promise<{
      success: boolean;
      cancelled?: boolean;
      error?: string;
      requiresRestart?: boolean;
      /** BACKLOG-3298: where the replaced data was kept (success only). */
      keptPreviousAs?: string;
    }>,

  /**
   * Get database file info (size, last modified date)
   * Used to display database info in the Settings UI
   * @returns Database info
   */
  getInfo: () =>
    ipcRenderer.invoke("db:get-backup-info") as Promise<{
      success: boolean;
      info?: {
        filePath: string;
        fileSize: number;
        lastModified: string;
      } | null;
      error?: string;
    }>,
};
