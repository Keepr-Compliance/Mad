/**
 * Backup/Restore Handlers
 * TASK-2052: IPC handlers for SQLite database backup and restore operations
 *
 * Channels:
 * - db:backup       - Create a backup of the database
 * - db:restore      - Restore the database from a backup file
 * - db:get-backup-info - Get database file size and last modified date
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import logService from "../services/logService";
import {
  backupDatabase,
  restoreDatabase,
  getDatabaseInfo,
  generateBackupFilename,
} from "../services/sqliteBackupService";
import { wrapHandler } from "../utils/wrapHandler";

/**
 * Register backup/restore IPC handlers
 */
export function registerBackupRestoreHandlers(): void {
  /**
   * Create a database backup
   * Shows a save dialog for the user to choose the destination
   */
  ipcMain.handle("db:backup", wrapHandler(async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    const defaultFilename = generateBackupFilename();

    const { filePath, canceled } = await dialog.showSaveDialog(
      focusedWindow || ({} as BrowserWindow),
      {
        title: "Save Database Backup",
        defaultPath: defaultFilename,
        filters: [
          { name: "Database Backup", extensions: ["db"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      }
    );

    if (canceled || !filePath) {
      return { success: false, cancelled: true };
    }

    const result = await backupDatabase(filePath);
    return result;
  }, { module: "BackupRestoreHandlers" }));

  /**
   * Restore the database from a backup file
   * Shows an open dialog, then a confirmation dialog before restoring
   */
  ipcMain.handle("db:restore", wrapHandler(async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    // Step 1: Show open dialog to select backup file
    const { filePaths, canceled } = await dialog.showOpenDialog(
      focusedWindow || ({} as BrowserWindow),
      {
        title: "Select Database Backup",
        filters: [
          { name: "Database Backup", extensions: ["db"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      }
    );

    if (canceled || filePaths.length === 0) {
      return { success: false, cancelled: true };
    }

    const backupPath = filePaths[0];

    // Step 2: Show confirmation dialog
    const { response } = await dialog.showMessageBox(
      focusedWindow || ({} as BrowserWindow),
      {
        type: "warning",
        title: "Restore Database",
        message: "Are you sure you want to restore from this backup?",
        detail:
          "This will replace your current database with the backup. " +
          "All data added since the backup was created will be lost. " +
          "A copy of your current data will be kept until your next restore.",
        buttons: ["Cancel", "Restore"],
        defaultId: 0,
        cancelId: 0,
      }
    );

    // response 0 = Cancel, response 1 = Restore
    if (response !== 1) {
      return { success: false, cancelled: true };
    }

    // Step 3: Perform the restore
    const result = await restoreDatabase(backupPath);
    return result;
  }, { module: "BackupRestoreHandlers" }));

  /**
   * Get database file info (size, last modified date)
   * Used to display database info in the Settings UI
   */
  ipcMain.handle("db:get-backup-info", wrapHandler(async () => {
    const info = await getDatabaseInfo();
    return {
      success: true,
      info,
    };
  }, { module: "BackupRestoreHandlers" }));

  logService.debug(
    "[BackupRestoreHandlers] Handlers registered",
    "BackupRestoreHandlers"
  );
}
