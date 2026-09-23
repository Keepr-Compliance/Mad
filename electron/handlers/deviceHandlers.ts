// ============================================
// DEVICE DETECTION IPC HANDLERS
// Handles iOS device detection via USB
// ============================================

import { ipcMain, BrowserWindow } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import { deviceDetectionService } from "../services/deviceDetectionService";
import type { iOSDevice } from "../types/device";
import { sendToMainWindow } from "../windowRegistry";

/**
 * Response type for device-related IPC handlers
 */
interface DeviceResponse {
  success: boolean;
  error?: string;
}

/**
 * Response type for listing devices
 */
interface ListDevicesResponse extends DeviceResponse {
  devices?: iOSDevice[];
}

/**
 * Registers all device-related IPC handlers.
 * Sets up event forwarding from device service to renderer process.
 *
 * @param _mainWindow Ignored since BACKLOG-3454 — every push below resolves the
 *   CURRENT window through `sendToMainWindow`. Capturing this one meant that
 *   after a Dock reopen on macOS the window was destroyed and every device
 *   event was dropped in silence. The parameter is kept so the ~20 suites that
 *   pass a stand-in window still compile.
 */
export function registerDeviceHandlers(_mainWindow: BrowserWindow): void {
  log.info("[DeviceHandlers] Registering device detection handlers");

  // Forward device events to renderer
  deviceDetectionService.on("device-connected", (device: iOSDevice) => {
    log.info(
      `[DeviceHandlers] Forwarding device-connected event for: ${device.name}`,
    );
    sendToMainWindow("device:connected", device);
  });

  deviceDetectionService.on("device-disconnected", (device: iOSDevice) => {
    log.info(
      `[DeviceHandlers] Forwarding device-disconnected event for: ${device.name}`,
    );
    sendToMainWindow("device:disconnected", device);
  });

  // ===== IPC HANDLERS =====

  /**
   * List all currently connected devices
   */
  ipcMain.handle("device:list", async (): Promise<ListDevicesResponse> => {
    try {
      const devices = deviceDetectionService.getConnectedDevices();
      return {
        success: true,
        devices,
      };
    } catch (error) {
      log.error("[DeviceHandlers] Error listing devices:", error);
      // BACKLOG-1631: Breadcrumb for IPC handler errors
      Sentry.addBreadcrumb({
        category: "iphone.ipc",
        message: "Device handler error",
        data: { handler: "device:list", error: (error as Error).message },
      });
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Start device detection polling
   */
  ipcMain.handle(
    "device:start-detection",
    async (): Promise<DeviceResponse> => {
      try {
        deviceDetectionService.start();
        log.info("[DeviceHandlers] Device detection started");
        return { success: true };
      } catch (error) {
        log.error("[DeviceHandlers] Error starting device detection:", error);
        // BACKLOG-1631: Breadcrumb for IPC handler errors
        Sentry.addBreadcrumb({
          category: "iphone.ipc",
          message: "Device handler error",
          data: { handler: "device:start-detection", error: (error as Error).message },
        });
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    },
  );

  /**
   * Stop device detection polling
   */
  ipcMain.handle("device:stop-detection", async (): Promise<DeviceResponse> => {
    try {
      deviceDetectionService.stop();
      log.info("[DeviceHandlers] Device detection stopped");
      return { success: true };
    } catch (error) {
      log.error("[DeviceHandlers] Error stopping device detection:", error);
      // BACKLOG-1631: Breadcrumb for IPC handler errors
      Sentry.addBreadcrumb({
        category: "iphone.ipc",
        message: "Device handler error",
        data: { handler: "device:stop-detection", error: (error as Error).message },
      });
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Check if libimobiledevice tools are available
   */
  ipcMain.handle(
    "device:check-availability",
    async (): Promise<DeviceResponse & { available?: boolean }> => {
      try {
        const available =
          await deviceDetectionService.checkLibimobiledeviceAvailable();
        return {
          success: true,
          available,
        };
      } catch (error) {
        log.error("[DeviceHandlers] Error checking availability:", error);
        // BACKLOG-1631: Breadcrumb for IPC handler errors
        Sentry.addBreadcrumb({
          category: "iphone.ipc",
          message: "Device handler error",
          data: { handler: "device:check-availability", error: (error as Error).message },
        });
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    },
  );

  /**
   * BACKLOG-1582: Request trust/pairing with a device.
   * Triggers the "Trust This Computer?" prompt on the iPhone.
   */
  ipcMain.handle("device:request-trust", async (_event, udid: string) => {
    try {
      return await deviceDetectionService.pairDevice(udid);
    } catch (error) {
      log.error("[DeviceHandlers] Error requesting trust:", error);
      // BACKLOG-1631: Breadcrumb for IPC handler errors
      Sentry.addBreadcrumb({
        category: "iphone.ipc",
        message: "Device handler error",
        data: { handler: "device:request-trust", error: (error as Error).message },
      });
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // Forward device-needs-trust events to renderer
  deviceDetectionService.on("device-needs-trust", (data: { udid: string; reason?: "locked" | "trust_pending" | "unknown" }) => {
    log.info(`[DeviceHandlers] Device needs trust: ${data.udid}`);
    sendToMainWindow("device:needs-trust", data);
  });

  // BACKLOG-1620/1621: Forward tools-missing event to renderer
  deviceDetectionService.on("tools-missing", () => {
    log.warn("[DeviceHandlers] Forwarding tools-missing event to renderer");
    sendToMainWindow("device:tools-missing");
  });

  // BACKLOG-1621: Forward tools-available event when tools are installed mid-session
  deviceDetectionService.on("tools-available", () => {
    log.info("[DeviceHandlers] Forwarding tools-available event to renderer");
    sendToMainWindow("device:tools-available");
  });

  /**
   * BACKLOG-1582: Run device detection diagnostics on demand.
   * Returns actionable info about why devices aren't detected.
   */
  ipcMain.handle("device:run-diagnostics", async () => {
    try {
      const result = await deviceDetectionService.runDiagnosticChain();
      return { success: true, ...result };
    } catch (error) {
      log.error("[DeviceHandlers] Error running diagnostics:", error);
      // BACKLOG-1631: Breadcrumb for IPC handler errors
      Sentry.addBreadcrumb({
        category: "iphone.ipc",
        message: "Device handler error",
        data: { handler: "device:run-diagnostics", error: (error as Error).message },
      });
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  log.info("[DeviceHandlers] Device handlers registered successfully");
}

/**
 * Cleanup function to stop device detection on app quit.
 * Should be called when the app is shutting down.
 */
export function cleanupDeviceHandlers(): void {
  log.info("[DeviceHandlers] Cleaning up device detection");
  deviceDetectionService.stop();
}
