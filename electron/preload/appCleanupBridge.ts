/**
 * App Cleanup Bridge
 * BACKLOG-2111: App-data cleanup engine + detached uninstall helper.
 * BACKLOG-2112: threads an optional `{ reason?: string }` payload so the
 * Troubleshooting UI can record WHY the user reset/uninstalled (lifecycle
 * logging, BACKLOG-2113).
 *
 * Exposes the cleanup engine to the renderer. The UI (BACKLOG-2112) builds a
 * confirmation flow on top of these two methods.
 */

import { ipcRenderer } from "electron";

/** Result of a cleanup operation (mirrors CleanupResult in appCleanupService). */
export interface AppCleanupResult {
  /** True if the wipe was initiated (helper spawned, app exiting). */
  success: boolean;
  /** The mode that was requested. */
  mode: "reset" | "uninstall";
  /** Absolute paths handed to the detached helper for deletion. */
  removedPaths?: string[];
  /**
   * True when uninstall was requested but app removal was skipped because the
   * install location failed sanity checks. App data is still wiped.
   */
  appRemovalSkipped?: boolean;
  /** Error message if cleanup could not be initiated (e.g. dev build). */
  error?: string;
}

/** Optional payload accepted by both cleanup modes (BACKLOG-2112). */
export interface AppCleanupOptions {
  /**
   * Free-text reason the user is resetting/uninstalling. Forwarded to the
   * lifecycle-logging seam (BACKLOG-2113) BEFORE any wipe. Optional.
   */
  reason?: string;
}

export const appCleanupBridge = {
  /**
   * Wipe all local app data + OS secrets, then relaunch into onboarding.
   * WARNING: destructive. Cloud data (Supabase) is NOT affected.
   *
   * @param options optional `{ reason?: string }` recorded pre-wipe.
   */
  reset: (options?: AppCleanupOptions): Promise<AppCleanupResult> =>
    ipcRenderer.invoke("app-cleanup:reset", options),

  /**
   * Wipe all local app data + OS secrets AND remove the application itself,
   * then quit. WARNING: destructive. Cloud data (Supabase) is NOT affected.
   *
   * @param options optional `{ reason?: string }` recorded pre-wipe.
   */
  uninstall: (options?: AppCleanupOptions): Promise<AppCleanupResult> =>
    ipcRenderer.invoke("app-cleanup:uninstall", options),
};
