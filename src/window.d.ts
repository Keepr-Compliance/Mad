/**
 * Window API type definitions
 * Extends the global Window interface with Electron IPC APIs
 *
 * The `WindowApi` type (for `window.api`) is defined in electron/types/ipc/window-api.ts
 * and composed from domain-specific sub-interfaces. This file imports it and wires it
 * into the global `Window` interface so renderer code can use `window.api.*`.
 *
 * The legacy `ElectronAPI` interface (for `window.electron`) is still defined here
 * for backward compatibility.
 */

import type { WindowApi } from "../electron/types/ipc/window-api";
import type { GetConversationsResult } from "./hooks/useConversations";
import type { iOSDevice, BackupProgress } from "./types/iphone";
import type { FolderExportProgress } from "../electron/types/ipc";

/**
 * Legacy electron namespace (maintained for backward compatibility)
 * Exposed via contextBridge in preload.js
 */
interface ElectronAPI {
  // Platform detection
  platform: "darwin" | "win32" | "linux" | string;

  // App Info
  getAppInfo: () => Promise<{ version: string; name: string }>;
  getMacOSVersion: () => Promise<{ version: string }>;
  checkAppLocation: () => Promise<{ inApplications: boolean; path: string }>;

  // Permissions
  checkPermissions: () => Promise<Record<string, unknown>>;
  triggerFullDiskAccess: () => Promise<{ granted: boolean }>;
  requestPermissions: () => Promise<Record<string, unknown>>;
  requestContactsPermission: () => Promise<{ granted: boolean }>;
  openSystemSettings: () => Promise<{ success: boolean }>;

  // Conversations (iMessage)
  getConversations: () => Promise<GetConversationsResult>;
  getMessages: (chatId: string) => Promise<unknown[]>;

  // Transactions
  transactions: {
    scan: () => Promise<{ success: boolean }>;
    getAll: () => Promise<unknown[]>;
    /** BACKLOG-1124: Lightweight count query for pending auto-detected transactions */
    getPendingCount: (userId: string) => Promise<{ success: boolean; count: number; error?: string }>;
    update: (id: string, data: unknown) => Promise<{ success: boolean }>;
    delete: (id: string) => Promise<{ success: boolean }>;
    bulkDelete: (transactionIds: string[]) => Promise<{ success: boolean; deletedCount?: number; error?: string }>;
    bulkUpdateStatus: (transactionIds: string[], status: "pending" | "active" | "closed" | "rejected") => Promise<{ success: boolean; updatedCount?: number; error?: string }>;
  };
  onTransactionScanProgress: (
    callback: (progress: unknown) => void,
  ) => () => void;
  onExportFolderProgress: (
    callback: (progress: FolderExportProgress) => void,
  ) => () => void;

  // File System
  openFolder: (folderPath: string) => Promise<{ success: boolean }>;

  // Auto-Update Event Listeners
  onUpdateAvailable: (callback: (info: unknown) => void) => () => void;
  onUpdateProgress: (callback: (progress: unknown) => void) => () => void;
  onUpdateDownloaded: (callback: (info: unknown) => void) => () => void;
  installUpdate: () => void;
  checkForUpdates: () => Promise<{
    updateAvailable: boolean;
    version?: string;
    currentVersion: string;
    error?: string;
    translocationDetected?: boolean;
  }>;
  /** Fires when macOS App Translocation is detected (app not in /Applications) */
  onTranslocationDetected: (callback: () => void) => () => void;

  // Outlook Integration
  outlookInitialize: () => Promise<{ success: boolean; error?: string }>;
  outlookAuthenticate: () => Promise<{ success: boolean; error?: string }>;
  outlookIsAuthenticated: () => Promise<boolean>;
  outlookGetUserEmail: () => Promise<string | null>;
  outlookSignout: () => Promise<{ success: boolean }>;
  onDeviceCode: (callback: (info: unknown) => void) => () => void;
  onExportProgress: (callback: (progress: unknown) => void) => () => void;

  // iOS Device Detection (Windows only)
  device?: {
    startDetection: () => void;
    stopDetection: () => void;
    onConnected: (
      callback: (device: iOSDevice) => void,
    ) => (() => void) | undefined;
    onDisconnected: (callback: () => void) => (() => void) | undefined;
    onToolsMissing?: (cb: () => void) => () => void;
    onToolsAvailable?: (cb: () => void) => () => void;
  };

  // iOS Backup Management (Windows only)
  backup?: {
    start: (options: { udid: string }) => Promise<{
      success: boolean;
      error?: string;
    }>;
    submitPassword: (options: { udid: string; password: string }) => Promise<{
      success: boolean;
      error?: string;
    }>;
    cancel: () => Promise<void>;
    onProgress: (
      callback: (progress: BackupProgress) => void,
    ) => (() => void) | undefined;
    /** Check backup status for a specific device (last sync time, size, etc.) */
    checkStatus?: (udid: string) => Promise<{
      success: boolean;
      exists?: boolean;
      isComplete?: boolean;
      isCorrupted?: boolean;
      lastSyncTime?: string | null;
      sizeBytes?: number;
      error?: string;
    }>;
  };

  // Apple Driver Management (Windows only)
  drivers: {
    /** Check if Apple Mobile Device Support drivers are installed */
    checkApple: () => Promise<{
      installed: boolean;
      version?: string;
      serviceRunning: boolean;
      error?: string;
    }>;
    /** Check if bundled Apple drivers are available in the app */
    hasBundled: () => Promise<{ hasBundled: boolean }>;
    /** Install Apple Mobile Device Support drivers (requires user consent) */
    installApple: () => Promise<{
      success: boolean;
      cancelled?: boolean;
      error?: string;
      rebootRequired?: boolean;
    }>;
    /** Open iTunes in Microsoft Store for manual installation */
    openITunesStore: () => Promise<{ success: boolean; error?: string }>;
    /** Check if a driver update is available */
    checkUpdate: () => Promise<{
      updateAvailable: boolean;
      installedVersion: string | null;
      bundledVersion: string | null;
    }>;
  };
}

// Augment the global Window interface
declare global {
  interface Window {
    electron: ElectronAPI;
    api: WindowApi;
  }
}

export {};
