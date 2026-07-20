// ============================================
// PERMISSION & SYSTEM INFO IPC HANDLERS
// Extracted from main.ts for modularity
// Handles: Full Disk Access, macOS version, app location
// ============================================

import { ipcMain, app, shell } from "electron";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import logService from "../services/logService";

// Track registration to prevent duplicate handlers
let handlersRegistered = false;

/**
 * Register permission and system info IPC handlers
 * These are the legacy handlers from main.ts that don't fit in system-handlers.ts
 */
export function registerPermissionHandlers(): void {
  // Prevent double registration
  if (handlersRegistered) {
    logService.warn(
      "Handlers already registered, skipping duplicate registration",
      "PermissionHandlers"
    );
    return;
  }
  handlersRegistered = true;

  // Get app information for Full Disk Access
  ipcMain.handle("get-app-info", () => {
    try {
      const appPath = app.getPath("exe");
      const appName = app.getName();

      return {
        name: appName,
        path: appPath,
        pid: process.pid,
      };
    } catch (error) {
      logService.error("Error getting app info", "PermissionHandlers", { error });
      return {
        name: "Unknown",
        path: "Unknown",
        pid: 0,
      };
    }
  });

  // Get macOS version information
  ipcMain.handle("get-macos-version", () => {
    try {
      if (process.platform === "darwin") {
        const release = os.release();
        const parts = release.split(".");
        const majorVersion = parseInt(parts[0], 10);

        // Convert Darwin version to macOS version
        let macOSVersion = 10;
        if (majorVersion >= 20) {
          macOSVersion = majorVersion - 9; // Darwin 20 = macOS 11
        }

        // Name the versions
        const versionNames: Record<number, string> = {
          11: "Big Sur",
          12: "Monterey",
          13: "Ventura",
          14: "Sonoma",
          15: "Sequoia",
          16: "Tahoe",
        };

        const macOSName = versionNames[macOSVersion] || "Unknown";

        // Determine UI style
        const uiStyle = macOSVersion >= 13 ? "settings" : "preferences";
        const appName =
          macOSVersion >= 13 ? "System Settings" : "System Preferences";

        return {
          version: macOSVersion,
          name: macOSName,
          darwinVersion: majorVersion,
          fullRelease: release,
          uiStyle,
          appName,
        };
      }

      return {
        version: null,
        name: "Not macOS",
        darwinVersion: 0,
        fullRelease: "not-macos",
        uiStyle: "settings",
        appName: "System Settings",
      };
    } catch (error) {
      logService.error("Error detecting macOS version", "PermissionHandlers", { error });
      return {
        version: 13,
        name: "Unknown (Error)",
        darwinVersion: 0,
        fullRelease: "unknown",
        uiStyle: "settings",
        appName: "System Settings",
      };
    }
  });

  // Check if app is running from /Applications folder
  ipcMain.handle("check-app-location", async () => {
    try {
      // Only check on macOS
      if (process.platform !== "darwin") {
        return {
          isInApplications: true, // Not applicable on other platforms
          shouldPrompt: false,
          appPath: app.getPath("exe"),
        };
      }

      // Get the app executable path
      const appPath = app.getPath("exe");

      // Check if running from /Applications
      const isInApplications = appPath.includes("/Applications/");

      // Check if running from common temporary/download locations
      const isDmgOrDownloads =
        appPath.includes("/Volumes/") ||
        appPath.includes("/Downloads") ||
        appPath.includes("/Desktop") ||
        appPath.includes("/private/var");

      // Should prompt if not in Applications AND is in a temporary location
      const shouldPrompt = !isInApplications && isDmgOrDownloads;

      return {
        isInApplications,
        shouldPrompt,
        appPath,
      };
    } catch (error) {
      logService.error("Error checking app location", "PermissionHandlers", { error });
      return {
        isInApplications: false,
        shouldPrompt: false,
        appPath: "unknown",
      };
    }
  });

  // Trigger Full Disk Access request by attempting to read Messages database
  // This will cause the app to appear in System Settings > Privacy & Security > Full Disk Access
  ipcMain.handle("trigger-full-disk-access", async () => {
    try {
      const messagesDbPath = path.join(
        process.env.HOME!,
        "Library/Messages/chat.db"
      );

      // Attempt to read the database - this will fail without permission
      // but it will cause macOS to add this app to the Full Disk Access list
      await fs.access(messagesDbPath, fs.constants.R_OK);
      return { triggered: true, alreadyGranted: true };
    } catch {
      return { triggered: true, alreadyGranted: false };
    }
  });

  // Check permissions for Messages database
  ipcMain.handle("check-permissions", async () => {
    // BACKLOG-1940: the reliable unpackaged QA driver has no macOS Full Disk Access, which would
    // trap the seeded (already-onboarded) user on the permissions step. Grant it in E2E mode only.
    // DOUBLE-gated (!app.isPackaged && KEEPR_E2E=1) → dead code in any packaged/shipped build.
    if (!app.isPackaged && process.env.KEEPR_E2E === "1") {
      logService.info("[E2E] KEEPR_E2E=1 — reporting Messages permission as granted", "PermissionHandlers");
      return { hasPermission: true };
    }

    const messagesDbPath = path.join(
      process.env.HOME!,
      "Library/Messages/chat.db"
    );

    logService.info("Checking permissions for Messages database", "PermissionHandlers", { path: messagesDbPath });

    try {
      await fs.access(messagesDbPath, fs.constants.R_OK);
      logService.info("Permission check PASSED - Messages database accessible", "PermissionHandlers");
      return { hasPermission: true };
    } catch (error) {
      logService.warn("Permission check FAILED", "PermissionHandlers", { error: (error as Error).message });
      return { hasPermission: false, error: (error as Error).message };
    }
  });

  // Request Contacts permission - Note: Not available via Electron API
  // Contacts access is handled by Full Disk Access which also grants Messages access
  ipcMain.handle("request-contacts-permission", async () => {
    // Contacts permission isn't available via systemPreferences API
    // Full Disk Access will provide access to both contacts and messages
    return {
      granted: false,
      status: "skip",
      message: "Contacts access included with Full Disk Access",
    };
  });

  // Open System Settings to Full Disk Access panel
  ipcMain.handle("open-system-settings", async () => {
    try {
      if (process.platform === "darwin") {
        // Open directly to Full Disk Access via URL scheme (no Accessibility permission needed)
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        );

        return { success: true };
      }

      return { success: false, message: "Not supported on this platform" };
    } catch (error) {
      logService.error("Error opening system settings", "PermissionHandlers", { error });
      return { success: false, error: (error as Error).message };
    }
  });

  // BACKLOG-1842: Clean relaunch after the user grants Full Disk Access.
  //
  // macOS caches the sandbox FDA decision per-process at launch: a running
  // process that was denied ~/Library/Messages/chat.db does NOT gain access
  // when the user flips the toggle — it must relaunch. BACKLOG-1816's copy
  // promised "we relaunch for you automatically" but never wired it. This is
  // that relaunch. It performs NO data wipe (unlike app-cleanup:reset); it just
  // restarts the process so the fresh instance sees the newly-granted FDA and
  // resumes onboarding/sync at the correct step (PermissionsStep is skipped
  // because startup checkPermissions() now returns granted).
  //
  // Uses the same non-destructive `app.relaunch(); app.exit(0)` pattern as
  // resetService.relaunchApp(). exit(0) (not quit()) skips before-quit guards —
  // safe here because onboarding has no in-flight submission.
  //
  // E2E/dev gate: NEVER relaunch under the automated harness — it would kill the
  // driver. Double-gated (!app.isPackaged && KEEPR_E2E=1) → dead code in any
  // packaged/shipped build, mirroring the check-permissions E2E gate above. In
  // plain dev (KEEPR_E2E unset) the relaunch DOES fire so the flow is testable.
  ipcMain.handle("relaunch-app", () => {
    if (!app.isPackaged && process.env.KEEPR_E2E === "1") {
      logService.info(
        "[E2E] KEEPR_E2E=1 — suppressing relaunch-app (would kill the driver)",
        "PermissionHandlers"
      );
      return { relaunched: false };
    }

    logService.info("Relaunching app after Full Disk Access grant", "PermissionHandlers");
    app.relaunch();
    app.exit(0);
    // Not reached in practice (process exits above); returned for the E2E/dev
    // fallthrough and to satisfy the invoke contract.
    return { relaunched: true };
  });

  // Request permissions (guide user)
  ipcMain.handle("request-permissions", async () => {
    // On Mac, we need to guide the user to grant Full Disk Access
    return {
      success: false,
      message:
        "Please grant Full Disk Access in System Preferences > Security & Privacy > Privacy > Full Disk Access",
    };
  });
}
