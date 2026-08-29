/**
 * Device Service
 *
 * Service abstraction for device detection, backup, sync, and driver-related API calls.
 * Centralizes all window.api.device, window.api.backup, window.api.drivers,
 * and window.api.sync calls.
 *
 * Note: These APIs are primarily for Windows platform iPhone sync functionality.
 */

import { type ApiResult, getErrorMessage } from "./index";

// ============================================
// DEVICE TYPES
// ============================================

/**
 * Connected iOS device information
 */
export interface Device {
  udid: string;
  name: string;
  productType: string;
  productVersion: string;
  serialNumber: string;
  isConnected: boolean;
}

// ============================================
// BACKUP TYPES
// ============================================

/**
 * Backup capabilities
 */
export interface BackupCapabilities {
  supportsDomainFiltering: boolean;
  supportsIncremental: boolean;
  supportsEncryption: boolean;
  availableDomains: string[];
}

/**
 * Backup progress information
 */
export interface BackupProgress {
  phase: string;
  percentComplete: number;
  currentFile: string | null;
  filesTransferred: number;
  totalFiles: number | null;
  bytesTransferred: number;
  totalBytes: number | null;
  estimatedTimeRemaining: number | null;
}

/**
 * Backup status
 */
export interface BackupStatus {
  isRunning: boolean;
  currentDeviceUdid: string | null;
  progress: BackupProgress | null;
}

/**
 * Backup start options
 */
export interface BackupStartOptions {
  udid: string;
  outputDir?: string;
  forceFullBackup?: boolean;
}

/**
 * Backup with password options
 */
export interface BackupWithPasswordOptions {
  udid: string;
  password: string;
  outputPath?: string;
}

/**
 * Backup result
 */
export interface BackupResult {
  backupPath: string | null;
  duration: number;
  deviceUdid: string;
  isIncremental: boolean;
  /** BACKLOG-2917: `null` when the backup's size could not be measured, never 0. */
  backupSize: number | null;
}

/**
 * Backup list entry
 */
export interface BackupListEntry {
  path: string;
  deviceUdid: string;
  createdAt: Date;
  /** BACKLOG-2917: `null` when the size could not be measured, never 0. */
  size: number | null;
  isEncrypted: boolean;
  iosVersion: string | null;
  deviceName: string | null;
}

// ============================================
// DRIVER TYPES
// ============================================

/**
 * Apple driver status
 */
export interface AppleDriverStatus {
  isInstalled: boolean;
  version: string | null;
  serviceRunning: boolean;
  error: string | null;
}

/**
 * Driver installation result
 */
export interface DriverInstallResult {
  rebootRequired: boolean;
}

// ============================================
// SYNC TYPES
// ============================================

/**
 * Sync start options
 */
export interface SyncStartOptions {
  udid: string;
  password?: string;
  forceFullBackup?: boolean;
}

/**
 * Sync result
 */
export interface SyncResult {
  messages: unknown[];
  contacts: unknown[];
  conversations: unknown[];
  duration: number;
}

/**
 * Sync status
 */
export interface SyncStatus {
  isRunning: boolean;
  phase: string;
}

/**
 * Sync progress
 */
export interface SyncProgress {
  phase: string;
  phaseProgress: number;
  overallProgress: number;
  message: string;
}

/**
 * Device Service
 * Provides a clean abstraction over window.api.device, backup, drivers, and sync
 */
