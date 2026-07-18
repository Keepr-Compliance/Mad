/**
 * App Cleanup IPC Handlers
 * BACKLOG-2111: App-data cleanup engine + detached uninstall helper.
 *
 * Exposes the two cleanup modes to the renderer:
 *   - app-cleanup:reset     — wipe app data + secrets, relaunch into onboarding.
 *   - app-cleanup:uninstall — wipe app data + secrets + remove the app itself.
 *
 * Both delegate to appCleanupService.runCleanup(), which enforces the
 * !app.isPackaged safety rail and owns the enumeration/secret-clearing/detached
 * helper flow.
 */

import { ipcMain } from "electron";
import { runCleanup, type CleanupResult } from "../services/appCleanupService";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";

const MODULE = "AppCleanupHandlers";

/**
 * Register app-cleanup IPC handlers.
 */
export function registerAppCleanupHandlers(): void {
  /**
   * Reset: wipe all local app data + secrets, then relaunch into onboarding.
   * Cloud data (Supabase) is NOT affected.
   */
  ipcMain.handle(
    "app-cleanup:reset",
    wrapHandler(async (): Promise<CleanupResult> => {
      logService.warn(
        "[AppCleanup] Reset requested from renderer",
        MODULE,
      );
      return runCleanup({ mode: "reset" });
    }, { module: MODULE }),
  );

  /**
   * Uninstall: wipe all local app data + secrets AND remove the application
   * bundle/install directory, then quit. Cloud data (Supabase) is NOT affected.
   */
  ipcMain.handle(
    "app-cleanup:uninstall",
    wrapHandler(async (): Promise<CleanupResult> => {
      logService.warn(
        "[AppCleanup] Uninstall requested from renderer",
        MODULE,
      );
      return runCleanup({ mode: "uninstall" });
    }, { module: MODULE }),
  );

  logService.debug("[AppCleanup] Handlers registered", MODULE);
}
