// Jest setup file
import '@testing-library/jest-dom';
import { configure } from '@testing-library/dom';

// Configure testing-library to limit DOM output on errors
configure({
  getElementError: (message) => {
    const error = new Error(message);
    error.name = 'TestingLibraryElementError';
    return error;
  },
});

// Set DEBUG_PRINT_LIMIT to reduce DOM output
process.env.DEBUG_PRINT_LIMIT = '500';

// Limit stack trace depth in CI/CD for cleaner error output
if (process.env.CI) {
  Error.stackTraceLimit = 3; // Only show 3 stack frames in CI
}

// Mock window.api for tests (only in jsdom environment)
if (typeof window !== 'undefined') {
  global.window = global.window || {};
  global.window.api = {
    auth: {
      loginWithGoogle: jest.fn().mockResolvedValue({ success: true }),
      loginWithMicrosoft: jest.fn().mockResolvedValue({ success: true }),
      logout: jest.fn().mockResolvedValue({ success: true }),
      getCurrentUser: jest.fn().mockResolvedValue({ success: false }),
      acceptTerms: jest.fn().mockResolvedValue({ success: true }),
      googleLogin: jest.fn().mockResolvedValue({ success: true }),
      googleCompleteLogin: jest.fn().mockResolvedValue({ success: true }),
      microsoftLogin: jest.fn().mockResolvedValue({ success: true }),
      microsoftCompleteLogin: jest.fn().mockResolvedValue({ success: true }),
      googleConnectMailbox: jest.fn().mockResolvedValue({ success: true }),
      microsoftConnectMailbox: jest.fn().mockResolvedValue({ success: true }),
      googleDisconnectMailbox: jest.fn().mockResolvedValue({ success: true }),
      microsoftDisconnectMailbox: jest.fn().mockResolvedValue({ success: true }),
      checkEmailOnboarding: jest.fn().mockResolvedValue({ success: true, completed: false }),
      completeEmailOnboarding: jest.fn().mockResolvedValue({ success: true }),
      completePendingLogin: jest.fn().mockResolvedValue({ success: true }),
      // Pre-DB mailbox connection methods
      googleConnectMailboxPending: jest.fn().mockResolvedValue({ success: true }),
      microsoftConnectMailboxPending: jest.fn().mockResolvedValue({ success: true }),
      savePendingMailboxTokens: jest.fn().mockResolvedValue({ success: true }),
      acceptTermsToSupabase: jest.fn().mockResolvedValue({ success: true }),
    },
    transactions: {
      getAll: jest.fn(),
      getPendingCount: jest.fn(),
      create: jest.fn(),
      createAudited: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      getDetails: jest.fn(),
      assignContact: jest.fn(),
      removeContact: jest.fn(),
      exportEnhanced: jest.fn(),
      bulkDelete: jest.fn(),
      bulkUpdateStatus: jest.fn(),
      batchUpdateContacts: jest.fn(),
      onSubmissionStatusChanged: jest.fn().mockReturnValue(() => {}),
      getEarliestCommunicationDate: jest.fn().mockResolvedValue({ success: true, date: null }),
      // BACKLOG-1780/1781: RemovedEmailsSection refreshKey effect — needed in all test environments.
      getRemovedEmails: jest.fn().mockResolvedValue({ success: true, removedEmails: [] }),
      restoreRemovedEmail: jest.fn().mockResolvedValue({ success: true, restoredCount: 1 }),
      // BACKLOG-1793: RemovedMessagesSection now shares the same refreshKey/silent-refresh
      // machinery — needed in all test environments.
      getRemovedMessages: jest.fn().mockResolvedValue({ success: true, removedMessages: [] }),
      restoreRemovedMessage: jest.fn().mockResolvedValue({ success: true }),
    },
    contacts: {
      getAll: jest.fn(),
      getAvailable: jest.fn(),
      getSortedByActivity: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      import: jest.fn(),
      checkCanDelete: jest.fn(),
      delete: jest.fn(),
      remove: jest.fn(),
      // BACKLOG-1762: email -> contact display_name map for email views
      getEmailNameMap: jest.fn().mockResolvedValue({ success: true, nameMap: {} }),
      // BACKLOG-1589/1793: resolve phone/email handles to contact names (removed messages)
      resolveHandles: jest.fn().mockResolvedValue({ success: true, names: {} }),
    },
    system: {
      // Platform detection (migrated from window.electron.platform)
      platform: 'darwin',
      // App info (migrated from window.electron)
      getAppInfo: jest.fn().mockResolvedValue({ version: '2.0.8', name: 'Keepr' }),
      getMacOSVersion: jest.fn().mockResolvedValue({ version: '14.0' }),
      checkAppLocation: jest.fn().mockResolvedValue({ inApplications: true, path: '/Applications/Keepr.app' }),
      // Permission checks (migrated from window.electron)
      checkPermissions: jest.fn().mockResolvedValue({ fullDiskAccess: true, contacts: true }),
      triggerFullDiskAccess: jest.fn().mockResolvedValue({ granted: true }),
      requestPermissions: jest.fn().mockResolvedValue({ granted: true }),
      openSystemSettings: jest.fn().mockResolvedValue({ success: true }),
      // Existing system methods
      checkFullDiskAccess: jest.fn().mockResolvedValue({ granted: true }),
      checkContactsPermission: jest.fn().mockResolvedValue({ granted: true }),
      checkAllPermissions: jest.fn().mockResolvedValue({ allGranted: true, permissions: {} }),
      checkGoogleConnection: jest.fn().mockResolvedValue({ connected: false }),
      checkMicrosoftConnection: jest.fn().mockResolvedValue({ connected: false }),
      checkAllConnections: jest.fn().mockResolvedValue({ success: true }),
      healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
      openPrivacyPane: jest.fn().mockResolvedValue(undefined),
      contactSupport: jest.fn().mockResolvedValue({ success: true }),
      getDiagnostics: jest.fn().mockResolvedValue({ success: true, diagnostics: '' }),
      hasEncryptionKeyStore: jest.fn().mockResolvedValue({ success: true, hasKeyStore: false }),
      initializeSecureStorage: jest.fn().mockResolvedValue({ success: true, available: true }),
      getSecureStorageStatus: jest.fn().mockResolvedValue({ success: true, available: true }),
      setupFullDiskAccess: jest.fn().mockResolvedValue(undefined),
      reindexDatabase: jest.fn().mockResolvedValue({ success: true }),
      // BACKLOG-611: Check if user exists in local DB
      checkUserInLocalDb: jest.fn().mockResolvedValue({ success: true, exists: false }),
      // BACKLOG-1383: Event-driven init
      verifyUserInLocalDb: jest.fn().mockResolvedValue({ success: true, userId: 'test-user-123' }),
      isDatabaseInitialized: jest.fn().mockResolvedValue({ success: true, initialized: true }),
      onInitStage: jest.fn().mockReturnValue(() => {}),
      getInitStage: jest.fn().mockResolvedValue({ stage: 'complete' }),
      initializeDatabase: jest.fn().mockResolvedValue({ success: true }),
    },
    address: {
      initialize: jest.fn(),
      getSuggestions: jest.fn(),
      getDetails: jest.fn(),
    },
    preferences: {
      get: jest.fn(),
      update: jest.fn(),
    },
    llm: {
      getConfig: jest.fn(),
      setApiKey: jest.fn(),
      validateKey: jest.fn(),
      removeApiKey: jest.fn(),
      updatePreferences: jest.fn(),
      recordConsent: jest.fn(),
      getUsage: jest.fn(),
      canUse: jest.fn(),
    },
    feedback: {
      submit: jest.fn(),
      getForTransaction: jest.fn(),
      getMetrics: jest.fn(),
      getSuggestion: jest.fn(),
      getLearningStats: jest.fn(),
      recordTransaction: jest.fn(),
      recordRole: jest.fn(),
      recordRelevance: jest.fn(),
      getStats: jest.fn(),
    },
    user: {
      getPhoneType: jest.fn().mockResolvedValue({ success: true, phoneType: null }),
      setPhoneType: jest.fn().mockResolvedValue({ success: true }),
      // TASK-1600: Cloud phone type storage (Supabase)
      getPhoneTypeCloud: jest.fn().mockResolvedValue({ success: true, phoneType: null }),
      setPhoneTypeCloud: jest.fn().mockResolvedValue({ success: true }),
    },
    shell: {
      openExternal: jest.fn(),
      openFolder: jest.fn(),
    },
    // iMessage conversations (macOS) - migrated from window.electron
    messages: {
      getConversations: jest.fn(),
      getMessages: jest.fn(),
      exportConversations: jest.fn(),
      // macOS Messages import (TASK-987)
      importMacOSMessages: jest.fn(),
      getImportCount: jest.fn(),
      onImportProgress: jest.fn(() => jest.fn()),
    },
    // Outlook integration - migrated from window.electron
    outlook: {
      initialize: jest.fn(),
      isAuthenticated: jest.fn(),
      authenticate: jest.fn(),
      getUserEmail: jest.fn(),
      exportEmails: jest.fn(),
      onDeviceCode: jest.fn(() => jest.fn()),
      onExportProgress: jest.fn(() => jest.fn()),
    },
    // Desktop notification support (TASK-1972)
    notification: {
      isSupported: jest.fn().mockResolvedValue(true),
      send: jest.fn().mockResolvedValue(undefined),
    },
    // Auto-update functionality - migrated from window.electron
    update: {
      onAvailable: jest.fn(() => jest.fn()),
      onProgress: jest.fn(() => jest.fn()),
      onDownloaded: jest.fn(() => jest.fn()),
      install: jest.fn(),
    },
    // Apple drivers (Windows only)
    drivers: {
      checkApple: jest.fn(),
      installApple: jest.fn(),
      hasBundled: jest.fn(),
      openITunesStore: jest.fn(),
      checkUpdate: jest.fn(),
    },
    // Android companion pairing (BACKLOG-1447)
    pairing: {
      generateQR: jest.fn().mockResolvedValue({
        success: true,
        result: {
          qrDataUrl: 'data:image/png;base64,mock',
          pairingInfo: { ip: '192.168.1.1', port: 8384, secret: 'mock-secret', deviceName: 'Test PC' },
        },
      }),
      getStatus: jest.fn().mockResolvedValue({
        success: true,
        status: { isPaired: false, devices: [] },
      }),
      disconnect: jest.fn().mockResolvedValue({ success: true }),
    },
    // Android companion local sync (BACKLOG-1447)
    localSync: {
      startServer: jest.fn().mockResolvedValue({ success: true }),
      stopServer: jest.fn().mockResolvedValue({ success: true }),
      getStatus: jest.fn().mockResolvedValue({
        running: false,
        port: null,
        address: null,
        totalMessagesReceived: 0,
        lastSyncTimestamp: null,
      }),
    },
    // SPRINT-127 / TASK-2160: Feature gate (plan-based feature access)
    featureGate: {
      getAll: jest.fn().mockResolvedValue({}),
      check: jest.fn().mockResolvedValue({ allowed: true, value: '', source: 'default' }),
      invalidateCache: jest.fn().mockResolvedValue(undefined),
    },
    onTransactionScanProgress: jest.fn(() => jest.fn()),
    // BACKLOG-1832: background auto-sync lifecycle events
    onTransactionAutoSyncStarted: jest.fn(() => jest.fn()),
    onTransactionAutoSyncComplete: jest.fn(() => jest.fn()),
    onGoogleMailboxConnected: jest.fn(() => jest.fn()),
    onMicrosoftMailboxConnected: jest.fn(() => jest.fn()),
    onGoogleMailboxDisconnected: jest.fn(() => jest.fn()),
    onMicrosoftMailboxDisconnected: jest.fn(() => jest.fn()),
    onMicrosoftLoginComplete: jest.fn(() => jest.fn()),
    onGoogleMailboxCancelled: jest.fn(() => jest.fn()),
    onMicrosoftMailboxCancelled: jest.fn(() => jest.fn()),
    // Pre-DB mailbox connection event listeners
    onGoogleMailboxPendingConnected: jest.fn(() => jest.fn()),
    onMicrosoftMailboxPendingConnected: jest.fn(() => jest.fn()),
    onGoogleMailboxPendingCancelled: jest.fn(() => jest.fn()),
    onMicrosoftMailboxPendingCancelled: jest.fn(() => jest.fn()),
    onGoogleLoginComplete: jest.fn(() => jest.fn()),
    onGoogleLoginPending: jest.fn(() => jest.fn()),
    onGoogleLoginCancelled: jest.fn(() => jest.fn()),
    onMicrosoftLoginPending: jest.fn(() => jest.fn()),
    onMicrosoftLoginCancelled: jest.fn(() => jest.fn()),
  };

  // Mock electron for tests
  global.window.electron = {
    platform: 'darwin', // Default to macOS for tests (can be overridden in specific tests)
    getAppInfo: jest.fn(),
    getMacOSVersion: jest.fn(),
    checkPermissions: jest.fn(),
    openSystemSettings: jest.fn(),
    checkAppLocation: jest.fn(),
    getConversations: jest.fn(),
    outlookInitialize: jest.fn(),
    outlookIsAuthenticated: jest.fn(),
    outlookAuthenticate: jest.fn(),
    outlookGetUserEmail: jest.fn(),
    outlookExportEmails: jest.fn(),
    openFolder: jest.fn(),
    onExportProgress: jest.fn(() => jest.fn()),
    // iOS Device Detection (Windows only)
    device: {
      startDetection: jest.fn(),
      stopDetection: jest.fn(),
      onConnected: jest.fn(() => jest.fn()),
      onDisconnected: jest.fn(() => jest.fn()),
    },
    // iOS Backup Management (Windows only)
    backup: {
      start: jest.fn(),
      submitPassword: jest.fn(),
      cancel: jest.fn(),
      onProgress: jest.fn(() => jest.fn()),
    },
    // Apple Driver Management (Windows only)
    drivers: {
      checkApple: jest.fn(),
      installApple: jest.fn(),
      hasBundled: jest.fn(),
      openITunesStore: jest.fn(),
      checkUpdate: jest.fn(),
    },
  };
}

// Suppress console output in tests to reduce noise
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

// Global cleanup to prevent Jest from hanging
// Many tests use setTimeout which keeps the Node.js event loop alive
afterAll(() => {
  // Clear any pending timers
  jest.clearAllTimers();
  // Ensure real timers are restored
  try {
    jest.useRealTimers();
  } catch (_e) {
    // Already using real timers, ignore
  }
});
