/**
 * App Cleanup Service (BACKLOG-2112)
 *
 * Renderer-side abstraction over `window.api.appCleanup`. Components never call
 * `window.api` directly (repo rule) — the Troubleshooting settings section uses
 * this wrapper for the two destructive cleanup modes:
 *   - reset:     wipe local app data + OS secrets, relaunch into onboarding.
 *   - uninstall: wipe local app data + OS secrets AND remove the app, then quit.
 *
 * On success the engine (main process) quits/relaunches the app, so the returned
 * promise typically never resolves in practice — callers should show a
 * "closing" state optimistically. On failure (notably the dev-build refusal) a
 * typed result is returned with `success: false` and an `error` string.
 *
 * Cloud data (Supabase) is NOT affected by these operations.
 */

import { getErrorMessage } from "./index";

/** Result of a cleanup operation (mirrors CleanupResult in appCleanupService.ts). */
export interface CleanupResult {
  /** True if the wipe was initiated (helper spawned, app quitting). */
  success: boolean;
  /** The mode that was requested. */
  mode: "reset" | "uninstall";
  /** Absolute paths handed to the detached helper for deletion. */
  removedPaths?: string[];
  /** Error message if cleanup could not be initiated (e.g. dev build). */
  error?: string;
}

/**
 * App Cleanup Service.
 * Provides a clean abstraction over `window.api.appCleanup`.
 */
export const appCleanupService = {
  /**
   * Wipe all local app data + OS secrets, then relaunch into onboarding.
   * WARNING: destructive.
   *
   * @param reason optional free-text reason recorded to the lifecycle log
   *   BEFORE the wipe (best-effort).
   */
  async reset(reason?: string): Promise<CleanupResult> {
    try {
      return await window.api.appCleanup.reset({ reason });
    } catch (error) {
      return { success: false, mode: "reset", error: getErrorMessage(error) };
    }
  },

  /**
   * Wipe all local app data + OS secrets AND remove the application itself,
   * then quit. WARNING: destructive.
   *
   * @param reason optional free-text reason recorded to the lifecycle log
   *   BEFORE the wipe (best-effort).
   */
  async uninstall(reason?: string): Promise<CleanupResult> {
    try {
      return await window.api.appCleanup.uninstall({ reason });
    } catch (error) {
      return {
        success: false,
        mode: "uninstall",
        error: getErrorMessage(error),
      };
    }
  },
};

export default appCleanupService;
