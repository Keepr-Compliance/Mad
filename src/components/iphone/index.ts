/**
 * iPhone Connection UI Components
 *
 * These components provide the user interface for connecting
 * iPhones via USB on Windows PCs to sync messages and contacts.
 */

export { ConnectionStatus } from "./ConnectionStatus";
export { TrustComputerHint } from "./TrustComputerHint";
export { DeviceInfo } from "./DeviceInfo";
export { SyncProgress } from "./SyncProgress";
export { IPhoneSyncFlow } from "./IPhoneSyncFlow";

// Re-export types for convenience
export type {
  iOSDevice,
  BackupProgress,
  SyncStatus,
  ConnectionStatusProps,
  DeviceInfoProps,
  SyncProgressProps,
  UseIPhoneSyncReturn,
} from "../../types/iphone";
