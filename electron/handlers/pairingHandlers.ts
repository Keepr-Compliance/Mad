// ============================================
// PAIRING IPC HANDLERS
// Handles QR code generation and device pairing
// for the Android companion app
// ============================================

import { ipcMain } from "electron";
import log from "electron-log";
import { pairingService } from "../services/pairingService";
import type { PairingQRResult, PairingStatus } from "../services/pairingService";

/**
 * Response type for pairing-related IPC handlers
 */
interface PairingResponse {
  success: boolean;
  error?: string;
}

/**
 * Registers all pairing-related IPC handlers.
 *
 * Channels:
 * - pairing:generate-qr → Generates a QR code data URL + pairing info
 * - pairing:get-status → Returns current pairing status (paired devices)
 * - pairing:disconnect → Removes a paired device by deviceId
 */
export function registerPairingHandlers(): void {
  log.info("[PairingHandlers] Registering pairing handlers");

  /**
   * Generate a QR code for pairing with the Android companion app.
   * Returns a data URL (base64-encoded PNG) and the pairing info.
   */
  ipcMain.handle(
    "pairing:generate-qr",
    async (
      _event: Electron.IpcMainInvokeEvent,
      userId?: string,
    ): Promise<PairingResponse & { result?: PairingQRResult }> => {
      try {
        // BACKLOG-2224: forward the desktop's logged-in user id so the QR can
        // embed a SHA-256 hash of it for the phone-side account-match pre-check.
        const result = await pairingService.generateQR(userId);
        return { success: true, result };
      } catch (error) {
        log.error("[PairingHandlers] Error generating QR code:", error);
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    },
  );

  /**
   * Get the current pairing status including all paired devices.
   */
  ipcMain.handle(
    "pairing:get-status",
    async (): Promise<PairingResponse & { status?: PairingStatus }> => {
      try {
        const status = pairingService.getStatus();
        return { success: true, status };
      } catch (error) {
        log.error("[PairingHandlers] Error getting status:", error);
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    },
  );

  /**
   * Disconnect a paired device by its deviceId.
   */
  ipcMain.handle(
    "pairing:disconnect",
    async (
      _event: Electron.IpcMainInvokeEvent,
      deviceId: string,
    ): Promise<PairingResponse> => {
      try {
        const wasRemoved = pairingService.disconnect(deviceId);
        if (!wasRemoved) {
          return {
            success: false,
            error: `Device not found: ${deviceId}`,
          };
        }
        return { success: true };
      } catch (error) {
        log.error("[PairingHandlers] Error disconnecting device:", error);
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    },
  );

  log.info("[PairingHandlers] Pairing handlers registered successfully");
}

/**
 * Cleanup function to disconnect all devices on app quit.
 */
export function cleanupPairingHandlers(): void {
  log.info("[PairingHandlers] Cleaning up pairing sessions");
  pairingService.disconnectAll();
}
