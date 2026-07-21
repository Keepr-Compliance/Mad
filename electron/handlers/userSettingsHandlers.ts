// ============================================
// USER SETTINGS IPC HANDLERS
// Handles: user preferences, phone type, notifications, user DB checks
// ============================================

import { ipcMain, Notification, app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { execFileSync } from "child_process";
import databaseService from "../services/databaseService";
import supabaseService from "../services/supabaseService";
import logService from "../services/logService";
import auditService from "../services/auditService";
import { initializationBroadcaster } from "../services/initializationBroadcaster";
import { wrapHandler } from "../utils/wrapHandler";
import {
  ValidationError,
  validateUserId,
} from "../utils/validation";
import { ensureUserInLocalDb } from "./systemHandlers";

/**
 * Register all user settings IPC handlers
 */
export function registerUserSettingsHandlers(): void {
  // ===== USER PHONE TYPE PREFERENCES =====

  /**
   * Get user's mobile phone type preference
   * Note: Cannot use wrapHandler because error response requires phoneType: null
   * @param userId - User ID to get phone type for
   * @returns Phone type ('iphone' | 'android' | null)
   */
  ipcMain.handle(
    "user:get-phone-type",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      phoneType: "iphone" | "android" | null;
      error?: string;
      transient?: boolean;
      retryable?: boolean;
    }> => {
      try {
        // BACKLOG-1842 (resume-at-step fix round, startup-resilience follow-up):
        // this handler reads databaseService.getUserById, which throws "Database
        // is not initialized" when called before DB init completes. Live trace
        // evidence (main.log 2026-07-20 21:55:38.857) caught this firing
        // unguarded during a fast relaunch/sign-in — it recovered silently
        // (caller has its own fallback), but per BACKLOG-2149's established
        // pattern (see system:verify-user-in-local-db above,
        // auth:get-current-user in sessionHandlers.ts), await the shared
        // db-ready signal instead of racing straight into a hard DB error.
        if (!databaseService.isInitialized()) {
          const result = await initializationBroadcaster.whenDbReady();
          if (!result.ready) {
            logService.warn("get-phone-type: DB still not ready", "Settings", {
              timedOut: result.timedOut,
              error: result.error?.message,
            });
            return {
              success: false,
              phoneType: null,
              transient: true,
              retryable: true,
              error: "Database is starting up",
            };
          }
        }

        const validatedUserId = validateUserId(userId);
        // validateUserId throws when required (default), so validatedUserId is never null here
        const user = await databaseService.getUserById(validatedUserId!);

        if (!user) {
          return { success: true, phoneType: null };
        }

        return {
          success: true,
          phoneType: user.mobile_phone_type as "iphone" | "android" | null,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error("Failed to get user phone type", "Settings", {
          error: errorMessage,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            phoneType: null,
            error: `Validation error: ${error.message}`,
          };
        }
        return { success: false, phoneType: null, error: errorMessage };
      }
    },
  );

  /**
   * Set user's mobile phone type preference
   * @param userId - User ID to set phone type for
   * @param phoneType - Phone type to set ('iphone' | 'android')
   */
  ipcMain.handle(
    "user:set-phone-type",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
      phoneType: "iphone" | "android",
    ): Promise<{ success: boolean; error?: string }> => {
      const validatedUserId = validateUserId(userId);

      // Validate phone type
      if (phoneType !== "iphone" && phoneType !== "android") {
        return {
          success: false,
          error: 'Invalid phone type. Must be "iphone" or "android"',
        };
      }

      // validateUserId throws when required (default), so validatedUserId is never null here
      await databaseService.updateUser(validatedUserId!, {
        mobile_phone_type: phoneType,
      });
      logService.info(
        `Updated phone type for user ${validatedUserId} to ${phoneType}`,
        "Settings",
      );

      // Audit log settings change
      try {
        await auditService.log({
          userId: validatedUserId!,
          action: "SETTINGS_CHANGE",
          resourceType: "SETTINGS",
          resourceId: validatedUserId!,
          success: true,
          metadata: { setting: "mobile_phone_type", value: phoneType },
        });
      } catch (auditError) {
        logService.warn("[Audit] Failed to log settings change", "Settings", { auditError });
      }

      return { success: true };
    }, { module: "Settings" }),
  );

  // ===== CLOUD PHONE TYPE PREFERENCES (TASK-1600) =====

  /**
   * Get user's mobile phone type from Supabase cloud storage
   * TASK-1600: Available before local DB initialization
   * @param userId - User ID to get phone type for
   * @returns Phone type from user_preferences.preferences.phone_type
   */
  ipcMain.handle(
    "user:get-phone-type-cloud",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      phoneType?: "iphone" | "android";
      error?: string;
    }> => {
      const validatedUserId = validateUserId(userId);

      const preferences = await supabaseService.getPreferences(
        validatedUserId!,
      );
      const phoneType = preferences?.phone_type as
        | "iphone"
        | "android"
        | undefined;

      logService.info(
        `[user:get-phone-type-cloud] Retrieved phone type from Supabase: ${phoneType || "none"}`,
        "Settings",
        { userId: validatedUserId?.substring(0, 8) + "..." },
      );

      return { success: true, phoneType };
    }, { module: "Settings" }),
  );

  /**
   * Set user's mobile phone type in Supabase cloud storage
   * TASK-1600: Available before local DB initialization
   * Uses upsert to handle both new and existing user_preferences rows
   * @param userId - User ID to set phone type for
   * @param phoneType - Phone type to set ('iphone' | 'android')
   */
  ipcMain.handle(
    "user:set-phone-type-cloud",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
      phoneType: "iphone" | "android",
    ): Promise<{ success: boolean; error?: string }> => {
      const validatedUserId = validateUserId(userId);

      // Validate phone type
      if (phoneType !== "iphone" && phoneType !== "android") {
        return {
          success: false,
          error: 'Invalid phone type. Must be "iphone" or "android"',
        };
      }

      // Get existing preferences to merge
      let existingPreferences: Record<string, unknown> = {};
      try {
        existingPreferences = await supabaseService.getPreferences(
          validatedUserId!,
        );
      } catch {
        // No existing preferences - start fresh
      }

      // Merge phone_type into preferences
      const updatedPreferences = {
        ...existingPreferences,
        phone_type: phoneType,
      };

      // Sync to Supabase (uses upsert internally)
      await supabaseService.syncPreferences(
        validatedUserId!,
        updatedPreferences,
      );

      logService.info(
        `[user:set-phone-type-cloud] Saved phone type to Supabase: ${phoneType}`,
        "Settings",
        { userId: validatedUserId?.substring(0, 8) + "..." },
      );

      // Audit log cloud settings change
      try {
        await auditService.log({
          userId: validatedUserId!,
          action: "SETTINGS_CHANGE",
          resourceType: "SETTINGS",
          resourceId: validatedUserId!,
          success: true,
          metadata: { setting: "mobile_phone_type_cloud", value: phoneType },
        });
      } catch (auditError) {
        logService.warn("[Audit] Failed to log cloud settings change", "Settings", { auditError });
      }

      return { success: true };
    }, { module: "Settings" }),
  );

  /**
   * Sync user's phone type from Supabase cloud to local database
   * Used by DataSyncStep to ensure local DB has phone_type before FDA step
   * @param userId - User ID to sync phone type for
   */
  ipcMain.handle(
    "user:sync-phone-type-from-cloud",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{ success: boolean; error?: string }> => {
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        return { success: false, error: "Invalid user ID" };
      }

      // 1. Get phone_type from Supabase
      const preferences = await supabaseService.getPreferences(validatedUserId);
      const cloudPhoneType = preferences?.phone_type as "iphone" | "android" | undefined;

      if (!cloudPhoneType) {
        logService.info(
          "[user:sync-phone-type] No phone type in cloud, nothing to sync",
          "Settings",
          { userId: validatedUserId.substring(0, 8) + "..." },
        );
        return { success: true };
      }

      // 2. Check if local DB already has it
      const user = await databaseService.getUserById(validatedUserId);
      if (user?.mobile_phone_type === cloudPhoneType) {
        logService.info(
          "[user:sync-phone-type] Local DB already in sync",
          "Settings",
          { userId: validatedUserId.substring(0, 8) + "...", phoneType: cloudPhoneType },
        );
        return { success: true };
      }

      // 3. Update local DB
      if (user) {
        await databaseService.updateUser(validatedUserId, {
          mobile_phone_type: cloudPhoneType,
        });
        logService.info(
          `[user:sync-phone-type] Synced phone type to local DB: ${cloudPhoneType}`,
          "Settings",
          { userId: validatedUserId.substring(0, 8) + "..." },
        );
      } else {
        logService.warn(
          "[user:sync-phone-type] User not found in local DB, cannot sync",
          "Settings",
          { userId: validatedUserId.substring(0, 8) + "..." },
        );
      }

      return { success: true };
    }, { module: "Settings" }),
  );

  // ============================================
  // NOTIFICATION HANDLERS
  // ============================================

  /**
   * Check if notifications are supported AND authorized on this platform.
   * On macOS, Notification.isSupported() only checks platform capability (always true).
   * We also read the actual permission state from the notification center preferences.
   */
  ipcMain.handle(
    "notification:is-supported",
    wrapHandler(async (): Promise<{ success: boolean; supported: boolean }> => {
      if (!Notification.isSupported()) {
        return { success: true, supported: false };
      }

      // On macOS, check the actual notification authorization status
      if (process.platform === "darwin") {
        try {
          const bundleId = app.isPackaged
            ? "com.keeprcompliance.keepr"
            : "com.github.Electron";

          // Read the ncprefs plist to find our app's auth value
          // auth: 0 = not determined, 1 = denied, 2 = authorized, 3 = provisional
          const output = execFileSync(
            "defaults",
            ["read", "com.apple.ncprefs", "apps"],
            { encoding: "utf-8", timeout: 3000 },
          );

          // Find the entry for our bundle ID and extract auth value
          const bundleIndex = output.indexOf(`"bundle-id" = "${bundleId}"`);
          if (bundleIndex !== -1) {
            const searchRegion = output.substring(bundleIndex, bundleIndex + 500);
            const authMatch = searchRegion.match(/auth\s*=\s*(\d+)/);
            if (authMatch) {
              const authValue = parseInt(authMatch[1], 10);
              // Only consider authorized (2) or provisional (3) as "enabled"
              const isAuthorized = authValue >= 2;
              logService.info(
                `[Notifications] Permission check: bundleId=${bundleId}, auth=${authValue}, authorized=${isAuthorized}`,
                "Settings",
              );
              return { success: true, supported: isAuthorized };
            }
          }

          // App not found in ncprefs — notifications not yet determined
          logService.info(
            `[Notifications] App not found in ncprefs (bundleId=${bundleId}), treating as not authorized`,
            "Settings",
          );
          return { success: true, supported: false };
        } catch (err) {
          logService.warn(
            "[Notifications] Failed to read ncprefs, falling back to isSupported()",
            "Settings",
          );
        }
      }

      return { success: true, supported: Notification.isSupported() };
    }, { module: "Settings" }),
  );

  /**
   * Send an OS notification
   * @param title - Notification title
   * @param body - Notification body text
   */
  ipcMain.handle(
    "notification:send",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      title: string,
      body: string,
    ): Promise<{ success: boolean; error?: string }> => {
      if (!Notification.isSupported()) {
        return {
          success: false,
          error: "Notifications are not supported on this platform",
        };
      }

      const notification = new Notification({
        title,
        body,
        silent: false,
      });

      notification.show();
      logService.info("[Notifications] Notification sent via Electron API", "Settings", { title });

      return { success: true };
    }, { module: "Settings" }),
  );

  // ============================================
  // USER DB CHECK HANDLERS
  // ============================================

  /**
   * IPC Handler: Verify user exists in local database
   * Called by AccountVerificationStep to ensure user is created before email connection.
   */
  ipcMain.handle(
    "system:verify-user-in-local-db",
    wrapHandler(async (): Promise<{
      success: boolean;
      userId?: string;
      error?: string;
      transient?: boolean;
      retryable?: boolean;
    }> => {
      logService.info("verify-user-in-local-db handler called", "Settings");

      // BACKLOG-1381 / BACKLOG-2149: Check DB readiness (not full init completion)
      // to fix a race condition. verify-user-in-local-db only needs the DB to be
      // queryable, not the entire init sequence to be done.
      //
      // BACKLOG-2149: Under memory pressure the OAuth callback can outrun
      // DatabaseService.initialize(). Instead of immediately returning a HARD
      // "Database not initialized" error (which the renderer surfaced as
      // "Setup failed"), AWAIT the shared db-ready signal with a timeout. If the
      // DB comes up we proceed normally; if the wait times out we return a
      // TRANSIENT/retryable result so the renderer shows a calm "starting up"
      // state and keeps retrying, rather than a terminal failure.
      if (!databaseService.isInitialized()) {
        logService.warn(
          "verify-user-in-local-db: DB not initialized, awaiting db-ready",
          "Settings",
        );
        const result = await initializationBroadcaster.whenDbReady();
        if (!result.ready) {
          logService.warn("verify-user-in-local-db: DB still not ready", "Settings", {
            timedOut: result.timedOut,
            error: result.error?.message,
          });
          return {
            success: false,
            transient: true,
            retryable: true,
            error: "Database is starting up",
          };
        }
      }

      return ensureUserInLocalDb();
    }, { module: "Settings" }),
  );

  /**
   * Check if a user exists in the local database
   * BACKLOG-611: Used to determine if secure-storage step should be shown
   * even on machines with previous installs (different user)
   * @param userId - User ID to check
   * @returns Whether the user exists in the local DB
   */
  ipcMain.handle(
    "system:check-user-in-local-db",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{ success: boolean; exists: boolean; error?: string }> => {
      // If database is not initialized, user can't exist
      if (!databaseService.isInitialized()) {
        return { success: true, exists: false };
      }

      const validatedUserId = validateUserId(userId, false); // Don't throw if null
      if (!validatedUserId) {
        return { success: true, exists: false };
      }

      const user = await databaseService.getUserById(validatedUserId);
      const exists = user !== null;

      logService.debug(
        `[system:check-user-in-local-db] User ${validatedUserId.substring(0, 8)}... exists: ${exists}`,
        "Settings",
      );

      return { success: true, exists };
    }, { module: "Settings" }),
  );
}
