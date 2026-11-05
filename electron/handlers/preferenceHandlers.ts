// ============================================
// PREFERENCE IPC HANDLERS
// This file contains preference handlers to be added to main.js
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import supabaseService from "../services/supabaseService";
import logService from "../services/logService";
import failureLogService from "../services/failureLogService";
import { readPreferencesCopy } from "../services/preferencesMirror";
import {
  applyAutoDownload,
  autoDownloadFromPreferences,
  autoDownloadInPartial,
} from "../services/updateDownloadPolicy";

// Import validation utilities
import {
  ValidationError,
  validateUserId,
  sanitizeObject,
} from "../utils/validation";

// Type definitions
interface PreferenceResponse {
  success: boolean;
  error?: string;
  preferences?: Record<string, unknown>;
  /**
   * BACKLOG-2824, `preferences:get` only: "cloud" when read from Supabase,
   * "copy" when the cloud read failed and the local copy was served.
   */
  source?: "cloud" | "copy";
  /** BACKLOG-2824: when the served copy was taken from the cloud (source "copy" only). */
  copiedAt?: string;
}

/**
 * Register all preference-related IPC handlers
 */
export function registerPreferenceHandlers(): void {
  // Get user preferences
  ipcMain.handle(
    "preferences:get",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<PreferenceResponse> => {
      let validatedUserId: string | null = null;
      try {
        logService.debug("[Preferences] Getting preferences", "Preferences", { userId });

        // Validate input
        validatedUserId = validateUserId(userId)!;

        const preferences =
          (await supabaseService.getPreferences(validatedUserId)) ?? {};

        // BACKLOG-3469: the read value drives the updater (default on).
        applyAutoDownload(autoDownloadFromPreferences(preferences));

        return {
          success: true,
          preferences: preferences || {},
          source: "cloud",
        };
      } catch (error) {
        logService.error("[Preferences] Failed to get preferences:", "Preferences", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        // BACKLOG-2824: the cloud read failed (offline, most often). Serve the
        // last bag the cloud gave this user. With no copy, fail as before:
        // the BACKLOG-2890 / 2893 holds react to that failure.
        if (validatedUserId) {
          const copy = await readPreferencesCopy(validatedUserId);
          if (copy) {
            logService.warn(
              "[Preferences] Cloud read failed; serving the local copy of the preferences",
              "Preferences",
              { copiedAt: copy.copiedAt },
            );
            applyAutoDownload(autoDownloadFromPreferences(copy.preferences));
            return {
              success: true,
              preferences: copy.preferences,
              source: "copy",
              copiedAt: copy.copiedAt,
            };
          }
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Save user preferences
  ipcMain.handle(
    "preferences:save",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      preferences: unknown,
    ): Promise<PreferenceResponse> => {
      try {
        logService.info("[Preferences] Saving preferences", "Preferences", { userId });

        // Validate inputs
        const validatedUserId = validateUserId(userId)!;

        if (!preferences || typeof preferences !== "object") {
          throw new ValidationError(
            "Preferences must be an object",
            "preferences",
          );
        }

        // Sanitize preferences to prevent prototype pollution
        const sanitizedPreferences = sanitizeObject(preferences) as Record<
          string,
          any
        >;

        await supabaseService.syncPreferences(
          validatedUserId,
          sanitizedPreferences,
        );

        return {
          success: true,
        };
      } catch (error) {
        logService.error("[Preferences] Failed to save preferences:", "Preferences", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update specific preference (partial update)
  ipcMain.handle(
    "preferences:update",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      partialPreferences: unknown,
    ): Promise<PreferenceResponse> => {
      try {
        logService.info("[Preferences] Updating preferences", "Preferences", { userId });

        // Validate inputs
        const validatedUserId = validateUserId(userId)!;

        if (!partialPreferences || typeof partialPreferences !== "object") {
          throw new ValidationError(
            "Preferences must be an object",
            "partialPreferences",
          );
        }

        // Sanitize preferences to prevent prototype pollution
        const sanitizedPartialPreferences = sanitizeObject(partialPreferences);

        // BACKLOG-3469: the Settings switch takes effect at once, before (and
        // regardless of) the cloud save.
        const autoDownload = autoDownloadInPartial(sanitizedPartialPreferences);
        if (autoDownload !== null) {
          applyAutoDownload(autoDownload);
        }

        // Get existing preferences
        const existingPreferences =
          (await supabaseService.getPreferences(validatedUserId)) ?? {};

        // Merge with new preferences (deep merge for nested objects)
        const updatedPreferences = deepMerge(
          existingPreferences,
          sanitizedPartialPreferences,
        );

        // Save merged preferences
        await supabaseService.syncPreferences(
          validatedUserId,
          updatedPreferences,
        );

        return {
          success: true,
          preferences: updatedPreferences,
        };
      } catch (error) {
        logService.error("[Preferences] Failed to update preferences:", "Preferences", { error });
        // TASK-2058: Log failure for offline diagnostics (skip validation errors)
        if (!(error instanceof ValidationError)) {
          failureLogService.logFailure(
            "preferences_sync",
            error instanceof Error ? error.message : "Unknown error"
          );
        }
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  logService.debug("Handlers registered", "Preferences");
}

/**
 * Deep merge two objects
 * @param target - Target object
 * @param source - Source object
 * @returns Merged object
 */
function deepMerge(target: unknown, source: unknown): Record<string, unknown> {
  const output = { ...(target as Record<string, unknown>) };

  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        if (!(key in (target as Record<string, unknown>))) {
          output[key] = source[key];
        } else {
          output[key] = deepMerge(
            (target as Record<string, unknown>)[key],
            source[key],
          );
        }
      } else {
        output[key] = source[key];
      }
    });
  }

  return output;
}

/**
 * Check if value is an object
 * @param item - Item to check
 * @returns True if object
 */
function isObject(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === "object" && !Array.isArray(item);
}
