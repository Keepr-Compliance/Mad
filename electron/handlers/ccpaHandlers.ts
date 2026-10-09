/**
 * CCPA Data Export Handlers
 * TASK-2053: IPC handlers for CCPA personal data export
 *
 * Provides the `privacy:export-data` channel for the renderer to
 * trigger a full personal data export to a JSON file.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import { exportUserData, writeExportFile } from "../services/ccpaExportService";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";
import {
  getCrashReportingState,
  setCrashReportingEnabled,
  type CrashReportingState,
} from "../services/crashReportingPreference";

/**
 * Register CCPA/privacy IPC handlers
 */
export function registerCcpaHandlers(): void {
  /**
   * Export all personal data for the current user as a JSON file.
   *
   * Flow:
   * 1. Renderer sends userId
   * 2. Show save dialog with default filename
   * 3. Gather all data categories with progress reporting
   * 4. Write JSON file
   * 5. Return success/failure
   */
  ipcMain.handle(
    "privacy:export-data",
    wrapHandler(async (event, userId: string): Promise<{ success: boolean; filePath?: string; error?: string }> => {
      logService.info(
        "[CcpaHandlers] Export requested",
        "CcpaHandlers",
      );

      if (!userId) {
        return { success: false, error: "User ID is required" };
      }

      // Get the BrowserWindow that sent the request
      const win = BrowserWindow.fromWebContents(event.sender);

      // Show save dialog
      const dateStr = new Date().toISOString().split("T")[0];
      const defaultFilename = `keepr-data-export-${dateStr}.json`;

      const dialogResult = await dialog.showSaveDialog(
        win || BrowserWindow.getFocusedWindow()!,
        {
          title: "Export Your Data (CCPA)",
          defaultPath: defaultFilename,
          filters: [{ name: "JSON Files", extensions: ["json"] }],
        },
      );

      if (dialogResult.canceled || !dialogResult.filePath) {
        return { success: false, error: "Export cancelled by user" };
      }

      const filePath = dialogResult.filePath;

      // Gather data with progress reporting
      const data = await exportUserData(userId, (category, progress) => {
        // Send progress to renderer
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send("privacy:export-progress", {
            category,
            progress,
          });
        }
      });

      // Write the file
      await writeExportFile(data, filePath);

      logService.info(
        `[CcpaHandlers] Export complete: ${filePath}`,
        "CcpaHandlers",
      );

      return { success: true, filePath };
    }, { module: "CcpaHandlers" }),
  );

  /**
   * BACKLOG-3801: the "Send crash reports" switch in Settings → Data & Privacy.
   * Turning it off stops all Sentry sending immediately; turning it on after a
   * launch that started off takes effect on the next launch.
   */
  ipcMain.handle(
    "privacy:get-crash-reporting",
    wrapHandler(async (): Promise<{ success: boolean } & Partial<CrashReportingState>> => {
      return { success: true, ...getCrashReportingState() };
    }, { module: "CcpaHandlers" }),
  );

  ipcMain.handle(
    "privacy:set-crash-reporting",
    wrapHandler(async (_event, enabled: unknown): Promise<{ success: boolean; error?: string } & Partial<CrashReportingState>> => {
      if (typeof enabled !== "boolean") {
        return { success: false, error: "enabled must be a boolean" };
      }
      try {
        const state = setCrashReportingEnabled(enabled);
        logService.info(`[CcpaHandlers] Crash reporting set to ${enabled ? "on" : "off"}`, "CcpaHandlers");
        return { success: true, ...state };
      } catch (err) {
        logService.error("[CcpaHandlers] Failed to save crash reporting choice", "CcpaHandlers", { error: err instanceof Error ? err.message : String(err) });
        return { success: false, error: "Could not save the setting", ...getCrashReportingState() };
      }
    }, { module: "CcpaHandlers" }),
  );

  logService.debug("[CcpaHandlers] Handlers registered", "CcpaHandlers");
}
