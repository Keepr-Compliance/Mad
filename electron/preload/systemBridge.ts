/**
 * System Bridge
 * System-level operations including permissions, connections, and health checks
 */

import { ipcRenderer } from "electron";

// Declared by esbuild at build time: true for dev, false for production
declare const __DEV__: boolean;

// Dev-only diagnostic functions (stripped from production builds)
const devDiagnostics = __DEV__
  ? {
      /**
       * Diagnostic: Complete message health report
       * Returns: total, withThreadId, withNullThreadId, withGarbageText, withEmptyText, healthy, healthPercentage
       */
      diagnosticMessageHealth: (userId: string) =>
        ipcRenderer.invoke("diagnostic:message-health-report", userId),

      /**
       * Diagnostic: Find messages with NULL thread_id (can cause incorrect chat merging)
       */
      diagnosticNullThreadId: (userId: string) =>
        ipcRenderer.invoke("diagnostic:messages-null-thread-id", userId),

      /**
       * Diagnostic: Find messages with garbage text (binary signatures)
       */
      diagnosticGarbageText: (userId: string) =>
        ipcRenderer.invoke("diagnostic:messages-garbage-text", userId),

      /**
       * Diagnostic: Get thread distribution for a contact
       */
      diagnosticThreadsForContact: (userId: string, phoneDigits: string) =>
        ipcRenderer.invoke("diagnostic:threads-for-contact", userId, phoneDigits),

      /**
       * Diagnostic: Detailed analysis of NULL thread_id messages
       * Groups by sender, channel, and month to identify patterns
       */
      diagnosticNullThreadIdAnalysis: (userId: string) =>
        ipcRenderer.invoke("diagnostic:null-thread-id-analysis", userId),

      /**
       * Diagnostic: Get recent messages with unknown recipient
       * Returns external_id (macOS ROWID) for cross-referencing
       */
      diagnosticUnknownRecipientMessages: (userId: string) =>
        ipcRenderer.invoke("diagnostic:unknown-recipient-messages", userId),

      /**
       * Diagnostic: Check email data for a specific contact email
       * Checks both contact_emails junction table and communications table
       */
      diagnosticCheckEmailData: (userId: string, emailAddress: string) =>
        ipcRenderer.invoke("diagnostic:check-email-data", userId, emailAddress),

      /**
       * DEV-ONLY: Manually trigger deep link callback when protocol handler fails
       * @param url - The full keepr://callback?... URL from browser
       * @returns Success result
       */
      manualDeepLink: (url: string) =>
        ipcRenderer.invoke("system:manual-deep-link", url),
    }
  : {};

