/**
 * iPhone/iOS Device Types for Windows PC connectivity
 * Used for USB-based device detection and backup sync
 */

// ============================================
// iOS DEVICE TYPES
// ============================================

export interface iOSDevice {
  udid: string;
  name: string;
  productType: string;
  productVersion: string;
  serialNumber: string;
  isConnected: boolean;
}

/**
 * BACKLOG-1627: Reason why a device needs trust.
 * Used across IPC boundaries for typed trust error handling.
 */
export type TrustErrorReason = "locked" | "trust_pending" | "unknown";

// ============================================
// BACKUP TYPES
// ============================================

export interface BackupProgress {
  phase: "preparing" | "backing_up" | "extracting" | "storing" | "complete" | "error";
  percent: number;
  currentFile?: string;
  totalFiles?: number;
  processedFiles?: number;
  bytesProcessed?: number;
  totalBytes?: number;
  message?: string;
  /** Estimated total backup size in bytes (based on device storage) */
  estimatedTotalBytes?: number;
}

export interface BackupResult {
  success: boolean;
  error?: string;
  messagesCount?: number;
  contactsCount?: number;
}

// ============================================
// SYNC STATUS TYPES
// ============================================

export type SyncStatus = "idle" | "syncing" | "complete" | "error";

/**
 * Sync lock state for preventing concurrent sync operations
 * TASK-910: Created for sync lock UI
 */
export interface SyncLockState {
  /** Whether a sync operation is currently running */
  syncLocked: boolean;
  /** Human-readable description of the current operation */
  lockReason: string | null;
}

// ============================================
// COMPONENT PROP TYPES
// ============================================

export interface ConnectionStatusProps {
  isConnected: boolean;
  device: iOSDevice | null;
  onSyncClick: () => void;
  /** Last sync timestamp (from backup status) */
  lastSyncTime?: Date | null;
  /**
   * BACKLOG-1919: Whether the Apple Mobile Device Support driver is missing
   * while no device is detected (Windows). When true, the disconnected view
   * shows an inline one-click install button instead of silent "Connect your
   * iPhone" text, giving the user an on-screen recovery path.
   */
  driverMissing?: boolean;
  /** BACKLOG-1919: Invoke the inline driver install (triggers the UAC prompt). */
  onInstallDriver?: () => void;
  /** BACKLOG-1919: Whether the inline driver install is currently running. */
  isInstallingDriver?: boolean;
  /** BACKLOG-1919: Error message from a failed/cancelled inline driver install. */
  driverInstallError?: string | null;
}

export interface DeviceInfoProps {
  device: iOSDevice;
}

export interface BackupPasswordModalProps {
  isOpen: boolean;
  deviceName: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
  error?: string;
  isLoading?: boolean;
}

export interface SyncProgressProps {
  progress: BackupProgress;
  onCancel?: () => void;
  /** Whether the sync is waiting for the user to enter their iPhone passcode */
  isWaitingForPasscode?: boolean;
}

// ============================================
// USER-FACING ERROR TYPES (TASK-2276)
// ============================================

/**
 * Structured error for user-facing display.
 * Contains actionable information (title, description, suggestion)
 * instead of raw technical error messages.
 */
export interface UserFacingError {
  title: string;
  description: string;
  actionSuggestion: string;
  /** Error code for programmatic handling */
  code: string;
}

// ============================================
// HOOK RETURN TYPES
// ============================================

export interface UseIPhoneSyncReturn {
  isConnected: boolean;
  device: iOSDevice | null;
  syncStatus: SyncStatus;
  progress: BackupProgress | null;
  error: string | null;
  /** TASK-2276: Structured error for rich UI display (title + description + suggestion) */
  userError: UserFacingError | null;
  needsPassword: boolean;
  /** Last sync time for this device (from backup status) */
  lastSyncTime: Date | null;
  /** Whether the sync is waiting for the user to enter their iPhone passcode */
  isWaitingForPasscode: boolean;
  /** Whether another sync operation is running (TASK-910) */
  syncLocked: boolean;
  /** Human-readable description of the blocking operation (TASK-910) */
  lockReason: string | null;
  /** BACKLOG-1582: Whether a device is visible but needs trust */
  needsTrust: boolean;
  /** BACKLOG-1582: UDID of the device that needs trust */
  needsTrustUdid: string | null;
  /** BACKLOG-1620/1621: Whether libimobiledevice tools are missing (iTunes not installed) */
  toolsMissing: boolean;
  /**
   * BACKLOG-1919: Whether the Apple Mobile Device Support driver is absent while
   * no device is detected (Windows only). Distinct from `toolsMissing` — this is
   * the "driver silently never installed / install was skipped or declined" case
   * that previously left the user stuck on "Connect Your iPhone" with no guidance.
   */
  driverMissing: boolean;
  /**
   * BACKLOG-1919: Status of an in-progress inline driver recovery install
   * triggered from the Connect-iPhone screen.
   */
  installDriverStatus: "idle" | "installing" | "error";
  /** BACKLOG-1919: Error from a failed/cancelled inline driver recovery install. */
  installDriverError: string | null;
  /**
   * BACKLOG-1919: Run the inline driver recovery install (triggers the UAC admin
   * prompt via window.api.drivers.installApple). On success, re-checks driver
   * state and clears `driverMissing` so device enumeration/sync can proceed.
   */
  recoverInstallDriver: () => Promise<void>;
  startSync: () => Promise<void>;
  submitPassword: (password: string) => void;
  cancelSync: () => Promise<void>;
  /** Reset state after user acknowledges sync completion */
  dismissSync: () => void;
  /**
   * Refresh the sync lock status (TASK-910).
   * BACKLOG-1773: Resolves `true` when the status was read successfully and
   * `false` when the sync IPC is unavailable, so the poll loop can back off.
   */
  checkSyncStatus: () => Promise<boolean>;
  /** BACKLOG-1582: Manually request trust/pairing with a device */
  requestTrust: () => Promise<void>;
}
