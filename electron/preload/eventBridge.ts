/**
 * Event Bridge
 * Subscribe to asynchronous events from the main process
 */

import { ipcRenderer, IpcRendererEvent } from "electron";
import type { FolderExportProgress } from "../types/ipc";

export const eventBridge = {
  /**
   * Listens for Google login completion events
   * @param callback - Callback function to handle login result
   * @returns Cleanup function to remove listener
   */
  onGoogleLoginComplete: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("google:login-complete", listener);
    return () => ipcRenderer.removeListener("google:login-complete", listener);
  },

  /**
   * Listens for Google login pending events (OAuth succeeded, needs keychain setup)
   * @param callback - Callback function to handle pending login data
   * @returns Cleanup function to remove listener
   */
  onGoogleLoginPending: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("google:login-pending", listener);
    return () => ipcRenderer.removeListener("google:login-pending", listener);
  },

  /**
   * Listens for Google login cancelled events (user closed popup)
   * @param callback - Callback function to handle cancellation
   * @returns Cleanup function to remove listener
   */
  onGoogleLoginCancelled: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("google:login-cancelled", listener);
    return () => ipcRenderer.removeListener("google:login-cancelled", listener);
  },

  /**
   * Listens for Google mailbox connection events
   * @param callback - Callback function to handle connection result
   * @returns Cleanup function to remove listener
   */
  onGoogleMailboxConnected: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("google:mailbox-connected", listener);
    return () =>
      ipcRenderer.removeListener("google:mailbox-connected", listener);
  },

  /**
   * Listens for Google mailbox connection cancelled events (user closed popup)
   * @param callback - Callback function to handle cancellation
   * @returns Cleanup function to remove listener
   */
  onGoogleMailboxCancelled: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("google:mailbox-cancelled", listener);
    return () =>
      ipcRenderer.removeListener("google:mailbox-cancelled", listener);
  },

  /**
   * Listens for Microsoft login completion events
   * @param callback - Callback function to handle login result
   * @returns Cleanup function to remove listener
   */
  onMicrosoftLoginComplete: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("microsoft:login-complete", listener);
    return () =>
      ipcRenderer.removeListener("microsoft:login-complete", listener);
  },

  /**
   * Listens for Microsoft login pending events (OAuth succeeded, needs keychain setup)
   * @param callback - Callback function to handle pending login data
   * @returns Cleanup function to remove listener
   */
  onMicrosoftLoginPending: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("microsoft:login-pending", listener);
    return () =>
      ipcRenderer.removeListener("microsoft:login-pending", listener);
  },

  /**
   * Listens for Microsoft login cancelled events (user closed popup)
   * @param callback - Callback function to handle cancellation
   * @returns Cleanup function to remove listener
   */
  onMicrosoftLoginCancelled: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("microsoft:login-cancelled", listener);
    return () =>
      ipcRenderer.removeListener("microsoft:login-cancelled", listener);
  },

  /**
   * Listens for Microsoft mailbox connection events
   * @param callback - Callback function to handle connection result
   * @returns Cleanup function to remove listener
   */
  onMicrosoftMailboxConnected: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("microsoft:mailbox-connected", listener);
    return () =>
      ipcRenderer.removeListener("microsoft:mailbox-connected", listener);
  },

  /**
   * Listens for Microsoft mailbox connection cancelled events (user closed popup)
   * @param callback - Callback function to handle cancellation
   * @returns Cleanup function to remove listener
   */
  onMicrosoftMailboxCancelled: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("microsoft:mailbox-cancelled", listener);
    return () =>
      ipcRenderer.removeListener("microsoft:mailbox-cancelled", listener);
  },

  /**
   * Listens for pre-DB Google mailbox connection events (returns tokens)
   * @param callback - Callback function to handle connection result with tokens
   * @returns Cleanup function to remove listener
   */
  onGoogleMailboxPendingConnected: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("google:mailbox-pending-connected", listener);
    return () =>
      ipcRenderer.removeListener("google:mailbox-pending-connected", listener);
  },

  /**
   * Listens for pre-DB Google mailbox connection cancelled events
   * @param callback - Callback function to handle cancellation
   * @returns Cleanup function to remove listener
   */
  onGoogleMailboxPendingCancelled: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("google:mailbox-pending-cancelled", listener);
    return () =>
      ipcRenderer.removeListener("google:mailbox-pending-cancelled", listener);
  },

  /**
   * Listens for pre-DB Microsoft mailbox connection events (returns tokens)
   * @param callback - Callback function to handle connection result with tokens
   * @returns Cleanup function to remove listener
   */
  onMicrosoftMailboxPendingConnected: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("microsoft:mailbox-pending-connected", listener);
    return () =>
      ipcRenderer.removeListener(
        "microsoft:mailbox-pending-connected",
        listener,
      );
  },

  /**
   * Listens for pre-DB Microsoft mailbox connection cancelled events
   * @param callback - Callback function to handle cancellation
   * @returns Cleanup function to remove listener
   */
  onMicrosoftMailboxPendingCancelled: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("microsoft:mailbox-pending-cancelled", listener);
    return () =>
      ipcRenderer.removeListener(
        "microsoft:mailbox-pending-cancelled",
        listener,
      );
  },

  /**
   * Listens for Google mailbox disconnection events
   * @param callback - Callback function to handle disconnection result
   * @returns Cleanup function to remove listener
   */
  onGoogleMailboxDisconnected: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("google:mailbox-disconnected", listener);
    return () =>
      ipcRenderer.removeListener("google:mailbox-disconnected", listener);
  },

  /**
   * Listens for Microsoft mailbox disconnection events
   * @param callback - Callback function to handle disconnection result
   * @returns Cleanup function to remove listener
   */
  onMicrosoftMailboxDisconnected: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("microsoft:mailbox-disconnected", listener);
    return () =>
      ipcRenderer.removeListener("microsoft:mailbox-disconnected", listener);
  },

  /**
   * BACKLOG-1832: Fires when a background auto-sync starts for a specific transaction.
   * The renderer uses this to show a "fetching emails…" indicator while the sync is
   * in flight (driven by the create trigger — the primary scenario where emails are
   * empty immediately after a new transaction is created).
   * @param callback - Receives { transactionId, reason }
   * @returns Cleanup function to remove listener
   */
  onTransactionAutoSyncStarted: (callback: (data: { transactionId: string; reason: string }) => void) => {
    const listener = (_: IpcRendererEvent, data: { transactionId: string; reason: string }) => callback(data);
    ipcRenderer.on("transactions:auto-sync-started", listener);
    return () => ipcRenderer.removeListener("transactions:auto-sync-started", listener);
  },

  /**
   * BACKLOG-1832: Fires when a background auto-sync completes for a specific transaction.
   * The renderer uses this to auto-refresh the email list and tab count badge.
   * @param callback - Receives { transactionId, reason, ran, windowsFetched? }
   * @returns Cleanup function to remove listener
   */
  onTransactionAutoSyncComplete: (callback: (data: { transactionId: string; reason: string; ran: boolean; windowsFetched?: number }) => void) => {
    const listener = (
      _: IpcRendererEvent,
      data: { transactionId: string; reason: string; ran: boolean; windowsFetched?: number },
    ) => callback(data);
    ipcRenderer.on("transactions:auto-sync-complete", listener);
    return () => ipcRenderer.removeListener("transactions:auto-sync-complete", listener);
  },

  /**
   * Listens for transaction scan progress updates
   * @param callback - Callback function to handle progress updates
   * @returns Cleanup function to remove listener
   */
  onTransactionScanProgress: (callback: (progress: unknown) => void) => {
    const listener = (_: IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on("transactions:scan-progress", listener);
    return () =>
      ipcRenderer.removeListener("transactions:scan-progress", listener);
  },

  /**
   * Listens for folder export progress updates
   * @param callback - Callback function to handle progress updates
   * @returns Cleanup function to remove listener
   */
  onExportFolderProgress: (callback: (progress: FolderExportProgress) => void) => {
    const listener = (_: IpcRendererEvent, progress: FolderExportProgress) => callback(progress);
    ipcRenderer.on("transactions:export-folder-progress", listener);
    return () =>
      ipcRenderer.removeListener("transactions:export-folder-progress", listener);
  },

  /**
   * Listens for backup progress updates
   * @param callback - Callback function to handle progress updates
   * @returns Cleanup function to remove listener
   */
  onBackupProgress: (
    callback: (progress: { phase: string; percent: number }) => void,
  ) => {
    const listener = (
      _: IpcRendererEvent,
      progress: { phase: string; percent: number },
    ) => callback(progress);
    ipcRenderer.on("backup:progress", listener);
    return () => ipcRenderer.removeListener("backup:progress", listener);
  },

  /**
   * Listens for backup password required events
   * @param callback - Callback function when password is needed
   * @returns Cleanup function to remove listener
   */
  onBackupPasswordRequired: (callback: (data: { udid: string }) => void) => {
    const listener = (_: IpcRendererEvent, data: { udid: string }) =>
      callback(data);
    ipcRenderer.on("backup:password-required", listener);
    return () =>
      ipcRenderer.removeListener("backup:password-required", listener);
  },

  // ==========================================
  // DEEP LINK AUTH EVENTS (TASK-1500)
  // ==========================================

  /**
   * Listens for deep link authentication callback events
   * Fired when the app receives a keepr://callback URL with tokens
   * @param callback - Callback function to handle auth tokens
   * @returns Cleanup function to remove listener
   */
  onDeepLinkAuthCallback: (
    callback: (data: { accessToken: string; refreshToken: string }) => void,
  ) => {
    const listener = (
      _: IpcRendererEvent,
      data: { accessToken: string; refreshToken: string },
    ) => callback(data);
    ipcRenderer.on("auth:deep-link-callback", listener);
    return () =>
      ipcRenderer.removeListener("auth:deep-link-callback", listener);
  },

  /**
   * Listens for deep link authentication error events
   * Fired when the app receives an invalid or incomplete callback URL
   * @param callback - Callback function to handle auth errors
   * @returns Cleanup function to remove listener
   */
  onDeepLinkAuthError: (
    callback: (data: { error: string; code: string }) => void,
  ) => {
    const listener = (
      _: IpcRendererEvent,
      data: { error: string; code: string },
    ) => callback(data);
    ipcRenderer.on("auth:deep-link-error", listener);
    return () => ipcRenderer.removeListener("auth:deep-link-error", listener);
  },

  // ==========================================
  // DEEP LINK LICENSE EVENTS (TASK-1507)
  // ==========================================

  /**
   * Listens for deep link license blocked events
   * Fired when the user's license is expired, suspended, or otherwise invalid
   * @param callback - Callback function to handle license blocked state
   * @returns Cleanup function to remove listener
   */
  onDeepLinkLicenseBlocked: (
    callback: (data: {
      accessToken: string;
      refreshToken: string;
      userId: string;
      blockReason: string;
      licenseStatus: unknown;
    }) => void,
  ) => {
    const listener = (
      _: IpcRendererEvent,
      data: {
        accessToken: string;
        refreshToken: string;
        userId: string;
        blockReason: string;
        licenseStatus: unknown;
      },
    ) => callback(data);
    ipcRenderer.on("auth:deep-link-license-blocked", listener);
    return () =>
      ipcRenderer.removeListener("auth:deep-link-license-blocked", listener);
  },

  /**
   * Listens for deep link device limit events
   * Fired when device registration fails due to license device limit
   * @param callback - Callback function to handle device limit state
   * @returns Cleanup function to remove listener
   */
  onDeepLinkDeviceLimit: (
    callback: (data: {
      accessToken: string;
      refreshToken: string;
      userId: string;
      licenseStatus: unknown;
    }) => void,
  ) => {
    const listener = (
      _: IpcRendererEvent,
      data: {
        accessToken: string;
        refreshToken: string;
        userId: string;
        licenseStatus: unknown;
      },
    ) => callback(data);
    ipcRenderer.on("auth:deep-link-device-limit", listener);
    return () =>
      ipcRenderer.removeListener("auth:deep-link-device-limit", listener);
  },
};
