/**
 * Outlook Bridge (Legacy)
 * Outlook integration methods for Microsoft 365
 */

import { ipcRenderer, IpcRendererEvent } from "electron";
import type {
  UpdateErrorPayload,
  UpdateErrorType,
} from "../types/ipc/window-api-services";

export const outlookBridge = {
  /**
   * Initializes Outlook integration
   * @returns Initialization result
   */
  initialize: () => ipcRenderer.invoke("outlook-initialize"),

  /**
   * Authenticates with Outlook/Microsoft 365
   * @returns Authentication result
   */
  authenticate: () => ipcRenderer.invoke("outlook-authenticate"),

  /**
   * Checks if user is authenticated with Outlook
   * @returns Authentication status
   */
  isAuthenticated: () => ipcRenderer.invoke("outlook-is-authenticated"),

  /**
   * Gets authenticated user's email address
   * @returns User email
   */
  getUserEmail: () => ipcRenderer.invoke("outlook-get-user-email"),

  /**
   * Exports emails for specified contacts
   * @param contacts - Contacts to export emails for
   * @returns Export result
   */
  exportEmails: (contacts: unknown[]) =>
    ipcRenderer.invoke("outlook-export-emails", contacts),

  /**
   * Signs out from Outlook
   * @returns Sign out result
   */
  signout: () => ipcRenderer.invoke("outlook-signout"),

  /**
   * Listens for device code during authentication flow
   * @param callback - Callback with device code info
   * @returns Cleanup function
   */
  onDeviceCode: (callback: (info: unknown) => void) => {
    const listener = (_: IpcRendererEvent, info: unknown) => callback(info);
    ipcRenderer.on("device-code-received", listener);
    return () => ipcRenderer.removeListener("device-code-received", listener);
  },

  /**
   * Listens for email export progress
   * @param callback - Callback with progress info
   * @returns Cleanup function
   */
  onExportProgress: (callback: (progress: unknown) => void) => {
    const listener = (_: IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on("export-progress", listener);
    return () => ipcRenderer.removeListener("export-progress", listener);
  },
};

/**
 * Update Bridge (Legacy)
 * Auto-update event listeners
 */
export const updateBridge = {
  /**
   * Listens for app update availability
   * @param callback - Callback with update info
   * @returns Cleanup function
   */
  onAvailable: (callback: (info: unknown) => void) => {
    const listener = (_: IpcRendererEvent, info: unknown) => callback(info);
    ipcRenderer.on("update-available", listener);
    return () => ipcRenderer.removeListener("update-available", listener);
  },

  /**
   * Listens for auto-updater errors (BACKLOG-1641 / BACKLOG-1903)
   * Fires when download/verification fails (e.g. sha512 checksum mismatch).
   *
   * BACKLOG-1903: the payload is now a structured object
   * `{ message, errorType, sentryEventId }`. Older/other emitters may still send
   * a bare string, so the payload type is `string | UpdateErrorPayload`; the
   * renderer must guard with a typeof check before reading `.message`.
   *
   * @param callback - Callback with the error payload (string or object)
   * @returns Cleanup function
   */
  onError: (callback: (error: UpdateErrorPayload | string) => void) => {
    const listener = (_: IpcRendererEvent, error: UpdateErrorPayload | string) =>
      callback(error);
    ipcRenderer.on("update-error", listener);
    return () => ipcRenderer.removeListener("update-error", listener);
  },

  /**
   * Listens for update download progress
   * @param callback - Callback with progress info
   * @returns Cleanup function
   */
  onProgress: (callback: (progress: unknown) => void) => {
    const listener = (_: IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on("update-progress", listener);
    return () => ipcRenderer.removeListener("update-progress", listener);
  },

  /**
   * Listens for update download completion
   * @param callback - Callback with update info
   * @returns Cleanup function
   */
  onDownloaded: (callback: (info: unknown) => void) => {
    const listener = (_: IpcRendererEvent, info: unknown) => callback(info);
    ipcRenderer.on("update-downloaded", listener);
    return () => ipcRenderer.removeListener("update-downloaded", listener);
  },

  /**
   * Installs downloaded update and restarts app
   */
  install: () => ipcRenderer.send("install-update"),

  /**
   * Manually check for updates
   * @returns Update check result
   */
  checkForUpdates: (): Promise<{
    updateAvailable: boolean;
    version?: string;
    currentVersion: string;
    error?: string;
    translocationDetected?: boolean;
  }> => ipcRenderer.invoke("app:check-for-updates"),

  /**
   * Listens for macOS App Translocation detection.
   * Fired when the app is running from a quarantined/translocated path
   * and cannot auto-update. The user should move the app to /Applications.
   * @param callback - Callback invoked when translocation is detected
   * @returns Cleanup function
   */
  onTranslocationDetected: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("app-translocation-detected", listener);
    return () => ipcRenderer.removeListener("app-translocation-detected", listener);
  },

  /**
   * BACKLOG-1903 DEV-ONLY: deterministically trigger an updater failure of a
   * given fingerprint class through the real error handler (QA harness).
   * The backing IPC is only registered in dev (`!app.isPackaged`); in packaged
   * builds this invoke rejects (no handler), which is the intended inert state.
   * @param errorClass One of the UpdaterErrorType fingerprint classes.
   */
  simulateUpdateError: (
    errorClass?: UpdateErrorType,
  ): Promise<{ success: boolean; simulated: string }> =>
    ipcRenderer.invoke("app:__simulate-update-error", errorClass),
};
