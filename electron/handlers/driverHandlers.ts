/**
 * Apple Driver IPC Handlers
 *
 * Handles IPC communication for Apple driver detection and installation.
 */

import { ipcMain, shell, BrowserWindow } from "electron";
import log from "electron-log";
import {
  checkAppleDrivers,
  installAppleDrivers,
  hasBundledDrivers,
  getITunesDownloadUrl,
  getITunesWebUrl,
  checkForDriverUpdate,
  downloadAppleDrivers,
  getAppleDevicesStoreUrl,
  getAppleDevicesWebUrl,
  STORE_INSTALL_REFUSAL_MESSAGE,
} from "../services/appleDriverService";
import { isStoreBuild } from "../services/distributionChannelService";

/**
 * Register driver-related IPC handlers
 */
export function registerDriverHandlers(): void {
  // Check if Apple drivers are installed
  ipcMain.handle("drivers:check-apple", async () => {
    log.info("[DriverHandlers] Checking Apple driver status");
    const status = await checkAppleDrivers();
    log.info("[DriverHandlers] Apple driver status:", status);
    return status;
  });

  // Check if bundled drivers are available
  ipcMain.handle("drivers:has-bundled", () => {
    return { hasBundled: hasBundledDrivers() };
  });

  // Check for driver updates
  ipcMain.handle("drivers:check-update", async () => {
    log.info("[DriverHandlers] Checking for driver updates");
    const result = await checkForDriverUpdate();
    log.info("[DriverHandlers] Update check result:", result);
    return result;
  });

  // Install Apple drivers (requires user consent in UI)
  // Will download on-demand if not bundled
  ipcMain.handle("drivers:install-apple", async (event) => {
    log.info("[DriverHandlers] User consented to install Apple drivers");

    // BACKLOG-3927: the Microsoft Store build installs no Apple driver and
    // never downloads Apple's installer. Refuse before anything is fetched.
    if (isStoreBuild()) {
      log.info("[DriverHandlers] Store build: install refused, Apple Devices guide applies");
      return {
        success: false,
        error: STORE_INSTALL_REFUSAL_MESSAGE,
        rebootRequired: false,
      };
    }

    // Check if we have drivers available (bundled or previously downloaded)
    if (!hasBundledDrivers()) {
      log.info("[DriverHandlers] No bundled drivers, downloading on-demand...");

      // Send progress to renderer
      const window = BrowserWindow.fromWebContents(event.sender);

      const downloadResult = await downloadAppleDrivers((progress) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send("drivers:download-progress", progress);
        }
      });

      if (!downloadResult.success) {
        log.error("[DriverHandlers] Download failed:", downloadResult.error);
        return {
          success: false,
          error: downloadResult.error || "Failed to download drivers",
        };
      }

      log.info(
        "[DriverHandlers] Download complete, proceeding with installation",
      );
    }

    const result = await installAppleDrivers();
    log.info("[DriverHandlers] Installation result:", result);
    return result;
  });

  // Download drivers without installing (for pre-download option)
  ipcMain.handle("drivers:download", async (event) => {
    log.info("[DriverHandlers] Downloading Apple drivers...");

    // BACKLOG-3927: no Apple installer download in the Store build.
    if (isStoreBuild()) {
      log.info("[DriverHandlers] Store build: download refused");
      return { success: false, error: STORE_INSTALL_REFUSAL_MESSAGE };
    }

    const window = BrowserWindow.fromWebContents(event.sender);

    const result = await downloadAppleDrivers((progress) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send("drivers:download-progress", progress);
      }
    });

    log.info("[DriverHandlers] Download result:", result);
    return result;
  });

  // Open iTunes in Microsoft Store
  ipcMain.handle("drivers:open-itunes-store", async () => {
    try {
      await shell.openExternal(getITunesDownloadUrl());
      return { success: true };
    } catch (error) {
      log.error("[DriverHandlers] Failed to open iTunes store:", error);
      // Fallback to web URL
      try {
        await shell.openExternal(getITunesWebUrl());
        return { success: true };
      } catch (_fallbackError) {
        return {
          success: false,
          error: "Failed to open iTunes download page",
        };
      }
    }
  });

  // BACKLOG-3927: open Apple's "Apple Devices" app page in the Microsoft Store
  // (the Store build's way to get Apple Mobile Device Support).
  ipcMain.handle("drivers:open-apple-devices-store", async () => {
    try {
      await shell.openExternal(getAppleDevicesStoreUrl());
      return { success: true };
    } catch (error) {
      log.error("[DriverHandlers] Failed to open Apple Devices in the Store:", error);
      try {
        await shell.openExternal(getAppleDevicesWebUrl());
        return { success: true };
      } catch (_fallbackError) {
        return {
          success: false,
          error: "Failed to open the Apple Devices page",
        };
      }
    }
  });

  log.info("[DriverHandlers] Registered driver IPC handlers");
}
