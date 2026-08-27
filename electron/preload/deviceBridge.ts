/**
 * Device Bridge
 * Handles iOS device detection via USB using libimobiledevice
 */

import { ipcRenderer, IpcRendererEvent } from "electron";

export const deviceBridge = {
  /**
   * Lists all currently connected iOS devices
   * @returns List of connected devices
   */
  list: () => ipcRenderer.invoke("device:list"),

  /**
   * Starts device detection polling
   * @returns Start result
   */
  startDetection: () => ipcRenderer.invoke("device:start-detection"),

  /**
   * Stops device detection polling
   * @returns Stop result
   */
  stopDetection: () => ipcRenderer.invoke("device:stop-detection"),

  /**
   * Checks if libimobiledevice tools are available
   * @returns Availability check result
   */
  checkAvailability: () => ipcRenderer.invoke("device:check-availability"),

  /**
   * BACKLOG-1582: Run device detection diagnostics on demand.
   * Returns actionable info about why devices aren't detected.
   */
  runDiagnostics: () => ipcRenderer.invoke("device:run-diagnostics"),

  /**
   * BACKLOG-1582: Request trust/pairing with a device.
   * Triggers the "Trust This Computer?" prompt on the iPhone.
   */
  requestTrust: (udid: string) => ipcRenderer.invoke("device:request-trust", udid),

  /**
   * BACKLOG-1582: Subscribe to device-needs-trust events.
   * Fires when a device is visible but not yet trusted.
   */
  onNeedsTrust: (callback: (data: { udid: string; reason?: string }) => void) => {
    const listener = (_: IpcRendererEvent, data: { udid: string; reason?: string }) => callback(data);
    ipcRenderer.on("device:needs-trust", listener);
    return () => ipcRenderer.removeListener("device:needs-trust", listener);
  },

  /**
   * BACKLOG-1620/1621: Subscribe to tools-missing events.
   * Fires when libimobiledevice executables are not found (ENOENT).
   */
  onToolsMissing: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("device:tools-missing", listener);
    return () => ipcRenderer.removeListener("device:tools-missing", listener);
  },

  /**
   * BACKLOG-1621: Subscribe to tools-available events.
   * Fires when tools become available after previously being missing.
   */
  onToolsAvailable: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("device:tools-available", listener);
    return () => ipcRenderer.removeListener("device:tools-available", listener);
  },

  /**
   * Subscribes to device connected events
   * @param callback - Callback function when device connects
   * @returns Cleanup function to remove listener
   */
  onConnected: (callback: (device: unknown) => void) => {
    const listener = (_: IpcRendererEvent, device: unknown) => callback(device);
    ipcRenderer.on("device:connected", listener);
    return () => ipcRenderer.removeListener("device:connected", listener);
  },

  /**
   * Subscribes to device disconnected events
   * @param callback - Callback function when device disconnects
   * @returns Cleanup function to remove listener
   */
  onDisconnected: (callback: (device: unknown) => void) => {
    const listener = (_: IpcRendererEvent, device: unknown) => callback(device);
    ipcRenderer.on("device:disconnected", listener);
    return () => ipcRenderer.removeListener("device:disconnected", listener);
  },
};

/**
 * Backup Bridge
 * iPhone backup operations for extracting messages and contacts
 */
