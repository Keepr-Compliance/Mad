/**
 * WindowApi System sub-interface
 * System, permission, and diagnostic methods exposed to renderer process
 */

import type { OAuthProvider } from "../models";
import type { InitStageEvent } from "../../services/initializationBroadcaster";
import type { ConnectionErrorType } from "../../services/connectionStatusService";

/**
 * System methods on window.api
 */
export interface WindowApiSystem {
  // Platform detection (migrated from window.electron.platform)
  platform: NodeJS.Platform;

  // App info methods (migrated from window.electron)
  getAppInfo: () => Promise<{ version: string; name: string }>;
  getMacOSVersion: () => Promise<{ version: string | number; name?: string }>;
  checkAppLocation: () => Promise<{
    inApplications?: boolean;
    shouldPrompt?: boolean;
    appPath?: string;
    path?: string;
  }>;

  // Permission checks (migrated from window.electron)
  checkPermissions: () => Promise<{
    hasPermission?: boolean;
    fullDiskAccess?: boolean;
    contacts?: boolean;
  }>;
  triggerFullDiskAccess: () => Promise<{ granted: boolean }>;
  requestPermissions: () => Promise<Record<string, unknown>>;
  openSystemSettings: () => Promise<{ success: boolean }>;
  /**
   * BACKLOG-1842: Cleanly relaunch the app (no data wipe) after an FDA grant so
   * the fresh process picks up the permission and resumes onboarding/sync.
   * `relaunched` is false when suppressed by the E2E/dev harness gate.
   */
  relaunchApp: () => Promise<{ relaunched: boolean }>;

  // Existing system methods
  runPermissionSetup: () => Promise<{ success: boolean }>;
  requestContactsPermission: () => Promise<{ granted: boolean }>;
  setupFullDiskAccess: () => Promise<{ success: boolean }>;
  openPrivacyPane: (pane: string) => Promise<{ success: boolean }>;
  checkFullDiskAccessStatus: () => Promise<{ hasAccess: boolean }>;
  checkFullDiskAccess: () => Promise<{ hasAccess: boolean }>;
  checkContactsPermission: () => Promise<{ hasPermission: boolean }>;
  checkAllPermissions: () => Promise<{
    allGranted: boolean;
    permissions: {
      fullDiskAccess?: { hasPermission: boolean; error?: string };
      contacts?: { hasPermission: boolean; error?: string };
    };
    errors: Array<{ hasPermission: boolean; error?: string }>;
  }>;
  checkGoogleConnection: (
    userId: string,
  ) => Promise<{ connected: boolean; email?: string; error?: string }>;
  checkMicrosoftConnection: (
    userId: string,
  ) => Promise<{ connected: boolean; email?: string; error?: string }>;
  checkAllConnections: (userId: string) => Promise<{
    success: boolean;
    google?: {
      connected: boolean;
      email?: string;
      error?: {
        type: ConnectionErrorType;
        userMessage: string;
        action?: string;
        actionHandler?: string;
      } | null;
    };
    microsoft?: {
      connected: boolean;
      email?: string;
      error?: {
        type: ConnectionErrorType;
        userMessage: string;
        action?: string;
        actionHandler?: string;
      } | null;
    };
  }>;
  healthCheck: (
    userId: string,
    provider: OAuthProvider,
  ) => Promise<{
    healthy: boolean;
    provider?: OAuthProvider;
    issues?: string[];
  }>;
  // Secure storage / keychain methods
  getSecureStorageStatus: () => Promise<{
    success: boolean;
    available: boolean;
    platform?: string;
    guidance?: string;
    error?: string;
  }>;
  initializeSecureStorage: () => Promise<{
    success: boolean;
    available: boolean;
    platform?: string;
    guidance?: string;
    error?: string;
  }>;
  hasEncryptionKeyStore: () => Promise<{
    success: boolean;
    hasKeyStore: boolean;
  }>;
  initializeDatabase: () => Promise<{ success: boolean; error?: string }>;
  isDatabaseInitialized: () => Promise<{
    success: boolean;
    initialized: boolean;
  }>;
  // Support methods
  contactSupport: (
    errorDetails?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  getDiagnostics: () => Promise<{
    success: boolean;
    diagnostics?: string;
    error?: string;
  }>;
  // Database maintenance methods
  reindexDatabase: () => Promise<{
    success: boolean;
    indexesRebuilt?: number;
    durationMs?: number;
    error?: string;
  }>;
  // User verification methods
  checkUserInLocalDb: (userId: string) => Promise<{
    success: boolean;
    exists: boolean;
    error?: string;
  }>;
  verifyUserInLocalDb: () => Promise<{
    success: boolean;
    userId?: string;
    error?: string;
  }>;
  // Initialization stage events (BACKLOG-1379: event-driven init protocol)
  onInitStage: (callback: (event: InitStageEvent) => void) => () => void;
  getInitStage: () => Promise<InitStageEvent>;
}