export const systemBridge = {
  /**
   * Current platform identifier from Node.js process.platform
   */
  platform: process.platform,

  /**
   * Gets application info (version, name, etc.)
   * @returns App info
   */
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),

  /**
   * Gets macOS version information
   * @returns macOS version
   */
  getMacOSVersion: () => ipcRenderer.invoke("get-macos-version"),

  /**
   * Checks if app is in /Applications folder
   * @returns Location check result
   */
  checkAppLocation: () => ipcRenderer.invoke("check-app-location"),

  /**
   * Legacy permission check method
   * @returns Permission statuses
   */
  checkPermissions: () => ipcRenderer.invoke("check-permissions"),

  /**
   * Triggers Full Disk Access check
   * @returns Access status
   */
  triggerFullDiskAccess: () => ipcRenderer.invoke("trigger-full-disk-access"),

  /**
   * Legacy permission request method
   * @returns Permission request result
   */
  requestPermissions: () => ipcRenderer.invoke("request-permissions"),

  /**
   * Opens macOS System Settings/Preferences
   * @returns Open result
   */
  openSystemSettings: () => ipcRenderer.invoke("open-system-settings"),

  /**
   * BACKLOG-1842: Cleanly relaunch the app (no data wipe) after the user grants
   * Full Disk Access, so the fresh process sees the new permission and resumes
   * onboarding/sync at the correct step. No-op under the E2E harness.
   * @returns { relaunched } — false when suppressed (E2E/dev harness)
   */
  relaunchApp: () => ipcRenderer.invoke("relaunch-app"),

  /**
   * BACKLOG-1842 (resume-at-step): persist a cloud (Supabase user_preferences)
   * resume marker just before the FDA-grant relaunch so the fresh process
   * resumes onboarding at the exact step (permissions) instead of replaying
   * phone-type, contact-source, etc. Cloud-backed (not a local file) to match
   * phoneType/contactSources, which already live in the same preferences bag
   * and are already readable before local DB init. Written by PermissionsStep
   * right before calling relaunchApp().
   */
  saveOnboardingResumeMarker: (payload: { userId: string }) =>
    ipcRenderer.invoke("save-onboarding-resume-marker", payload),

  /**
   * BACKLOG-1842 (resume-at-step): read-and-clear the cloud resume marker
   * (single-use, so a later unrelated launch is never hijacked). Called once
   * early on startup by OnboardingFlow.
   */
  consumeOnboardingResumeMarker: (payload: { userId: string }) =>
    ipcRenderer.invoke("consume-onboarding-resume-marker", payload),

  /**
   * Gets secure storage status without triggering keychain prompt
   * Used to check if encryption is already available (user already authorized)
   * @returns Status result
   */
  getSecureStorageStatus: () =>
    ipcRenderer.invoke("system:get-secure-storage-status"),

  /**
   * Initializes secure storage (triggers keychain prompt on macOS)
   * Should be called after user login and terms acceptance
   * @returns Initialization result
   */
  initializeSecureStorage: () =>
    ipcRenderer.invoke("system:initialize-secure-storage"),

  /**
   * Checks if the database encryption key store file exists
   * Used to determine if this is a new user (needs secure storage setup) vs returning user
   * @returns Key store check result
   */
  hasEncryptionKeyStore: () =>
    ipcRenderer.invoke("system:has-encryption-key-store"),

  /**
   * Verify user exists in local database, creating if needed.
   * Called by AccountVerificationStep after DB init and before email connection.
   * @returns User verification result with userId on success
   */
  verifyUserInLocalDb: () =>
    ipcRenderer.invoke("system:verify-user-in-local-db") as Promise<{
      success: boolean;
      userId?: string;
      error?: string;
    }>,

  /**
   * Initializes the database after secure storage setup
   * Should be called after the user has authorized keychain access (new users only)
   * @returns Database initialization result
   */
  initializeDatabase: () => ipcRenderer.invoke("system:initialize-database"),

  /**
   * Checks if the database is initialized and ready for operations
   * Used to determine if we can save user data after OAuth
   * @returns Database initialization status
   */
  isDatabaseInitialized: () =>
    ipcRenderer.invoke("system:is-database-initialized"),

  /**
   * Runs the complete permission setup flow for onboarding
   * @returns Setup result
   */
  runPermissionSetup: () => ipcRenderer.invoke("system:run-permission-setup"),

  /**
   * Requests macOS contacts permission
   * @returns Permission request result
   */
  requestContactsPermission: () =>
    ipcRenderer.invoke("system:request-contacts-permission"),

  /**
   * Initiates Full Disk Access setup process
   * @returns Setup result
   */
  setupFullDiskAccess: () =>
    ipcRenderer.invoke("system:setup-full-disk-access"),

  /**
   * Opens macOS System Preferences to a specific privacy pane
   * @param pane - Privacy pane identifier (e.g., 'Privacy_AllFiles', 'Privacy_Contacts')
   * @returns Open result
   */
  openPrivacyPane: (pane: string) =>
    ipcRenderer.invoke("system:open-privacy-pane", pane),

  /**
   * Checks current Full Disk Access status
   * @returns Status check result
   */
  checkFullDiskAccessStatus: () =>
    ipcRenderer.invoke("system:check-full-disk-access-status"),

  /**
   * Checks if app has Full Disk Access permission
   * @returns Permission status
   */
  checkFullDiskAccess: () =>
    ipcRenderer.invoke("system:check-full-disk-access"),

  /**
   * Checks if app has Contacts permission
   * @returns Permission status
   */
  checkContactsPermission: () =>
    ipcRenderer.invoke("system:check-contacts-permission"),

  /**
   * Checks all required system permissions
   * @returns All permission statuses
   */
  checkAllPermissions: () =>
    ipcRenderer.invoke("system:check-all-permissions"),

  /**
   * Checks Google account connection and token validity
   * @param userId - User ID to check
   * @returns Connection status
   */
  checkGoogleConnection: (userId: string) =>
    ipcRenderer.invoke("system:check-google-connection", userId),

  /**
   * Checks Microsoft account connection and token validity
   * @param userId - User ID to check
   * @returns Connection status
   */
  checkMicrosoftConnection: (userId: string) =>
    ipcRenderer.invoke("system:check-microsoft-connection", userId),

  /**
   * Checks all email provider connections
   * @param userId - User ID to check
   * @returns All connection statuses
   */
  checkAllConnections: (userId: string) =>
    ipcRenderer.invoke("system:check-all-connections", userId),

  /**
   * Runs comprehensive health check for a provider
   * @param userId - User ID
   * @param provider - Provider to check ('google' or 'microsoft')
   * @returns Health check result
   */
  healthCheck: (userId: string, provider: string) =>
    ipcRenderer.invoke("system:health-check", userId, provider),

  /**
   * Opens support email with pre-filled content
   * @param errorDetails - Optional error details to include
   * @returns Result
   */
  contactSupport: (errorDetails?: string) =>
    ipcRenderer.invoke("system:contact-support", errorDetails),

  /**
   * Gets diagnostic information for support requests
   * @returns Diagnostic data
   */
  getDiagnostics: () => ipcRenderer.invoke("system:get-diagnostics"),

  /**
   * Shows a file in the system file manager (Finder on macOS, Explorer on Windows)
   * @param filePath - Absolute path to the file to show
   * @returns Result indicating success or failure
   */
  showInFolder: (filePath: string) =>
    ipcRenderer.invoke("system:show-in-folder", filePath),

  /**
   * Reindex the database for performance optimization
   * Rebuilds all performance indexes to help resolve slowness
   * @returns Result with index count and duration
   */
  reindexDatabase: () =>
    ipcRenderer.invoke("system:reindex-database") as Promise<{
      success: boolean;
      indexesRebuilt?: number;
      durationMs?: number;
      error?: string;
    }>,

  /**
   * Check if a user exists in the local database
   * BACKLOG-611: Used to determine if secure-storage step should be shown
   * even on machines with previous installs (different user)
   * @param userId - User ID to check
   * @returns Whether the user exists in the local DB
   */
  checkUserInLocalDb: (userId: string) =>
    ipcRenderer.invoke("system:check-user-in-local-db", userId) as Promise<{
      success: boolean;
      exists: boolean;
      error?: string;
    }>,

  // Initialization stage events (BACKLOG-1379: event-driven init protocol)

  /**
   * Subscribe to initialization stage change events.
   * Returns a cleanup function to unsubscribe.
   * @param callback - Called when initialization stage changes
   * @returns Cleanup function that removes the listener
   */
  onInitStage: (
    callback: (event: {
      stage: string;
      progress?: number;
      message?: string;
      error?: { message: string; retryable: boolean };
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        stage: string;
        progress?: number;
        message?: string;
        error?: { message: string; retryable: boolean };
      },
    ) => {
      callback(data);
    };
    ipcRenderer.on("system:init-stage", handler);
    return () => {
      ipcRenderer.removeListener("system:init-stage", handler);
    };
  },

  /**
   * Get the current initialization stage (for late-joining renderers).
   * @returns Current init stage event
   */
  getInitStage: () => ipcRenderer.invoke("system:get-init-stage"),

  // Spread dev-only diagnostics (empty object in production)
  ...devDiagnostics,
};
