/**
 * User-Facing Error Message Formatters (TASK-2276)
 *
 * Generates structured, actionable error messages for sync and disk failures.
 * These messages are displayed to the user via the enriched error event payload.
 *
 * Each formatter returns a UserFacingError with:
 * - title: Short heading for the error
 * - description: Detailed explanation with specific numbers where available
 * - actionSuggestion: What the user should do to resolve the issue
 * - code: Programmatic error code for UI handling
 *
 * IMPORTANT: Messages must NEVER include technical details (stack traces, error codes).
 * Technical details go to Sentry via Phase 1 diagnostic tasks.
 */

export interface UserFacingError {
  title: string;
  description: string;
  actionSuggestion: string;
  /** Error code for programmatic handling */
  code: UserErrorCode;
}

export type UserErrorCode =
  | "INSUFFICIENT_DISK_SPACE"
  /**
   * BACKLOG-2925: distinct from INSUFFICIENT_DISK_SPACE on purpose. That code asserts
   * a comparison was made and came out short; this one says no comparison was
   * possible. Collapsing them would make the app claim knowledge it does not have,
   * which is the defect this code exists to end.
   */
  | "BACKUP_SIZE_UNKNOWN"
  | "MISSING_DRIVERS"
  | "DRIVER_SERVICE_STOPPED"
  | "DEVICE_NOT_DETECTED"
  | "SYNC_FAILED";

/**
 * Format a human-readable size string from megabytes.
 * Shows GB for values >= 1024 MB, otherwise MB.
 */
function formatSize(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${Math.round(mb)}MB`;
}

/**
 * Format error for insufficient disk space.
 * Includes the actual available and required amounts so the user
 * knows exactly how much space to free.
 */
export function formatDiskSpaceError(
  availableMB: number,
  requiredMB: number,
): UserFacingError {
  const availableStr = formatSize(availableMB);
  const requiredStr = formatSize(requiredMB);

  return {
    title: "Insufficient Disk Space",
    description: `iPhone sync requires at least ${requiredStr} of free space. You currently have ${availableStr} available.`,
    actionSuggestion:
      "Free up disk space by deleting unnecessary files, then try syncing again.",
    code: "INSUFFICIENT_DISK_SPACE",
  };
}

/**
 * BACKLOG-2925: the size of the coming backup could not be established, so whether it
 * fits cannot be established either.
 *
 * The description says "couldn't work out" and NEVER a number. On 2026-08-27 the app
 * told the founder "Disk space check passed: 15 GB available" for a backup that had
 * measured 58.8 GB, because an unmeasurable size arrived as `0` and cleared the bar.
 * A message here that named any figure would repeat that in words.
 *
 * The remedy is stated in the DESCRIPTION rather than only in `actionSuggestion`,
 * because `actionSuggestion` currently reaches no pixel: `IPhoneSyncFlow.tsx` renders
 * the plain `error` string, and the orchestrator emits `userError.description` as
 * that string. The structured fields are carried for the UI that will use them.
 */
export function formatUnknownBackupSizeError(): UserFacingError {
  return {
    title: "Couldn't check there's room for this backup",
    description:
      "Keepr couldn't work out how big this iPhone backup will be, so it can't tell whether it fits on this Mac — and it won't start a sync it can't check. Unlock your iPhone, leave it connected and tap Trust if asked, then try again.",
    actionSuggestion:
      "Unlock your iPhone and keep it plugged in, then sync again. If it keeps happening, reconnect the cable and free up disk space before retrying.",
    code: "BACKUP_SIZE_UNKNOWN",
  };
}

/**
 * Format error for missing Apple Mobile Device Support drivers (Windows only).
 * Directs user to install via Settings > Sync Tools.
 */
export function formatMissingDriversError(): UserFacingError {
  return {
    title: "Sync Tools Not Installed",
    description:
      "iPhone sync requires Apple Mobile Device Support drivers which are not currently installed on your computer.",
    actionSuggestion:
      "Go to Settings and click 'Install Sync Tools' to set up the required drivers.",
    code: "MISSING_DRIVERS",
  };
}

/**
 * Format error for Apple Mobile Device Service installed but not running.
 * Suggests restart or repair via Settings.
 */
export function formatDriverServiceStoppedError(): UserFacingError {
  return {
    title: "Sync Service Not Running",
    description:
      "Apple Mobile Device Service is installed but not currently running. This is required for iPhone detection.",
    actionSuggestion:
      "Restart your computer, or go to Settings > Sync Tools to repair the installation.",
    code: "DRIVER_SERVICE_STOPPED",
  };
}

/**
 * Format error for iPhone not detected via USB.
 * Provides step-by-step troubleshooting instructions.
 */
export function formatDeviceNotDetectedError(): UserFacingError {
  return {
    title: "iPhone Not Detected",
    description:
      "No iPhone was found connected to your computer. Make sure your iPhone is plugged in via USB and that you've tapped 'Trust' on the device.",
    actionSuggestion:
      "1. Check your USB cable connection\n2. Look for a 'Trust This Computer?' prompt on your iPhone\n3. If prompted, tap 'Trust' and enter your passcode",
    code: "DEVICE_NOT_DETECTED",
  };
}

/**
 * Format a generic sync failure error.
 * Used as a fallback when the specific failure reason is unknown.
 *
 * @param message - Optional detail message (should not contain technical info)
 */
export function formatSyncFailedError(message?: string): UserFacingError {
  return {
    title: "Sync Failed",
    description: message
      ? `iPhone sync could not be completed: ${message}`
      : "iPhone sync could not be completed due to an unexpected error.",
    actionSuggestion:
      "Try disconnecting and reconnecting your iPhone, then attempt the sync again. If the problem persists, restart the application.",
    code: "SYNC_FAILED",
  };
}
