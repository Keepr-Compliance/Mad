/**
 * App Cleanup Bridge
 * BACKLOG-2111: App-data cleanup engine + detached uninstall helper.
 *
 * Exposes the cleanup engine to the renderer. The UI task (BACKLOG-2114) builds
 * a confirmation flow on top of these two methods.
 */

import { ipcRenderer } from "electron";

/** Result of a cleanup operation (mirrors CleanupResult in appCleanupService). */
export interface AppCleanupResult {
  /** True if the wipe was initiated (helper spawned, app quitting). */
  success: boolean;
  /** The mode that was requested. */
  mode: "reset" | "uninstall";
  /** Absolute paths handed to the detached helper for deletion. */
  removedPaths?: string[];
  /** Error message if cleanup could not be initiated (e.g. dev build). */
  error?: string;
}

export const appCleanupBridge = {
  /**
   * Wipe all local app data + OS secrets, then relaunch into onboarding.
   * WARNING: destructive. Cloud data (Supabase) is NOT affected.
   */
  reset: (): Promise<AppCleanupResult> =>
    ipcRenderer.invoke("app-cleanup:reset"),

  /**
   * Wipe all local app data + OS secrets AND remove the application itself,
   * then quit. WARNING: destructive. Cloud data (Supabase) is NOT affected.
   */
  uninstall: (): Promise<AppCleanupResult> =>
    ipcRenderer.invoke("app-cleanup:uninstall"),
};
