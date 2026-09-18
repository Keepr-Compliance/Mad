/**
 * WindowApi System sub-interface
 * System, permission, and diagnostic methods exposed to renderer process
 */

import type { OAuthProvider } from "../models";
import type { InitStageEvent } from "../../services/initializationBroadcaster";
import type { ConnectionErrorType } from "../../services/connectionStatusService";
import type { HealthIssue } from "./healthIssue";

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
    /**
     * BACKLOG-3208: the producer has always set this on the denied path
     * (`permissionHandlers.ts` check-permissions returns
     * `{ hasPermission: false, error: (error as Error).message }` — the raw
     * `EPERM: operation not permitted, access '<home>/Library/Messages/chat.db'`
     * from `fs.access`). The type omitted it, so no consumer could read it
     * without an `as` cast. Declared here so the reason can be logged.
     */
    error?: string;
    /**
     * BACKLOG-3213: WHICH failure the probe saw, so a caller can tell a
     * permission refusal from a database that is not on this Mac.
     *
     *   "FULL_DISK_ACCESS_DENIED"  macOS refused us — granting FDA is the fix.
     *   "MESSAGES_STORE_NOT_FOUND" `chat.db` is absent (ENOENT/ENOTDIR) —
     *                              there is nothing to grant.
     *
     * ADDITIVE. `hasPermission` and `error` are unchanged on every path, and
     * this field is absent on the granted path. Every existing consumer reads
     * named fields, so none of them sees a difference.
     */
    errorCode?: string;
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

  /**
   * BACKLOG-1842 (resume-at-step): persist a cloud (Supabase user_preferences)
   * resume marker just before the FDA-grant relaunch so the fresh process
   * resumes onboarding at the exact step (permissions) instead of replaying
   * earlier steps. Cloud-backed to match phoneType/contactSources, which
   * already live in the same preferences bag and are already readable before
   * local DB init.
   */
  saveOnboardingResumeMarker: (payload: { userId: string }) => Promise<{
    success: boolean;
    error?: string;
  }>;

  /**
   * BACKLOG-1842 (resume-at-step): read-and-clear the cloud resume marker
   * (single-use, so a later unrelated launch is never hijacked).
   * `resumeStep` is null when there is nothing to resume (normal launch).
   */
  consumeOnboardingResumeMarker: (payload: { userId: string }) => Promise<{
    resumeStep: "permissions" | null;
  }>;

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
    // BACKLOG-3230: objects, not strings. This is the declaration the live path
    // reads — `systemService.healthCheck` calls through it.
    issues?: HealthIssue[];
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
    // BACKLOG-2149: true when the failure is only that the DB is still starting
    // up (not a terminal setup failure). The renderer should keep retrying and
    // show a calm "starting up" state rather than "Setup failed".
    transient?: boolean;
    retryable?: boolean;
  }>;
  // Initialization stage events (BACKLOG-1379: event-driven init protocol)
  onInitStage: (callback: (event: InitStageEvent) => void) => () => void;
  getInitStage: () => Promise<InitStageEvent>;
}