export const backupBridge = {
  /**
   * Gets backup system capabilities
   * Note: Domain filtering is NOT supported - see docs/BACKUP_RESEARCH.md
   * @returns Available capabilities
   */
  getCapabilities: () => ipcRenderer.invoke("backup:capabilities"),

  /**
   * Gets current backup status
   * @returns Current status including progress
   */
  getStatus: () => ipcRenderer.invoke("backup:status"),

  /**
   * Check backup status for a specific device (returns last sync time, size, etc.)
   * @param udid - Device UDID
   */
  checkStatus: (udid: string) =>
    ipcRenderer.invoke("backup:check-status", udid),

  /**
   * Starts a backup operation for the specified device
   * @param options - Backup options including device UDID
   * @returns Backup result
   */
  start: (options: {
    udid: string;
    outputDir?: string;
    forceFullBackup?: boolean;
  }) => ipcRenderer.invoke("backup:start", options),

  /**
   * Cancels an in-progress backup
   * @returns Cancellation result
   */
  cancel: () => ipcRenderer.invoke("backup:cancel"),

  /**
   * Lists all existing backups
   * @returns List of backup information
   */
  list: () => ipcRenderer.invoke("backup:list"),

  /**
   * Deletes a specific backup
   * @param backupPath - Path to the backup to delete
   * @returns Deletion result
   */
  delete: (backupPath: string) =>
    ipcRenderer.invoke("backup:delete", backupPath),

  /**
   * Cleans up old backups, keeping only the most recent
   * @param keepCount - Number of backups to keep per device
   * @returns Cleanup result
   */
  cleanup: (keepCount?: number) =>
    ipcRenderer.invoke("backup:cleanup", keepCount),

  /**
   * Check if a device requires encrypted backup
   * @param udid - Device unique identifier
   */
  checkEncryption: (udid: string) =>
    ipcRenderer.invoke("backup:check-encryption", udid),

  /**
   * Start a backup with password (for encrypted backups)
   * @param options - Backup options including password
   */
  startWithPassword: (options: {
    udid: string;
    password: string;
    outputPath?: string;
  }) => ipcRenderer.invoke("backup:start-with-password", options),

  /**
   * Verify a backup password without starting backup
   * @param backupPath - Path to the backup
   * @param password - Password to verify
   */
  verifyPassword: (backupPath: string, password: string) =>
    ipcRenderer.invoke("backup:verify-password", backupPath, password),

  /**
   * Check if an existing backup is encrypted
   * @param backupPath - Path to the backup
   */
  isEncrypted: (backupPath: string) =>
    ipcRenderer.invoke("backup:is-encrypted", backupPath),

  /**
   * Subscribes to backup progress updates
   * @param callback - Called with progress updates
   * @returns Cleanup function to remove listener
   */
  onProgress: (callback: (progress: unknown) => void) => {
    const listener = (_: IpcRendererEvent, progress: unknown) =>
      callback(progress);
    ipcRenderer.on("backup:progress", listener);
    return () => ipcRenderer.removeListener("backup:progress", listener);
  },

  /**
   * Subscribes to backup completion events
   * @param callback - Called when backup completes
   * @returns Cleanup function to remove listener
   */
  onComplete: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("backup:complete", listener);
    return () => ipcRenderer.removeListener("backup:complete", listener);
  },

  /**
   * Subscribes to backup error events
   * @param callback - Called when backup encounters an error
   * @returns Cleanup function to remove listener
   */
  onError: (callback: (error: { message: string }) => void) => {
    const listener = (_: IpcRendererEvent, error: { message: string }) => callback(error);
    ipcRenderer.on("backup:error", listener);
    return () => ipcRenderer.removeListener("backup:error", listener);
  },
};

/**
 * Driver Bridge (Windows only)
 * Detects and installs Apple Mobile Device Support drivers
 */
export const driverBridge = {
  /**
   * Check if Apple Mobile Device Support drivers are installed
   */
  checkApple: () => ipcRenderer.invoke("drivers:check-apple"),

  /**
   * Check if bundled Apple drivers are available in the app
   */
  hasBundled: () => ipcRenderer.invoke("drivers:has-bundled"),

  /**
   * Install Apple Mobile Device Support drivers
   * IMPORTANT: Only call after user has given consent
   */
  installApple: () => ipcRenderer.invoke("drivers:install-apple"),

  /**
   * Open iTunes in Microsoft Store for manual installation
   */
  openITunesStore: () => ipcRenderer.invoke("drivers:open-itunes-store"),

  /**
   * Check if a driver update is available
   */
  checkUpdate: () => ipcRenderer.invoke("drivers:check-update"),
};

/**
 * Sync Bridge (Windows iPhone Sync)
 * Complete iPhone sync flow: backup -> decrypt -> parse -> resolve
 */
