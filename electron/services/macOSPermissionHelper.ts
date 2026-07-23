import { app, shell, Notification } from "electron";
import { promises as fs } from "fs";
import path from "path";
import logService from "./logService";

/**
 * macOS Permission Helper
 * Handles permission requests and system preferences navigation
 */

interface PermissionResult {
  success: boolean;
  message?: string;
  error?: string;
}

interface FullDiskAccessResult {
  success: boolean;
  message: string;
  appPath: string;
  nextStep: string;
  error?: string;
}

interface PrivacyPaneResult {
  success: boolean;
  error?: string;
}

interface FullDiskAccessStatus {
  granted: boolean;
  message: string;
  error?: string;
}

interface PermissionSetupFlowResult {
  contacts: PermissionResult | null;
  fullDiskAccess: FullDiskAccessResult | null;
  overallSuccess: boolean;
  error?: string;
}

class MacOSPermissionHelper {
  /**
   * Request Contacts permission
   * Contacts access is provided via Full Disk Access on macOS.
   * This method is retained for API compatibility but no longer uses AppleScript.
   */
  async requestContactsPermission(): Promise<PermissionResult> {
    return {
      success: true,
      message: "Contacts access included with Full Disk Access",
    };
  }

  /**
   * Add app to Full Disk Access list and open System Preferences
   *
   * Note: macOS doesn't allow programmatically enabling Full Disk Access,
   * but we can open System Preferences to the correct location and
   * optionally add the app to the list (requires user approval)
   */
  async setupFullDiskAccess(): Promise<FullDiskAccessResult> {
    try {
      const appPath = app.getPath("exe");
      const bundleId = "com.keeprcompliance.keepr";

      // Method 1: Open System Preferences to Privacy > Full Disk Access
      // This uses the x-apple.systempreferences URL scheme
      const privacyURL =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

      logService.info("[MacOS] Opening System Preferences to Full Disk Access...", "MacOSPermissionHelper");
      await shell.openExternal(privacyURL);

      // Give System Preferences time to open
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Method 2: Try to programmatically add app to the list
      // This requires admin privileges and may prompt the user
      try {
        // This is informational - actual addition requires user interaction
        logService.info("[MacOS] App path:", "MacOSPermissionHelper", { appPath });
        logService.info("[MacOS] Bundle ID:", "MacOSPermissionHelper", { bundleId });
      } catch {
        logService.info(
          "[MacOS] Could not programmatically add app (expected - requires user action)",
          "MacOSPermissionHelper"
        );
      }

      return {
        success: true,
        message: "System Preferences opened to Full Disk Access",
        appPath,
        nextStep:
          "Keepr is already listed in Full Disk Access -- the user just needs to switch its toggle on, then relaunch",
      };
    } catch (error) {
      logService.error("[MacOS] Failed to setup Full Disk Access", "MacOSPermissionHelper", { error });
      return {
        success: false,
        message: "Failed to setup Full Disk Access",
        appPath: "",
        nextStep: "",
        error: (error as Error).message,
      };
    }
  }

  /**
   * Open System Preferences to specific Privacy pane
   * @param {string} pane - Privacy pane identifier
   */
  async openPrivacyPane(
    pane: string = "Privacy_AllFiles",
  ): Promise<PrivacyPaneResult> {
    const privacyPanes: Record<string, string> = {
      fullDiskAccess: "Privacy_AllFiles",
      contacts: "Privacy_Contacts",
      calendar: "Privacy_Calendars",
      accessibility: "Privacy_Accessibility",
    };

    const paneId = privacyPanes[pane] || pane;
    const url = `x-apple.systempreferences:com.apple.preference.security?${paneId}`;

    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      logService.error("[MacOS] Failed to open privacy pane", "MacOSPermissionHelper", { error });
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Read-only STATUS CHECK for Full Disk Access.
   *
   * BACKLOG-2192: This probes whether FDA is currently GRANTED by attempting an
   * fs.access() read on the Messages DB. It is check-only and does NOT register
   * the app in the Full Disk Access list -- fs.access() returns EPERM without
   * ever causing macOS/TCC to add Keepr to the FDA pane. The app is REGISTERED
   * (so the user has a toggle to flip) by the `trigger-full-disk-access` IPC
   * handler in permissionHandlers.ts, which does a genuine fs.open()+read on the
   * same path. Do not repurpose this method as the trigger.
   */
  async checkFullDiskAccessStatus(): Promise<FullDiskAccessStatus> {
    const messagesDbPath = path.join(
      process.env.HOME!,
      "Library/Messages/chat.db",
    );

    try {
      await fs.access(messagesDbPath, fs.constants.R_OK);
      return {
        granted: true,
        message: "Full Disk Access is enabled",
      };
    } catch (error) {
      return {
        granted: false,
        message: "Full Disk Access is not enabled",
        error: (error as NodeJS.ErrnoException).code,
      };
    }
  }

  /**
   * Show system notification about permissions
   */
  async showPermissionNotification(title: string, body: string): Promise<void> {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title,
        body,
      });

      notification.show();
    }
  }

  /**
   * Complete permission setup flow
   * Returns status of each step
   */
  async runPermissionSetupFlow(): Promise<PermissionSetupFlowResult> {
    logService.info("[MacOS] Starting permission setup flow...", "MacOSPermissionHelper");

    const results: PermissionSetupFlowResult = {
      contacts: null,
      fullDiskAccess: null,
      overallSuccess: false,
    };

    try {
      // Contacts access is included with Full Disk Access -- no separate step needed
      results.contacts = await this.requestContactsPermission();

      // Setup Full Disk Access (opens System Settings via URL scheme)
      logService.info("[MacOS] Setting up Full Disk Access...", "MacOSPermissionHelper");
      results.fullDiskAccess = await this.setupFullDiskAccess();

      // Show notification
      await this.showPermissionNotification(
        "Permission Setup",
        "Please enable Full Disk Access in System Settings to continue",
      );

      results.overallSuccess =
        results.contacts.success && results.fullDiskAccess.success;

      return results;
    } catch (error) {
      logService.error("[MacOS] Permission setup flow failed", "MacOSPermissionHelper", { error });
      return {
        ...results,
        error: (error as Error).message,
        overallSuccess: false,
      };
    }
  }
}

export default new MacOSPermissionHelper();