export const deviceService = {
  // ============================================
  // DEVICE DETECTION METHODS
  // ============================================

  /**
   * List connected devices
   */
  async listDevices(): Promise<ApiResult<Device[]>> {
    try {
      if (!window.api.device) {
        return { success: false, error: "Device API not available" };
      }
      const result = await window.api.device.list();
      if (result.success) {
        return { success: true, data: result.devices || [] };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Start device detection polling
   */
  async startDetection(): Promise<ApiResult> {
    try {
      if (!window.api.device) {
        return { success: false, error: "Device API not available" };
      }
      const result = await window.api.device.startDetection();
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Stop device detection polling
   */
  async stopDetection(): Promise<ApiResult> {
    try {
      if (!window.api.device) {
        return { success: false, error: "Device API not available" };
      }
      const result = await window.api.device.stopDetection();
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check if device detection is available
   */
  async checkAvailability(): Promise<ApiResult<{ available: boolean }>> {
    try {
      if (!window.api.device) {
        return { success: true, data: { available: false } };
      }
      const result = await window.api.device.checkAvailability();
      if (result.success) {
        return { success: true, data: { available: result.available || false } };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Subscribe to device connected events
   */
  onDeviceConnected(callback: (device: Device) => void): () => void {
    if (!window.api.device) {
      return () => {};
    }
    return window.api.device.onConnected(callback);
  },

  /**
   * Subscribe to device disconnected events
   */
  onDeviceDisconnected(callback: (device: Device) => void): () => void {
    if (!window.api.device) {
      return () => {};
    }
    return window.api.device.onDisconnected(callback);
  },

  // ============================================
  // BACKUP METHODS
  // ============================================

  /**
   * Get backup capabilities
   */
  async getBackupCapabilities(): Promise<ApiResult<BackupCapabilities>> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.getCapabilities();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Get current backup status
   */
  async getBackupStatus(): Promise<ApiResult<BackupStatus>> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.getStatus();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Start a backup
   */
  async startBackup(options: BackupStartOptions): Promise<ApiResult<BackupResult>> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.start(options);
      if (result.success) {
        return {
          success: true,
          data: {
            backupPath: result.backupPath,
            duration: result.duration,
            deviceUdid: result.deviceUdid,
            isIncremental: result.isIncremental,
            backupSize: result.backupSize,
          },
        };
      }
      return { success: false, error: result.error || "Backup failed" };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Start a backup with encryption password
   */
  async startBackupWithPassword(
    options: BackupWithPasswordOptions
  ): Promise<ApiResult<{ backupPath?: string }>> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.startWithPassword(options);
      if (result.success) {
        return { success: true, data: { backupPath: result.backupPath } };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Cancel the current backup
   */
  async cancelBackup(): Promise<ApiResult> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.cancel();
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * List all backups
   */
  async listBackups(): Promise<ApiResult<BackupListEntry[]>> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.list();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Delete a backup
   */
  async deleteBackup(backupPath: string): Promise<ApiResult> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.delete(backupPath);
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Cleanup old backups
   */
  async cleanupBackups(keepCount?: number): Promise<ApiResult> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.cleanup(keepCount);
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check if device backup is encrypted
   */
  async checkBackupEncryption(
    udid: string
  ): Promise<ApiResult<{ isEncrypted?: boolean; needsPassword?: boolean }>> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.checkEncryption(udid);
      if (result.success) {
        return {
          success: true,
          data: {
            isEncrypted: result.isEncrypted,
            needsPassword: result.needsPassword,
          },
        };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Verify backup password
   */
  async verifyBackupPassword(
    backupPath: string,
    password: string
  ): Promise<ApiResult<{ valid?: boolean }>> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.verifyPassword(backupPath, password);
      if (result.success) {
        return { success: true, data: { valid: result.valid } };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check if a backup is encrypted
   */
  async isBackupEncrypted(
    backupPath: string
  ): Promise<ApiResult<{ isEncrypted?: boolean }>> {
    try {
      if (!window.api.backup) {
        return { success: false, error: "Backup API not available" };
      }
      const result = await window.api.backup.isEncrypted(backupPath);
      if (result.success) {
        return { success: true, data: { isEncrypted: result.isEncrypted } };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Subscribe to backup progress events
   */
  onBackupProgress(callback: (progress: BackupProgress) => void): () => void {
    if (!window.api.backup) {
      return () => {};
    }
    return window.api.backup.onProgress(callback);
  },

  /**
   * Subscribe to backup complete events
   */
  onBackupComplete(
    callback: (result: BackupResult & { success: boolean; error: string | null }) => void
  ): () => void {
    if (!window.api.backup) {
      return () => {};
    }
    return window.api.backup.onComplete(callback);
  },

  /**
   * Subscribe to backup error events
   */
  onBackupError(callback: (error: { message: string }) => void): () => void {
    if (!window.api.backup) {
      return () => {};
    }
    return window.api.backup.onError(callback);
  },

  // ============================================
  // DRIVER METHODS
  // ============================================

  /**
   * Check Apple driver status
   */
  async checkAppleDriver(): Promise<ApiResult<AppleDriverStatus>> {
    try {
      if (!window.api.drivers) {
        return { success: false, error: "Drivers API not available" };
      }
      const result = await window.api.drivers.checkApple();
      return {
        success: true,
        data: {
          isInstalled: result.isInstalled,
          version: result.version,
          serviceRunning: result.serviceRunning,
          error: result.error,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check if bundled drivers are available
   */
  async hasBundledDrivers(): Promise<ApiResult<{ available: boolean }>> {
    try {
      if (!window.api.drivers) {
        return { success: false, error: "Drivers API not available" };
      }
      const result = await window.api.drivers.hasBundled();
      return { success: true, data: { available: result.available } };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Install Apple drivers
   */
  async installAppleDriver(): Promise<ApiResult<DriverInstallResult>> {
    try {
      if (!window.api.drivers) {
        return { success: false, error: "Drivers API not available" };
      }
      const result = await window.api.drivers.installApple();
      if (result.success) {
        return {
          success: true,
          data: { rebootRequired: result.rebootRequired },
        };
      }
      return { success: false, error: result.error || "Driver installation failed" };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Open iTunes store page for manual installation
   */
  async openITunesStore(): Promise<ApiResult> {
    try {
      if (!window.api.drivers) {
        return { success: false, error: "Drivers API not available" };
      }
      const result = await window.api.drivers.openITunesStore();
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  // ============================================
  // SYNC METHODS
  // ============================================

  /**
   * Start iPhone sync
   */
  async startSync(options: SyncStartOptions): Promise<ApiResult<SyncResult>> {
    try {
      if (!window.api.sync) {
        return { success: false, error: "Sync API not available" };
      }
      const result = await window.api.sync.start(options);
      if (result.success) {
        return {
          success: true,
          data: {
            messages: result.messages,
            contacts: result.contacts,
            conversations: result.conversations,
            duration: result.duration,
          },
        };
      }
      return { success: false, error: result.error || "Sync failed" };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Cancel the current sync
   */
  async cancelSync(): Promise<ApiResult> {
    try {
      if (!window.api.sync) {
        return { success: false, error: "Sync API not available" };
      }
      const result = await window.api.sync.cancel();
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Get sync status
   */
  async getSyncStatus(): Promise<ApiResult<SyncStatus>> {
    try {
      if (!window.api.sync) {
        return { success: false, error: "Sync API not available" };
      }
      const result = await window.api.sync.status();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Get devices for sync
   */
  async getSyncDevices(): Promise<ApiResult<Device[]>> {
    try {
      if (!window.api.sync) {
        return { success: false, error: "Sync API not available" };
      }
      const result = await window.api.sync.devices();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Start sync device detection
   */
  async startSyncDetection(intervalMs?: number): Promise<ApiResult> {
    try {
      if (!window.api.sync) {
        return { success: false, error: "Sync API not available" };
      }
      const result = await window.api.sync.startDetection(intervalMs);
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Stop sync device detection
   */
  async stopSyncDetection(): Promise<ApiResult> {
    try {
      if (!window.api.sync) {
        return { success: false, error: "Sync API not available" };
      }
      const result = await window.api.sync.stopDetection();
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Subscribe to sync progress events
   */
  onSyncProgress(callback: (progress: SyncProgress) => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onProgress(callback);
  },

  /**
   * Subscribe to sync phase change events
   */
  onSyncPhase(callback: (phase: string) => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onPhase(callback);
  },

  /**
   * Subscribe to sync device connected events
   */
  onSyncDeviceConnected(callback: (device: unknown) => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onDeviceConnected(callback);
  },

  /**
   * Subscribe to sync device disconnected events
   */
  onSyncDeviceDisconnected(callback: (device: unknown) => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onDeviceDisconnected(callback);
  },

  /**
   * Subscribe to password required events
   */
  onPasswordRequired(callback: () => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onPasswordRequired(callback);
  },

  /**
   * Subscribe to sync error events
   */
  onSyncError(callback: (error: { message: string }) => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onError(callback);
  },

  /**
   * Subscribe to sync complete events
   */
  onSyncComplete(callback: (result: unknown) => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onComplete(callback);
  },

  /**
   * Subscribe to waiting for passcode events
   */
  onWaitingForPasscode(callback: () => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onWaitingForPasscode(callback);
  },

  /**
   * Subscribe to passcode entered events
   */
  onPasscodeEntered(callback: () => void): () => void {
    if (!window.api.sync) {
      return () => {};
    }
    return window.api.sync.onPasscodeEntered(callback);
  },
};

export default deviceService;
