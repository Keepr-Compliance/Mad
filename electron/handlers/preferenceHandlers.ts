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
import {
  betaUpdatesChangeCount,
  betaUpdatesFromPreferences,
  betaUpdatesInPartial,
  applyBetaUpdatesOff,
  betaUpdatesSessionEpoch,
  clearStoredBetaUpdates,
  getBetaUpdatesInputs,
  isLatestBetaUpdatesWrite,
  noteBetaUpdatesChange,
  noteBetaUpdatesWriteStart,
  recordStoredBetaUpdates,
} from "../services/updateChannelPolicy";
import sessionService from "../services/sessionService";

/**
 * BACKLOG-4245: whether `userId` is the user the session file names. The
 * beta-updates value is recorded only for that user. Never throws.
 */
async function isSessionUser(userId: string): Promise<boolean> {
  try {
    const peek = await sessionService.peekSession();
    if (peek.status !== "ok") return false;
    const session = peek.session;
    if (session.expiresAt && Date.now() > session.expiresAt) return false;
    return session.user?.id === userId;
  } catch {
    return false;
  }
}

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
      let betaChangesAtRead = -1;
      try {
        logService.debug("[Preferences] Getting preferences", "Preferences", { userId });

        // Validate input
        validatedUserId = validateUserId(userId)!;
        // BACKLOG-4245: a write naming the preference, or a session change,
        // while this read runs makes its beta value stale.
        betaChangesAtRead = betaUpdatesChangeCount();

        const preferences =
          (await supabaseService.getPreferences(validatedUserId)) ?? {};

        // BACKLOG-3469: the read value drives the updater (default on).
        applyAutoDownload(autoDownloadFromPreferences(preferences));
        // BACKLOG-4245: the read value is recorded for the session user only.
        if (
          (await isSessionUser(validatedUserId)) &&
          betaUpdatesChangeCount() === betaChangesAtRead
        ) {
          recordStoredBetaUpdates(validatedUserId, betaUpdatesFromPreferences(preferences));
        }

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
            if (
              (await isSessionUser(validatedUserId)) &&
              betaUpdatesChangeCount() === betaChangesAtRead
            ) {
              recordStoredBetaUpdates(validatedUserId, betaUpdatesFromPreferences(copy.preferences));
            }
            return {
              success: true,
              preferences: copy.preferences,
              source: "copy",
              copiedAt: copy.copiedAt,
            };
          }
        }
        // BACKLOG-4245: no value could be read: prereleases off.
        clearStoredBetaUpdates();
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
        // BACKLOG-4245: turning beta updates off takes effect at once, and the
        // recorded value becomes false at once (an eligibility answer during
        // the save then cannot turn betas back on). Turning them on takes
        // effect only once the cloud save has succeeded. A failed save leaves
        // betas off either way; the next good read restores the stored value.
        const betaUpdates = betaUpdatesInPartial(sanitizedPartialPreferences);
        const betaUpdatesWrite = betaUpdates === null ? null : noteBetaUpdatesWriteStart();
        if (betaUpdates === false) {
          if (getBetaUpdatesInputs().stored?.userId === validatedUserId) {
            // Recorded only ever for the session user, so no session check is needed.
            recordStoredBetaUpdates(validatedUserId, false);
          } else {
            applyBetaUpdatesOff();
          }
        }
        try {
          const betaForSessionUser =
            betaUpdatesWrite !== null && (await isSessionUser(validatedUserId));
          if (
            betaUpdates === false &&
            betaForSessionUser &&
            betaUpdatesWrite !== null &&
            betaUpdatesWrite.epoch === betaUpdatesSessionEpoch()
          ) {
            recordStoredBetaUpdates(validatedUserId, false);
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

          // Applied only if nothing named the preference, and no session
          // change happened, since this call started.
          if (
            betaUpdates === true &&
            betaForSessionUser &&
            betaUpdatesWrite !== null &&
            isLatestBetaUpdatesWrite(betaUpdatesWrite)
          ) {
            recordStoredBetaUpdates(validatedUserId, true);
          }

          return {
            success: true,
            preferences: updatedPreferences,
          };
        } finally {
          // The write has finished (saved or failed): a read that ran during it is stale.
          if (betaUpdates !== null) noteBetaUpdatesChange();
        }
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
