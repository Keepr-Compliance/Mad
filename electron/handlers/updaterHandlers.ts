// ============================================
// AUTO-UPDATER IPC HANDLERS
// Extracted from main.ts for modularity
// Handles: install-update
// ============================================

import { ipcMain, app, shell, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import * as Sentry from "@sentry/electron/main";
import * as path from "path";
import * as fs from "fs";
import logService from "../services/logService";
import failureLogService from "../services/failureLogService";
import { getRecentUpdaterFailure } from "../services/updaterFailureStore";
import {
  buildManualInstallerUrl,
  type GithubPublishConfig,
} from "../services/updaterAssetUrl";

// Track registration to prevent duplicate handlers
let handlersRegistered = false;

/**
 * BACKLOG-1905: read the electron-builder GitHub publish config (owner/repo)
 * from the bundled package.json — the CANONICAL Keepr-Compliance/keepr-releases
 * source, NOT the legacy `5hdaniel` owner still baked into app-update.yml
 * (that is what BACKLOG-1909 fixes; the canonical owner resolves either way).
 * Read once and memoized. Returns undefined if the config can't be read.
 */
let cachedPublishConfig: GithubPublishConfig | null | undefined;
function readGithubPublishConfig(): GithubPublishConfig | undefined {
  if (cachedPublishConfig !== undefined) {
    return cachedPublishConfig ?? undefined;
  }
  try {
    // In packaged builds package.json lives inside the asar at app.getAppPath().
    const pkgPath = path.join(app.getAppPath(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      build?: { publish?: GithubPublishConfig | GithubPublishConfig[] };
      productName?: string;
    };
    const publish = pkg.build?.publish;
    const cfg = Array.isArray(publish) ? publish[0] : publish;
    cachedPublishConfig = cfg ?? null;
    return cfg ?? undefined;
  } catch (err) {
    logService.warn(
      "Could not read build.publish from package.json",
      "UpdaterHandlers",
      { error: err instanceof Error ? err.message : String(err) },
    );
    cachedPublishConfig = null;
    return undefined;
  }
}

/**
 * Register auto-updater IPC handlers
 */
export function registerUpdaterHandlers(mainWindow: BrowserWindow): void {
  // Prevent double registration
  if (handlersRegistered) {
    logService.warn(
      "Handlers already registered, skipping duplicate registration",
      "UpdaterHandlers"
    );
    return;
  }
  handlersRegistered = true;

  // Check for updates manually (TASK-1990)
  // TASK-2056: Added 15-second timeout to prevent hanging when offline
  ipcMain.handle("app:check-for-updates", async () => {
    try {
      if (!app.isPackaged) {
        return { updateAvailable: false, currentVersion: app.getVersion() };
      }

      // macOS App Translocation: skip update check when running from a translocated
      // path — Squirrel.Mac cannot write to the app bundle in this state
      if (process.platform === "darwin" && process.execPath.includes("/AppTranslocation/")) {
        logService.warn(
          "App Translocation detected — update check skipped",
          "UpdaterHandlers",
          { execPath: process.execPath }
        );
        return {
          updateAvailable: false,
          currentVersion: app.getVersion(),
          error: "Please move Keepr to your Applications folder to enable automatic updates.",
          translocationDetected: true,
        };
      }

      // Race the update check against a 15-second timeout
      const timeoutMs = 15000;
      const result = await Promise.race([
        autoUpdater.checkForUpdates(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error(`Update check timed out after ${timeoutMs / 1000}s`)), timeoutMs)
        ),
      ]);

      return {
        updateAvailable: result?.isUpdateAvailable ?? false,
        version: result?.updateInfo?.version,
        currentVersion: app.getVersion(),
      };
    } catch (error) {
      logService.warn("Manual update check failed", "UpdaterHandlers", {
        error: error instanceof Error ? error.message : "Check failed",
      });
      Sentry.captureException(error, { tags: { component: "auto-updater", trigger: "manual-check" } });
      // TASK-2058: Log failure for offline diagnostics
      failureLogService.logFailure(
        "check_for_updates",
        error instanceof Error ? error.message : "Check failed"
      );

      // macOS: Surface read-only volume errors as translocation guidance
      const errMsg = error instanceof Error ? error.message.toLowerCase() : "";
      if (process.platform === "darwin" && (errMsg.includes("read-only volume") || errMsg.includes("readonly"))) {
        return {
          updateAvailable: false,
          currentVersion: app.getVersion(),
          error: "Please move Keepr to your Applications folder to enable automatic updates.",
          translocationDetected: true,
        };
      }

      return {
        updateAvailable: false,
        currentVersion: app.getVersion(),
        error: error instanceof Error ? error.message : "Check failed",
      };
    }
  });

  // Install update and restart
  ipcMain.on("install-update", () => {
    logService.info("Installing update...", "UpdaterHandlers");
    // TASK-2330: Track when user triggers install so Sentry breadcrumb trail
    // shows the full lifecycle: check -> available -> downloaded -> install
    Sentry.addBreadcrumb({ category: "auto-updater", message: "User triggered install-update", level: "info" });

    // Ensure app relaunches after update
    // Parameters: isSilent, isForceRunAfter
    // false = show installer, true = force run after install
    setImmediate(() => {
      app.removeAllListeners("window-all-closed");
      if (mainWindow) {
        mainWindow.removeAllListeners("close");
        mainWindow.close();
      }
      autoUpdater.quitAndInstall(false, true);
    });
  });

  // BACKLOG-1905: one-click, platform-correct manual installer.
  // When an auto-update fails and the user clicks "Download installer", open the
  // EXACT target-version asset for their OS/arch from the canonical
  // Keepr-Compliance/keepr-releases repo — no manual website navigation, no
  // dead-end. Target version comes from the most recent failure (10-min window)
  // and falls back to the current version.
  ipcMain.handle("app:open-manual-installer", async () => {
    try {
      const publish = readGithubPublishConfig();
      if (!publish?.owner || !publish?.repo) {
        logService.warn(
          "Manual installer: publish config unavailable",
          "UpdaterHandlers",
        );
        return { success: false, error: "Release configuration unavailable." };
      }

      // Prefer the version the failed update was targeting; fall back to current.
      const targetVersion =
        getRecentUpdaterFailure()?.targetVersion ?? app.getVersion();

      const url = buildManualInstallerUrl({
        version: targetVersion,
        platform: process.platform,
        arch: process.arch,
        publish,
      });

      if (!url) {
        logService.warn(
          "Manual installer: no asset URL for this platform/arch",
          "UpdaterHandlers",
          { platform: process.platform, arch: process.arch, targetVersion },
        );
        return {
          success: false,
          error: "No installer is available for this platform.",
        };
      }

      Sentry.addBreadcrumb({
        category: "auto-updater",
        message: "User opened manual installer download",
        level: "info",
        data: { targetVersion, platform: process.platform, arch: process.arch },
      });

      await shell.openExternal(url);
      return { success: true, url };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open installer";
      logService.warn("Manual installer open failed", "UpdaterHandlers", {
        error: message,
      });
      Sentry.captureException(error, {
        tags: { component: "auto-updater", trigger: "manual-installer" },
      });
      return { success: false, error: message };
    }
  });
}
