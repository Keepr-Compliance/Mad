/**
 * WindowApi Platform sub-interfaces
 * Device detection, backup, drivers, and sync (primarily Windows)
 */

/**
 * Device detection methods (Windows)
 */
export interface WindowApiDevice {
  list: () => Promise<{
    success: boolean;
    devices?: Array<{
      udid: string;
      name: string;
      productType: string;
      productVersion: string;
      serialNumber: string;
      isConnected: boolean;
    }>;
    error?: string;
  }>;
  startDetection: () => Promise<{ success: boolean; error?: string }>;
  stopDetection: () => Promise<{ success: boolean; error?: string }>;
  checkAvailability: () => Promise<{
    success: boolean;
    available?: boolean;
    error?: string;
  }>;
  onConnected: (
    callback: (device: {
      udid: string;
      name: string;
      productType: string;
      productVersion: string;
      serialNumber: string;
      isConnected: boolean;
    }) => void,
  ) => () => void;
  onDisconnected: (
    callback: (device: {
      udid: string;
      name: string;
      productType: string;
      productVersion: string;
      serialNumber: string;
      isConnected: boolean;
    }) => void,
  ) => () => void;
  onToolsMissing?: (cb: () => void) => () => void;
  onToolsAvailable?: (cb: () => void) => () => void;
}

/**
 * Backup methods (Windows)
 */
export interface WindowApiBackup {
  getCapabilities: () => Promise<{
    supportsDomainFiltering: boolean;
    supportsIncremental: boolean;
    supportsEncryption: boolean;
    availableDomains: string[];
  }>;
  getStatus: () => Promise<{
    isRunning: boolean;
    currentDeviceUdid: string | null;
    progress: {
      phase: string;
      percentComplete: number;
      currentFile: string | null;
      filesTransferred: number;
      totalFiles: number | null;
      bytesTransferred: number;
      totalBytes: number | null;
      estimatedTimeRemaining: number | null;
    } | null;
  }>;
  start: (options: {
    udid: string;
    outputDir?: string;
    forceFullBackup?: boolean;
  }) => Promise<{
    success: boolean;
    backupPath: string | null;
    error: string | null;
    duration: number;
    deviceUdid: string;
    isIncremental: boolean;
    /**
     * BACKLOG-2917: `null` when the backup's size could not be measured, never 0.
     * This file is a hand-written MIRROR of the main-process producer, structurally
     * independent of it, so `tsc` cannot catch it drifting — it stayed `number` while
     * `BackupResult.backupSize` became nullable and the build remained green. The
     * next renderer to write `(size / 1e9).toFixed(1)` would print "0.0" for a backup
     * whose size walk threw.
     */
    backupSize: number | null;
  }>;
  startWithPassword: (options: {
    udid: string;
    password: string;
    outputPath?: string;
  }) => Promise<{
    success: boolean;
    backupPath?: string;
    error?: string;
    errorCode?: string;
  }>;
  cancel: () => Promise<{ success: boolean }>;
  list: () => Promise<
    Array<{
      path: string;
      deviceUdid: string;
      createdAt: Date;
      /**
       * BACKLOG-2917: `null` when the size could not be measured, never 0.
       * `backup:list` returns `listBackups()` UNSHAPED (backupHandlers.ts), so
       * `BackupInfo.size` crosses this boundary verbatim.
       */
      size: number | null;
      isEncrypted: boolean;
      iosVersion: string | null;
      deviceName: string | null;
    }>
  >;
  delete: (
    backupPath: string,
  ) => Promise<{ success: boolean; error?: string }>;
  cleanup: (
    keepCount?: number,
  ) => Promise<{ success: boolean; error?: string }>;
  checkEncryption: (udid: string) => Promise<{
    success: boolean;
    isEncrypted?: boolean;
    needsPassword?: boolean;
    error?: string;
  }>;
  verifyPassword: (
    backupPath: string,
    password: string,
  ) => Promise<{ success: boolean; valid?: boolean; error?: string }>;
  isEncrypted: (
    backupPath: string,
  ) => Promise<{ success: boolean; isEncrypted?: boolean; error?: string }>;
  onProgress: (
    callback: (progress: {
      phase: string;
      percentComplete: number;
      currentFile: string | null;
      filesTransferred: number;
      totalFiles: number | null;
      bytesTransferred: number;
      totalBytes: number | null;
      estimatedTimeRemaining: number | null;
    }) => void,
  ) => () => void;
  onComplete: (
    callback: (result: {
      success: boolean;
      backupPath: string | null;
      error: string | null;
      duration: number;
      deviceUdid: string;
      isIncremental: boolean;
      /** BACKLOG-2917: `null` when the size could not be measured, never 0. */
      backupSize: number | null;
    }) => void,
  ) => () => void;
  onError: (callback: (error: { message: string }) => void) => () => void;
}

/**
 * Drivers methods (Windows)
 */
export interface WindowApiDrivers {
  checkApple: () => Promise<{
    isInstalled: boolean;
    version: string | null;
    serviceRunning: boolean;
    error: string | null;
  }>;
  hasBundled: () => Promise<{ available: boolean }>;
  installApple: () => Promise<{
    success: boolean;
    error: string | null;
    rebootRequired: boolean;
  }>;
  openITunesStore: () => Promise<{ success: boolean; error?: string }>;
}

/**
 * Sync methods (Windows)
 */
export interface WindowApiSync {
  start: (options: {
    udid: string;
    password?: string;
    forceFullBackup?: boolean;
  }) => Promise<{
    success: boolean;
    messages: unknown[];
    contacts: unknown[];
    conversations: unknown[];
    error: string | null;
    duration: number;
  }>;
  cancel: () => Promise<{ success: boolean }>;
  status: () => Promise<{ isRunning: boolean; phase: string }>;
  devices: () => Promise<
    Array<{
      udid: string;
      name: string;
      productType: string;
      productVersion: string;
      serialNumber: string;
      isConnected: boolean;
    }>
  >;
  startDetection: (intervalMs?: number) => Promise<{ success: boolean }>;
  stopDetection: () => Promise<{ success: boolean }>;
  onProgress: (
    callback: (progress: {
      phase: string;
      phaseProgress: number;
      overallProgress: number;
      message: string;
    }) => void,
  ) => () => void;
  onPhase: (callback: (phase: string) => void) => () => void;
  onDeviceConnected: (callback: (device: unknown) => void) => () => void;
  onDeviceDisconnected: (callback: (device: unknown) => void) => () => void;
  onPasswordRequired: (callback: () => void) => () => void;
  onError: (callback: (error: { message: string }) => void) => () => void;
  onComplete: (callback: (result: unknown) => void) => () => void;
  onWaitingForPasscode: (callback: () => void) => () => void;
  onPasscodeEntered: (callback: () => void) => () => void;
}
