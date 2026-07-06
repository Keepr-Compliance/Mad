/**
 * License Bridge
 * Handles license-related IPC calls from renderer to main process
 *
 * SPRINT-062: Added license validation and device registration methods
 */

import { ipcRenderer } from "electron";
import type { LicenseValidationResult } from "../types/license";

// Declared by esbuild at build time: true for dev, false for production
declare const __DEV__: boolean;

// ============================================
// DEV ONLY: License-manipulation methods (BACKLOG-1783)
// ============================================
// SECURITY: These expose license:dev:* channels that let a caller self-upgrade
// entitlements. esbuild replaces `__DEV__` with `false` in packaged builds and
// dead-code-eliminates this block, so production builds never expose them. The
// main-process handlers are guarded in parallel (licenseHandlers via
// `!app.isPackaged`), so these are inert even if somehow present.
const devLicenseMethods = __DEV__
  ? {
      /**
       * DEV ONLY: Toggle AI add-on for testing
       * @param userId - User ID to toggle
       * @param enabled - Whether to enable or disable AI add-on
       * @returns Success status
       */
      devToggleAIAddon: (userId: string, enabled: boolean) =>
        ipcRenderer.invoke("license:dev:toggle-ai-addon", userId, enabled),

      /**
       * DEV ONLY: Set license type for testing
       * @param userId - User ID to update
       * @param licenseType - License type: 'individual', 'team', or 'enterprise'
       * @returns Success status
       */
      devSetLicenseType: (userId: string, licenseType: string) =>
        ipcRenderer.invoke("license:dev:set-license-type", userId, licenseType),
    }
  : {};

export const licenseBridge = {
  /**
   * Gets the current user's license information
   * @returns License data including type, AI addon status, and organization
   */
  get: () => ipcRenderer.invoke("license:get"),

  /**
   * Refreshes the license data from the database
   * @returns Updated license data
   */
  refresh: () => ipcRenderer.invoke("license:refresh"),

  // ============================================
  // SPRINT-062: License Validation Methods
  // ============================================

  /**
   * Validates the user's license status
   * @param userId - User ID to validate
   * @returns License validation result with status, limits, and block reason
   */
  validate: (userId: string): Promise<LicenseValidationResult> =>
    ipcRenderer.invoke("license:validate", userId),

  /**
   * Creates a trial license for a new user
   * @param userId - User ID to create license for
   * @returns License validation result after creation
   */
  create: (userId: string): Promise<LicenseValidationResult> =>
    ipcRenderer.invoke("license:create", userId),

  /**
   * Increments the user's transaction count
   * @param userId - User ID
   * @returns Updated transaction count
   */
  incrementTransactionCount: (userId: string): Promise<number> =>
    ipcRenderer.invoke("license:incrementTransactionCount", userId),

  /**
   * Clears the license cache (call on logout)
   */
  clearCache: (): Promise<void> => ipcRenderer.invoke("license:clearCache"),

  // NOTE (BACKLOG-1783): `canPerformAction` was removed. It forwarded a
  // renderer-supplied (spoofable) LicenseValidationResult to the main process,
  // which echoed an allow/deny decision from that untrusted input. It had no
  // renderer callers. Derive entitlements from the main-owned `validate` result.

  // ============================================
  // SPRINT-062: Device Registration Methods
  // ============================================

  /**
   * Registers the current device for the user
   * @param userId - User ID
   * @returns Registration result with success status
   */
  registerDevice: (userId: string) =>
    ipcRenderer.invoke("device:register", userId),

  /**
   * Lists all registered devices for a user
   * @param userId - User ID
   * @returns Array of registered devices
   */
  listRegisteredDevices: (userId: string) =>
    ipcRenderer.invoke("device:listRegistered", userId),

  /**
   * Deactivates a device
   * @param userId - User ID
   * @param deviceId - Device ID to deactivate
   */
  deactivateDevice: (userId: string, deviceId: string) =>
    ipcRenderer.invoke("device:deactivate", userId, deviceId),

  /**
   * Deletes a device registration
   * @param userId - User ID
   * @param deviceId - Device ID to delete
   */
  deleteDevice: (userId: string, deviceId: string) =>
    ipcRenderer.invoke("device:delete", userId, deviceId),

  /**
   * Gets the current device's ID
   * @returns Device ID string
   */
  getCurrentDeviceId: (): Promise<string> =>
    ipcRenderer.invoke("device:getCurrentId"),

  /**
   * Checks if the current device is registered
   * @param userId - User ID
   * @returns Whether the device is registered
   */
  isDeviceRegistered: (userId: string): Promise<boolean> =>
    ipcRenderer.invoke("device:isRegistered", userId),

  /**
   * Sends a heartbeat to update device last_seen_at
   * @param userId - User ID
   */
  deviceHeartbeat: (userId: string): Promise<void> =>
    ipcRenderer.invoke("device:heartbeat", userId),

  // Spread dev-only methods (empty object in production builds)
  ...devLicenseMethods,
};
