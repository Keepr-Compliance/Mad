/**
 * Diagnostics barrel export (TASK-2270, TASK-2275, TASK-2276)
 */
export {
  checkDiskSpaceForOperation,
  DISK_SPACE_THRESHOLDS,
} from "./diskSpaceDiagnostics";
export type {
  DiskOperation,
  DiskSpaceCheckResult,
} from "./diskSpaceDiagnostics";

export {
  collectStartupDiagnostics,
  getLatestDiagnostics,
} from "./startupDiagnosticsCollector";
export type { StartupDiagnostics } from "./startupDiagnosticsCollector";

export {
  formatDiskSpaceError,
  formatUnknownBackupSizeError,
  formatMissingDriversError,
  formatDriverServiceStoppedError,
  formatDeviceNotDetectedError,
  formatSyncFailedError,
} from "./userFacingErrors";
export type { UserFacingError, UserErrorCode } from "./userFacingErrors";
