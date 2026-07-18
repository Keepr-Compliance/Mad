/**
 * App Cleanup IPC Handlers
 * BACKLOG-2111: App-data cleanup engine + detached uninstall helper.
 * BACKLOG-2112: accept an optional `{ reason?: string }` payload and inject the
 *   matching BACKLOG-2113 lifecycle log call as the `beforeWipe` seam, so the
 *   event is recorded to Supabase BEFORE the wipe (best-effort, timeout-guarded
 *   inside the engine — logging can never block a wipe).
 *
 * Exposes the two cleanup modes to the renderer:
 *   - app-cleanup:reset     — wipe app data + secrets, relaunch into onboarding.
 *   - app-cleanup:uninstall — wipe app data + secrets + remove the app itself.
 *
 * Both delegate to appCleanupService.runCleanup(), which enforces the
 * !app.isPackaged safety rail and owns the enumeration/secret-clearing/detached
 * helper flow.
 */

import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { runCleanup, type CleanupResult } from "../services/appCleanupService";
import {
  logResetEvent,
  logUninstallEvent,
} from "../services/lifecycleEventService";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";

const MODULE = "AppCleanupHandlers";

/** Optional payload accepted by both cleanup channels (BACKLOG-2112). */
export interface AppCleanupHandlerOptions {
  /** Free-text reason recorded to the lifecycle log before the wipe. */
  reason?: string;
}

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
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        options?: AppCleanupHandlerOptions,
      ): Promise<CleanupResult> => {
        logService.warn("[AppCleanup] Reset requested from renderer", MODULE, {
          hasReason: options?.reason !== undefined,
        });
        return runCleanup({
          mode: "reset",
          beforeWipe: () => logResetEvent(options?.reason),
        });
      },
      { module: MODULE },
    ),
  );

  /**
   * Uninstall: wipe all local app data + secrets AND remove the application
   * bundle/install directory, then quit. Cloud data (Supabase) is NOT affected.
   */
  ipcMain.handle(
    "app-cleanup:uninstall",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        options?: AppCleanupHandlerOptions,
      ): Promise<CleanupResult> => {
        logService.warn(
          "[AppCleanup] Uninstall requested from renderer",
          MODULE,
          { hasReason: options?.reason !== undefined },
        );
        return runCleanup({
          mode: "uninstall",
          beforeWipe: () => logUninstallEvent(options?.reason),
        });
      },
      { module: MODULE },
    ),
  );

  logService.debug("[AppCleanup] Handlers registered", MODULE);
}
