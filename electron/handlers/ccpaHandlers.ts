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
import { handleBusy } from "../utils/busyIpc";
import auditService from "../services/auditService";
import databaseService from "../services/databaseService";
import sessionService from "../services/sessionService";
import { dbTransaction } from "../services/db/core/dbConnection";
import { resolveAttachmentAuditUserId } from "../services/db/attachmentOpenSql";
import { isAuditNotRecorded } from "../services/dealChangeAudit";

/**
 * BACKLOG-3339: shown when the data file was saved but the export could not
 * be recorded in the audit log. The renderer shows it under the button and in
 * the toast, without the "Failed to export data:" prefix.
 */
export const DATA_EXPORT_NOT_RECORDED_MESSAGE =
  "Your data file was saved, but this export could not be recorded in the audit log. If this keeps happening, contact support.";

/** The renderer asked for an account that is not the signed-in one. */
export const DATA_EXPORT_WRONG_ACCOUNT_MESSAGE =
  "Your data could not be exported because the signed-in account could not be confirmed. Sign in again and retry.";

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
   * 5. Write the audit entry (BACKLOG-3339)
   * 6. Return success/failure
   *
   * The account is the SESSION user, confirmed present locally. The renderer's
   * id is only checked against it: an export (and its audit entry) is never
   * attributed to an id the renderer supplies.
   */
  handleBusy(
    "privacy:export-data",
    wrapHandler(async (event, userId: string): Promise<{ success: boolean; filePath?: string; error?: string; notRecorded?: boolean }> => {
      logService.info(
        "[CcpaHandlers] Export requested",
        "CcpaHandlers",
      );

      if (!userId) {
        return { success: false, error: "User ID is required" };
      }

      const session = await sessionService.loadSession().catch(() => null);
      const sessionUserId = resolveAttachmentAuditUserId(
        databaseService.getRawDatabase(),
        session?.user?.id,
      );
      if (!sessionUserId || sessionUserId !== userId) {
        logService.warn(
          "[CcpaHandlers] Export refused: requested account is not the signed-in account",
          "CcpaHandlers",
        );
        return { success: false, error: DATA_EXPORT_WRONG_ACCOUNT_MESSAGE };
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
      const data = await exportUserData(sessionUserId, (category, progress) => {
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

      // BACKLOG-3339: the audit entry, written so a failure can be reported
      // (`auditService.log` swallows its own). No file path in it: the path
      // holds the account name and the chosen file name, and it is synced.
      const auditEntry = {
        userId: sessionUserId,
        action: "DATA_EXPORT" as const,
        resourceType: "USER" as const,
        resourceId: sessionUserId,
        metadata: { format: "json" },
      };
      try {
        dbTransaction(() => {
          auditService.recordInTransaction(auditEntry);
        });
      } catch (err) {
        if (!isAuditNotRecorded(err)) throw err;
        auditService.recordFailure({ ...auditEntry, errorMessage: "audit_entry_not_written" });
        logService.error("[CcpaHandlers] Export saved but not recorded in the audit log", "CcpaHandlers");
        return { success: false, filePath, notRecorded: true, error: DATA_EXPORT_NOT_RECORDED_MESSAGE };
      }

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