export const syncBridge = {
  /**
   * Starts a complete sync operation for an iPhone
   * @param options - Sync options
   * @returns Sync result with messages, contacts, conversations
   */
  start: (options: {
    udid: string;
    password?: string;
    forceFullBackup?: boolean;
  }) => ipcRenderer.invoke("sync:start", options),

  /**
   * Cancels an in-progress sync operation
   * @returns Cancellation result
   */
  cancel: () => ipcRenderer.invoke("sync:cancel"),

  /**
   * Gets current sync status
   * @returns Current sync status
   */
  getStatus: () => ipcRenderer.invoke("sync:status"),

  /**
   * Gets unified sync status (aggregates backup + orchestrator state)
   * TASK-904: Use this to check if any sync operation is running
   * @returns Unified sync status with operation details
   */
  getUnifiedStatus: () => ipcRenderer.invoke("sync:getUnifiedStatus"),

  /**
   * Gets all connected iOS devices
   * @returns List of connected devices
   */
  getDevices: () => ipcRenderer.invoke("sync:devices"),

  /**
   * Starts device detection polling
   * @param intervalMs - Polling interval in milliseconds
   * @returns Start result
   */
  startDetection: (intervalMs?: number) =>
    ipcRenderer.invoke("sync:start-detection", intervalMs),

  /**
   * Stops device detection polling
   * @returns Stop result
   */
  stopDetection: () => ipcRenderer.invoke("sync:stop-detection"),

  /**
   * Process existing backup without running new backup (for testing)
   * @param options - Processing options
   * @returns Processing result
   */
  processExisting: (options: { udid: string; password?: string }) =>
    ipcRenderer.invoke("sync:process-existing", options),

  /**
   * Subscribes to sync progress updates
   * @param callback - Callback with progress info
   * @returns Cleanup function to remove listener
   */
  onProgress: (callback: (progress: unknown) => void) => {
    const listener = (_: IpcRendererEvent, progress: unknown) =>
      callback(progress);
    ipcRenderer.on("sync:progress", listener);
    return () => ipcRenderer.removeListener("sync:progress", listener);
  },

  /**
   * Subscribes to sync phase changes
   * @param callback - Callback with phase name
   * @returns Cleanup function to remove listener
   */
  onPhase: (callback: (phase: string) => void) => {
    const listener = (_: IpcRendererEvent, phase: string) => callback(phase);
    ipcRenderer.on("sync:phase", listener);
    return () => ipcRenderer.removeListener("sync:phase", listener);
  },

  /**
   * Subscribes to device connected events during sync
   * @param callback - Callback with device info
   * @returns Cleanup function to remove listener
   */
  onDeviceConnected: (callback: (device: unknown) => void) => {
    const listener = (_: IpcRendererEvent, device: unknown) => callback(device);
    ipcRenderer.on("sync:device-connected", listener);
    return () =>
      ipcRenderer.removeListener("sync:device-connected", listener);
  },

  /**
   * Subscribes to device disconnected events during sync
   * @param callback - Callback with device info
   * @returns Cleanup function to remove listener
   */
  onDeviceDisconnected: (callback: (device: unknown) => void) => {
    const listener = (_: IpcRendererEvent, device: unknown) => callback(device);
    ipcRenderer.on("sync:device-disconnected", listener);
    return () =>
      ipcRenderer.removeListener("sync:device-disconnected", listener);
  },

  /**
   * Subscribes to password required events (encrypted backup)
   * @param callback - Callback when password is needed
   * @returns Cleanup function to remove listener
   */
  onPasswordRequired: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("sync:password-required", listener);
    return () =>
      ipcRenderer.removeListener("sync:password-required", listener);
  },

  /**
   * Subscribes to passcode waiting events (user needs to enter passcode on iPhone)
   * @param callback - Callback when waiting for passcode
   * @returns Cleanup function to remove listener
   */
  onWaitingForPasscode: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("sync:waiting-for-passcode", listener);
    return () =>
      ipcRenderer.removeListener("sync:waiting-for-passcode", listener);
  },

  /**
   * Subscribes to passcode entered events (user entered passcode, backup starting)
   * @param callback - Callback when passcode entered
   * @returns Cleanup function to remove listener
   */
  onPasscodeEntered: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("sync:passcode-entered", listener);
    return () =>
      ipcRenderer.removeListener("sync:passcode-entered", listener);
  },

  /**
   * Subscribes to sync error events
   * TASK-2276: Enriched payload may include userError for structured display
   * @param callback - Callback with error info (and optional userError)
   * @returns Cleanup function to remove listener
   */
  onError: (callback: (error: { message: string; userError?: { code: string; title: string; description: string; actionSuggestion: string } }) => void) => {
    const listener = (_: IpcRendererEvent, error: { message: string; userError?: { code: string; title: string; description: string; actionSuggestion: string } }) => callback(error);
    ipcRenderer.on("sync:error", listener);
    return () => ipcRenderer.removeListener("sync:error", listener);
  },

  /**
   * Subscribes to sync completion events
   * @param callback - Callback with sync result
   * @returns Cleanup function to remove listener
   */
  onComplete: (callback: (result: unknown) => void) => {
    const listener = (_: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("sync:complete", listener);
    return () => ipcRenderer.removeListener("sync:complete", listener);
  },

  /**
   * Subscribes to storage completion events (after messages saved to DB)
   * @param callback - Callback with storage result
   * @returns Cleanup function to remove listener
   */
  onStorageComplete: (
    callback: (result: {
      messagesStored: number;
      contactsStored: number;
      duration: number;
    }) => void
  ) => {
    const listener = (_: IpcRendererEvent, result: {
      messagesStored: number;
      contactsStored: number;
      duration: number;
    }) => callback(result);
    ipcRenderer.on("sync:storage-complete", listener);
    return () =>
      ipcRenderer.removeListener("sync:storage-complete", listener);
  },

  /**
   * Subscribes to storage error events
   * @param callback - Callback with error info
   * @returns Cleanup function to remove listener
   */
  onStorageError: (callback: (error: { error: string }) => void) => {
    const listener = (_: IpcRendererEvent, error: { error: string }) => callback(error);
    ipcRenderer.on("sync:storage-error", listener);
    return () => ipcRenderer.removeListener("sync:storage-error", listener);
  },

  /**
   * Gets the last sync time for an iPhone device from Supabase
   * TASK-2121: Persisted per user_id + device_udid
   * @param udid - Device UDID
   * @returns Object with lastSyncTime (ISO string or null)
   */
  getIPhoneLastSyncTime: (udid: string): Promise<{ lastSyncTime: string | null }> =>
    ipcRenderer.invoke("sync:get-iphone-last-sync-time", udid),
};
