/**
 * Pairing Bridge
 * Handles QR code generation and device pairing for Android companion app
 */

import { ipcRenderer } from "electron";

export const pairingBridge = {
  /**
   * Generates a QR code for pairing with the Android companion app.
   * @param userId - The desktop's logged-in Supabase user id (BACKLOG-2224).
   *   Forwarded so the QR can embed a SHA-256 hash of it for the phone-side
   *   account-match pre-check. Optional — omitted when logged out.
   * @returns QR code data URL and pairing info
   */
  generateQR: (userId?: string) =>
    ipcRenderer.invoke("pairing:generate-qr", userId),

  /**
   * Gets the current pairing status including paired devices.
   * @returns Pairing status
   */
  getStatus: () => ipcRenderer.invoke("pairing:get-status"),

  /**
   * Disconnects a paired device.
   * @param deviceId - The device to disconnect
   * @returns Disconnect result
   */
  disconnect: (deviceId: string) =>
    ipcRenderer.invoke("pairing:disconnect", deviceId),
};
