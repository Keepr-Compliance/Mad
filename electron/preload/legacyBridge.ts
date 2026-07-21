/**
 * Legacy Electron Bridge
 * @deprecated - Maintained for backward compatibility with older code
 * New code should use the 'api' namespace instead
 */

import { ipcRenderer } from "electron";
import { outlookBridge, updateBridge } from "./outlookBridge";
import { driverBridge } from "./deviceBridge";

export const legacyElectronBridge = {
  /**
   * Current platform identifier from Node.js process.platform
   */
  platform: process.platform,

  /**
   * Gets application info (version, name, etc.)
   * @returns App info
   */
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),

  /**
   * Gets macOS version information
   * @returns macOS version
   */
  getMacOSVersion: () => ipcRenderer.invoke("get-macos-version"),

  /**
   * Checks if app is in /Applications folder
   * @returns Location check result
   */
  checkAppLocation: () => ipcRenderer.invoke("check-app-location"),

  /**
   * Legacy permission check method
   * @returns Permission statuses
   */
  checkPermissions: () => ipcRenderer.invoke("check-permissions"),

  /**
   * Triggers Full Disk Access check
   * @returns Access status
   */
  triggerFullDiskAccess: () => ipcRenderer.invoke("trigger-full-disk-access"),

  /**
   * Legacy permission request method
   * @returns Permission request result
   */
  requestPermissions: () => ipcRenderer.invoke("request-permissions"),

  /**
   * Requests contacts permission
   * @returns Permission result
   */
  requestContactsPermission: () =>
    ipcRenderer.invoke("request-contacts-permission"),

  /**
   * Opens macOS System Settings/Preferences
   * @returns Open result
   */
  openSystemSettings: () => ipcRenderer.invoke("open-system-settings"),

  /**
   * BACKLOG-1842: Cleanly relaunch the app (no data wipe) after an FDA grant.
   * No-op under the E2E harness.
   * @returns { relaunched } — false when suppressed (E2E/dev harness)
   */
  relaunchApp: () => ipcRenderer.invoke("relaunch-app"),

  /**
   * BACKLOG-1842 (resume-at-step): persist a cloud resume marker just before
   * the FDA-grant relaunch so the fresh process resumes onboarding at the
   * exact step instead of replaying it.
   */
  saveOnboardingResumeMarker: (payload: { userId: string }) =>
    ipcRenderer.invoke("save-onboarding-resume-marker", payload),

  /**
   * BACKLOG-1842 (resume-at-step): read-and-clear the cloud resume marker
   * (single-use). Called once early on startup.
   */
  consumeOnboardingResumeMarker: (payload: { userId: string }) =>
    ipcRenderer.invoke("consume-onboarding-resume-marker", payload),

  /**
   * Gets conversations — from macOS chat.db or local messages table
   * depending on the user's phone type (BACKLOG-1470).
   * @param userId - Optional user ID for phone type lookup
   * @returns List of conversations
   */
  getConversations: (userId?: string) => ipcRenderer.invoke("get-conversations", userId),

  /**
   * Gets messages for a specific chat
   * @param chatId - Chat ID to get messages for
   * @returns List of messages
   */
  getMessages: (chatId: string) => ipcRenderer.invoke("get-messages", chatId),

  /**
   * Opens a folder in Finder
   * @param folderPath - Path to folder to open
   * @returns Open result
   */
  openFolder: (folderPath: string) =>
    ipcRenderer.invoke("open-folder", folderPath),

  // Auto-update event listeners
  onUpdateAvailable: (callback: (info: unknown) => void) =>
    updateBridge.onAvailable(callback),

  onUpdateProgress: (callback: (progress: unknown) => void) =>
    updateBridge.onProgress(callback),

  onUpdateDownloaded: (callback: (info: unknown) => void) =>
    updateBridge.onDownloaded(callback),

  installUpdate: () => updateBridge.install(),

  checkForUpdates: () => updateBridge.checkForUpdates(),

  // Outlook integration methods
  outlookInitialize: () => outlookBridge.initialize(),
  outlookAuthenticate: () => outlookBridge.authenticate(),
  outlookIsAuthenticated: () => outlookBridge.isAuthenticated(),
  outlookGetUserEmail: () => outlookBridge.getUserEmail(),
  outlookSignout: () => outlookBridge.signout(),

  onDeviceCode: (callback: (info: unknown) => void) =>
    outlookBridge.onDeviceCode(callback),

  onExportProgress: (callback: (progress: unknown) => void) =>
    outlookBridge.onExportProgress(callback),

  // Apple driver methods (Windows only)
  drivers: {
    checkApple: () => driverBridge.checkApple(),
    hasBundled: () => driverBridge.hasBundled(),
    installApple: () => driverBridge.installApple(),
    openITunesStore: () => driverBridge.openITunesStore(),
    checkUpdate: () => driverBridge.checkUpdate(),
  },
};
