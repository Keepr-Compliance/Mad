/**
 * SyncOrchestratorService Tests
 *
 * TASK-2073: Tests for isRunning state transitions after sync completion.
 *
 * Key test cases:
 * 1. isRunning transitions to false after all sync items complete
 * 2. isRunning transitions to false after all sync items error
 * 3. isRunning transitions to false when sync is cancelled
 * 4. isRunning transitions to false even if startSync throws unexpectedly
 * 5. isRunning remains false when no sync functions are registered
 */

import type { SyncType } from '../SyncOrchestratorService';

// We need to test the class directly, so we import and construct a fresh instance.
// The module auto-initializes on import (calls initializeSyncFunctions), which
// requires window.api. We mock the minimum needed.

// Mock logger
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock Sentry
jest.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: jest.fn(),
}));

// Mock platform
jest.mock('../../utils/platform', () => ({
  isMacOS: jest.fn(() => false),
}));

// Mock window.api to prevent auto-initialization from failing
Object.defineProperty(global, 'window', {
  value: {
    api: {
      preferences: { get: jest.fn() },
      contacts: { syncExternal: jest.fn(), syncOutlookContacts: jest.fn(), forceReimport: jest.fn() },
      transactions: { scan: jest.fn(), precacheEmails: jest.fn().mockResolvedValue({ success: true }) },
      messages: { importMacOSMessages: jest.fn(), onImportProgress: jest.fn() },
      notification: { send: jest.fn() },
      system: { reindexDatabase: jest.fn() },
      databaseBackup: { backup: jest.fn(), restore: jest.fn() },
      privacy: { exportData: jest.fn(), onExportProgress: jest.fn() },
    },
  },
  writable: true,
});

// Now import after mocks are set up
// Use require to get fresh module per test via jest.isolateModules if needed
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncOrchestrator } = require('../SyncOrchestratorService');

describe('SyncOrchestratorService', () => {
  let stateHistory: Array<{ isRunning: boolean; currentSync: SyncType | null }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    // Reset the orchestrator state
    syncOrchestrator.reset();

    // Clear any registered sync functions by re-initializing
    // Access private map for testing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (syncOrchestrator as any).syncFunctions = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (syncOrchestrator as any).initialized = false;

    // Track state changes
    stateHistory = [];
    unsubscribe = syncOrchestrator.subscribe((state: { isRunning: boolean; currentSync: SyncType | null }) => {
      stateHistory.push({
        isRunning: state.isRunning,
        currentSync: state.currentSync,
      });
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  describe('isRunning state transitions', () => {
    it('should transition isRunning to false after all sync items complete successfully', async () => {
      // Register a sync function that resolves immediately
      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, onProgress: (p: number) => void) => {
        onProgress(50);
        onProgress(100);
      });

      const result = syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      expect(result.started).toBe(true);

      // Wait for async startSync to complete
      // Since startSync is fire-and-forget, we need to flush microtasks
      await new Promise(resolve => setTimeout(resolve, 0));

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);
      expect(state.currentSync).toBeNull();

      // Verify the state history shows the transition: true -> false
      const isRunningHistory = stateHistory.map(s => s.isRunning);
      expect(isRunningHistory[0]).toBe(true); // First state change sets isRunning to true
      expect(isRunningHistory[isRunningHistory.length - 1]).toBe(false); // Last state change sets it to false
    });

    it('should transition isRunning to false after multiple sync items complete', async () => {
      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, onProgress: (p: number) => void) => {
        onProgress(100);
      });
      syncOrchestrator.registerSyncFunction('emails', async (_userId: string, onProgress: (p: number) => void) => {
        onProgress(100);
      });

      syncOrchestrator.requestSync({ types: ['contacts', 'emails'], userId: 'test-user' });

      await new Promise(resolve => setTimeout(resolve, 0));

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);
      expect(state.currentSync).toBeNull();
      // Both items should be complete
      expect(state.queue).toHaveLength(2);
      expect(state.queue[0].status).toBe('complete');
      expect(state.queue[1].status).toBe('complete');
    });

    it('should transition isRunning to false after all sync items error', async () => {
      syncOrchestrator.registerSyncFunction('contacts', async () => {
        throw new Error('Contacts sync failed');
      });
      syncOrchestrator.registerSyncFunction('emails', async () => {
        throw new Error('Emails sync failed');
      });

      syncOrchestrator.requestSync({ types: ['contacts', 'emails'], userId: 'test-user' });

      await new Promise(resolve => setTimeout(resolve, 0));

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);
      expect(state.currentSync).toBeNull();
      expect(state.queue[0].status).toBe('error');
      expect(state.queue[0].error).toBe('Contacts sync failed');
      expect(state.queue[1].status).toBe('error');
      expect(state.queue[1].error).toBe('Emails sync failed');
    });

    it('should transition isRunning to false after partial completion (some succeed, some error)', async () => {
      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, onProgress: (p: number) => void) => {
        onProgress(100);
      });
      syncOrchestrator.registerSyncFunction('emails', async () => {
        throw new Error('Email sync failed');
      });

      syncOrchestrator.requestSync({ types: ['contacts', 'emails'], userId: 'test-user' });

      await new Promise(resolve => setTimeout(resolve, 0));

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);
      expect(state.currentSync).toBeNull();
      expect(state.queue[0].status).toBe('complete');
      expect(state.queue[1].status).toBe('error');
    });

    it('should NOT set isRunning to true when no sync functions are registered', async () => {
      // No sync functions registered, request types that don't exist
      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });

      // requestSync calls startSync which returns early for empty validTypes
      // But requestSync returns { started: true } because it's not checking validTypes
      // The important thing is isRunning stays false
      await new Promise(resolve => setTimeout(resolve, 0));

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);

      // State history should not contain isRunning: true since startSync returns
      // before setting it
      const hasRunning = stateHistory.some(s => s.isRunning === true);
      expect(hasRunning).toBe(false);
    });

    it('should transition isRunning to false after cancellation', async () => {
      let resolveSync: (() => void) | null = null;
      syncOrchestrator.registerSyncFunction('contacts', async () => {
        // This sync will hang until we resolve it
        await new Promise<void>(resolve => {
          resolveSync = resolve;
        });
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });

      // Give the sync a tick to start
      await new Promise(resolve => setTimeout(resolve, 0));

      // Verify it's running
      expect(syncOrchestrator.getState().isRunning).toBe(true);

      // Cancel the sync
      syncOrchestrator.cancel();

      // isRunning should be false after cancel
      expect(syncOrchestrator.getState().isRunning).toBe(false);

      // Clean up - resolve the pending promise
      if (resolveSync) resolveSync();
    });

    it('should transition isRunning to false even if sync function throws non-Error', async () => {
      syncOrchestrator.registerSyncFunction('contacts', async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'string error';
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });

      await new Promise(resolve => setTimeout(resolve, 0));

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);
      expect(state.queue[0].status).toBe('error');
      expect(state.queue[0].error).toBe('Unknown error');
    });
  });

  describe('requestSync queuing', () => {
    it('should queue request when sync is already running', async () => {
      let resolveSync: (() => void) | null = null;
      syncOrchestrator.registerSyncFunction('contacts', async () => {
        await new Promise<void>(resolve => {
          resolveSync = resolve;
        });
      });

      // Start first sync
      const first = syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      expect(first.started).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 0));

      // Try second sync while first is running
      const second = syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      expect(second.started).toBe(false);
      expect(second.needsConfirmation).toBe(true);

      // Clean up
      syncOrchestrator.cancel();
      if (resolveSync) resolveSync();
    });
  });

  // ===========================================================================
  // BACKLOG-2127: emails item must ERROR on a dead OAuth token (providerError)
  // instead of completing green with "0 new messages".
  // ===========================================================================

  describe('emails auth-failure handling (BACKLOG-2127)', () => {
    beforeEach(() => {
      // Use the REAL registered 'emails' sync function so we exercise the
      // actual providerError → throw path, not a test double.
      (window as any).api.transactions.scan = jest.fn().mockResolvedValue({ success: true });
      syncOrchestrator.initializeSyncFunctions();
    });

    it("errors the emails item with a provider-named reconnect message when precache reports a dead Outlook token", async () => {
      (window as any).api.transactions.precacheEmails = jest.fn().mockResolvedValue({
        success: false,
        emailsFetched: 0,
        emailsStored: 0,
        providerError: { provider: 'microsoft', message: 'expired', tokenExpired: true },
      });

      syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const emailsItem = syncOrchestrator.getState().queue.find(q => q.type === 'emails');
      expect(emailsItem?.status).toBe('error');
      expect(emailsItem?.error).toBe('Outlook connection expired — reconnect to sync email');
      // BACKLOG-2127: typed reconnect discriminator carried onto the item so the
      // UI can render a "Reconnect Outlook" CTA without parsing the message.
      expect(emailsItem?.reconnectProvider).toBe('microsoft');
    });

    it("errors the emails item with a Gmail-specific message for a dead Gmail token", async () => {
      (window as any).api.transactions.precacheEmails = jest.fn().mockResolvedValue({
        success: false,
        providerError: { provider: 'google', message: 'expired', tokenExpired: true },
      });

      syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const emailsItem = syncOrchestrator.getState().queue.find(q => q.type === 'emails');
      expect(emailsItem?.status).toBe('error');
      expect(emailsItem?.error).toBe('Gmail connection expired — reconnect to sync email');
      // BACKLOG-2127: typed reconnect discriminator (Gmail).
      expect(emailsItem?.reconnectProvider).toBe('google');
    });

    it('completes the emails item (not error) on a clean precache with no providerError', async () => {
      (window as any).api.transactions.precacheEmails = jest.fn().mockResolvedValue({
        success: true,
        emailsFetched: 0,
        emailsStored: 0,
      });

      syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const emailsItem = syncOrchestrator.getState().queue.find(q => q.type === 'emails');
      expect(emailsItem?.status).toBe('complete');
    });

    it('completes the emails item on a transient (non-auth) precache failure — stays non-fatal', async () => {
      (window as any).api.transactions.precacheEmails = jest
        .fn()
        .mockRejectedValue(new Error('network timeout'));

      syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const emailsItem = syncOrchestrator.getState().queue.find(q => q.type === 'emails');
      expect(emailsItem?.status).toBe('complete');
    });

    it('keeps the AI scan non-fatal — scan failure alone does not error the emails item', async () => {
      (window as any).api.transactions.scan = jest
        .fn()
        .mockRejectedValue(new Error('scan boom'));
      (window as any).api.transactions.precacheEmails = jest.fn().mockResolvedValue({
        success: true,
      });

      syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const emailsItem = syncOrchestrator.getState().queue.find(q => q.type === 'emails');
      expect(emailsItem?.status).toBe('complete');
    });
  });

  // ===========================================================================
  // BACKLOG-2142: contacts item must ERROR (partial success) on a dead cloud
  // OAuth token — surfacing a provider-aware reconnect CTA — but only AFTER
  // macOS + BOTH cloud phases have run (macOS contacts persist; both cloud
  // providers attempted). Non-token failures stay non-fatal (item completes).
  // ===========================================================================

  describe('contacts auth-failure handling (BACKLOG-2142)', () => {
    beforeEach(() => {
      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);
      (window as any).api.contacts.syncExternal = jest.fn().mockResolvedValue({ success: true });
      (window as any).api.contacts.syncOutlookContacts = jest.fn().mockResolvedValue({ success: true, count: 5 });
      (window as any).api.contacts.syncGoogleContacts = jest.fn().mockResolvedValue({ success: true, count: 5 });
      (window as any).api.preferences.get = jest.fn().mockResolvedValue({ success: true, preferences: {} });
      syncOrchestrator.initializeSyncFunctions();
    });

    it("errors the contacts item with reconnectProvider 'microsoft' when Outlook contacts report a dead token", async () => {
      (window as any).api.contacts.syncOutlookContacts = jest.fn().mockResolvedValue({
        success: false,
        tokenExpired: true,
        error: 'Outlook token expired',
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const item = syncOrchestrator.getState().queue.find(q => q.type === 'contacts');
      expect(item?.status).toBe('error');
      expect(item?.error).toBe('Outlook connection expired — reconnect to sync contacts');
      expect(item?.reconnectProvider).toBe('microsoft');
    });

    it("errors the contacts item with reconnectProvider 'google' for a dead Gmail contacts token", async () => {
      (window as any).api.contacts.syncGoogleContacts = jest.fn().mockResolvedValue({
        success: false,
        tokenExpired: true,
        error: 'Gmail token expired',
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const item = syncOrchestrator.getState().queue.find(q => q.type === 'contacts');
      expect(item?.status).toBe('error');
      expect(item?.error).toBe('Gmail connection expired — reconnect to sync contacts');
      expect(item?.reconnectProvider).toBe('google');
    });

    it('runs macOS + BOTH cloud phases before erroring on a dead Outlook token (partial success)', async () => {
      (window as any).api.contacts.syncOutlookContacts = jest.fn().mockResolvedValue({
        success: false,
        tokenExpired: true,
        error: 'Outlook token expired',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      await expect(syncFn('test-user', jest.fn())).rejects.toThrow(
        'Outlook connection expired — reconnect to sync contacts',
      );

      // macOS contacts persisted (Phase 1 ran) and Google was still attempted
      // (Phase 3 not short-circuited) even though Outlook's token was dead.
      expect((window as any).api.contacts.syncExternal).toHaveBeenCalledWith('test-user');
      expect((window as any).api.contacts.syncGoogleContacts).toHaveBeenCalledWith('test-user');
    });

    it('prefers the first failing provider (Outlook) when BOTH cloud tokens are dead', async () => {
      (window as any).api.contacts.syncOutlookContacts = jest.fn().mockResolvedValue({
        success: false, tokenExpired: true, error: 'Outlook token expired',
      });
      (window as any).api.contacts.syncGoogleContacts = jest.fn().mockResolvedValue({
        success: false, tokenExpired: true, error: 'Gmail token expired',
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const item = syncOrchestrator.getState().queue.find(q => q.type === 'contacts');
      expect(item?.status).toBe('error');
      expect(item?.reconnectProvider).toBe('microsoft');
    });

    it('completes the contacts item (not error) when a cloud provider fails WITHOUT a dead token', async () => {
      (window as any).api.contacts.syncOutlookContacts = jest.fn().mockResolvedValue({
        success: false,
        reconnectRequired: true, // scope-missing, NOT a dead token
        error: 'Contacts permission not granted',
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const item = syncOrchestrator.getState().queue.find(q => q.type === 'contacts');
      expect(item?.status).toBe('complete');
      expect(item?.reconnectProvider).toBeUndefined();
    });

    it('completes the contacts item on a clean sync of all sources', async () => {
      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const item = syncOrchestrator.getState().queue.find(q => q.type === 'contacts');
      expect(item?.status).toBe('complete');
      expect(item?.reconnectProvider).toBeUndefined();
    });
  });

  // ===========================================================================
  // TASK-2098: Contact Source Preference Tests
  // ===========================================================================

  describe('contact source preferences (TASK-2098)', () => {
    beforeEach(() => {
      // Add syncExternal and syncOutlookContacts mocks
      (window as any).api.contacts.syncExternal = jest.fn().mockResolvedValue({ success: true });
      (window as any).api.contacts.syncOutlookContacts = jest.fn().mockResolvedValue({ success: true, count: 5 });
      (window as any).api.preferences.get = jest.fn().mockResolvedValue({ success: true, preferences: {} });

      // Mock isMacOS to return true for these tests
      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);
    });

    it('should skip macOS Contacts phase when macosContacts preference is false', async () => {
      (window as any).api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          contactSources: {
            direct: { macosContacts: false, outlookContacts: true },
          },
        },
      });

      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      expect(syncFn).toBeDefined();

      await syncFn('test-user', jest.fn());

      // macOS Contacts sync should NOT have been called
      expect((window as any).api.contacts.syncExternal).not.toHaveBeenCalled();
      // Outlook sync SHOULD have been called
      expect((window as any).api.contacts.syncOutlookContacts).toHaveBeenCalledWith('test-user');
    });

    it('should skip Outlook phase when outlookContacts preference is false', async () => {
      (window as any).api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          contactSources: {
            direct: { macosContacts: true, outlookContacts: false },
          },
        },
      });

      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      await syncFn('test-user', jest.fn());

      // Outlook sync should NOT have been called
      expect((window as any).api.contacts.syncOutlookContacts).not.toHaveBeenCalled();
      // macOS Contacts SHOULD have been called
      expect((window as any).api.contacts.syncExternal).toHaveBeenCalledWith('test-user');
    });

    it('should default to all sources enabled when preferences not set', async () => {
      (window as any).api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {},
      });

      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      await syncFn('test-user', jest.fn());

      // Both should run (fail-open defaults)
      expect((window as any).api.contacts.syncExternal).toHaveBeenCalledWith('test-user');
      expect((window as any).api.contacts.syncOutlookContacts).toHaveBeenCalledWith('test-user');
    });

    it('should default to all sources enabled when preferences.get fails', async () => {
      (window as any).api.preferences.get.mockRejectedValue(new Error('DB unavailable'));

      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      await syncFn('test-user', jest.fn());

      // Both should run (fail-open on error)
      expect((window as any).api.contacts.syncExternal).toHaveBeenCalledWith('test-user');
      expect((window as any).api.contacts.syncOutlookContacts).toHaveBeenCalledWith('test-user');
    });

    it('should make only one preferences.get call per contacts sync (no duplicate IPC)', async () => {
      (window as any).api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: 'macos-native' },
          contactSources: {
            direct: { macosContacts: true, outlookContacts: true },
          },
        },
      });

      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      await syncFn('test-user', jest.fn());

      // Should only call preferences.get ONCE (consolidated call)
      expect((window as any).api.preferences.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscriber notifications', () => {
    it('should notify subscribers of all state transitions including final isRunning=false', async () => {
      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, onProgress: (p: number) => void) => {
        onProgress(50);
        onProgress(100);
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });

      await new Promise(resolve => setTimeout(resolve, 0));

      // Verify we received notifications
      expect(stateHistory.length).toBeGreaterThan(0);

      // First notification should have isRunning: true
      expect(stateHistory[0].isRunning).toBe(true);

      // Last notification should have isRunning: false
      expect(stateHistory[stateHistory.length - 1].isRunning).toBe(false);
      expect(stateHistory[stateHistory.length - 1].currentSync).toBeNull();
    });
  });

  // ===========================================================================
  // TASK-2119: External Sync Registration API Tests
  // ===========================================================================

  describe('external sync API (TASK-2119)', () => {
    it('should register an external sync and set isRunning to true', () => {
      syncOrchestrator.registerExternalSync('iphone');

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(true);
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0]).toMatchObject({
        type: 'iphone',
        status: 'running',
        progress: 0,
        external: true,
      });
    });

    it('should be idempotent -- re-registering a running external sync is a no-op', () => {
      syncOrchestrator.registerExternalSync('iphone');
      syncOrchestrator.registerExternalSync('iphone');

      const state = syncOrchestrator.getState();
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0].type).toBe('iphone');
    });

    it('should replace a completed external sync when re-registering', () => {
      syncOrchestrator.registerExternalSync('iphone');
      syncOrchestrator.completeExternalSync('iphone', { status: 'complete' });

      // Re-register (e.g., new sync started)
      syncOrchestrator.registerExternalSync('iphone');

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(true);
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0].status).toBe('running');
    });

    it('should update progress/phase of an external sync', () => {
      syncOrchestrator.registerExternalSync('iphone');

      syncOrchestrator.updateExternalSync('iphone', { progress: 45, phase: 'Importing' });

      const state = syncOrchestrator.getState();
      expect(state.queue[0].progress).toBe(45);
      expect(state.queue[0].phase).toBe('Importing');
    });

    it('should ignore update for non-existent external sync', () => {
      // No external sync registered, so this should be a no-op
      syncOrchestrator.updateExternalSync('iphone', { progress: 50 });

      const state = syncOrchestrator.getState();
      expect(state.queue).toHaveLength(0);
    });

    it('should complete an external sync and set isRunning to false', () => {
      syncOrchestrator.registerExternalSync('iphone');
      expect(syncOrchestrator.getState().isRunning).toBe(true);

      syncOrchestrator.completeExternalSync('iphone', { status: 'complete' });

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);
      expect(state.queue[0].status).toBe('complete');
      expect(state.queue[0].progress).toBe(100);
    });

    it('should complete an external sync with error', () => {
      syncOrchestrator.registerExternalSync('iphone');

      syncOrchestrator.completeExternalSync('iphone', { status: 'error', error: 'Device disconnected' });

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);
      expect(state.queue[0].status).toBe('error');
      expect(state.queue[0].error).toBe('Device disconnected');
    });

    it('should NOT cancel external syncs when cancel() is called', () => {
      syncOrchestrator.registerExternalSync('iphone');
      expect(syncOrchestrator.getState().isRunning).toBe(true);

      syncOrchestrator.cancel();

      const state = syncOrchestrator.getState();
      // External item should still be in the queue
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0].type).toBe('iphone');
      expect(state.queue[0].status).toBe('running');
      // isRunning should still be true because external sync is still running
      expect(state.isRunning).toBe(true);
    });

    it('should keep external sync in queue when internal sync starts', async () => {
      // Register iPhone external sync first
      syncOrchestrator.registerExternalSync('iphone');

      // Register and start internal contacts sync
      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, onProgress: (p: number) => void) => {
        onProgress(100);
      });

      // BACKLOG-855: requestSync no longer blocks when only external syncs are running
      const result = syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      expect(result.started).toBe(true);
      expect(result.needsConfirmation).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 0));

      const state = syncOrchestrator.getState();
      // iPhone should still be in queue alongside contacts
      const iPhoneItem = state.queue.find(item => item.type === 'iphone');
      expect(iPhoneItem).toBeDefined();
      expect(iPhoneItem!.status).toBe('running');
      expect(iPhoneItem!.external).toBe(true);

      // isRunning should be true because iPhone is still running
      expect(state.isRunning).toBe(true);
    });

    it('should set isRunning to false when both internal and external syncs complete', async () => {
      // Register iPhone external sync
      syncOrchestrator.registerExternalSync('iphone');

      // Register and start internal contacts sync
      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, onProgress: (p: number) => void) => {
        onProgress(100);
      });

      // BACKLOG-855: requestSync works when only external syncs are running
      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      // iPhone is still running, so isRunning should be true
      expect(syncOrchestrator.getState().isRunning).toBe(true);

      // Now complete iPhone sync
      syncOrchestrator.completeExternalSync('iphone', { status: 'complete' });

      const state = syncOrchestrator.getState();
      expect(state.isRunning).toBe(false);
    });

    it('should allow requestSync when only external syncs are running (BACKLOG-855)', async () => {
      // Register iPhone external sync (sets isRunning = true)
      syncOrchestrator.registerExternalSync('iphone');
      expect(syncOrchestrator.getState().isRunning).toBe(true);

      // Register an internal sync function
      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, onProgress: (p: number) => void) => {
        onProgress(100);
      });

      // requestSync should start immediately, NOT queue as pending
      const result = syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      expect(result.started).toBe(true);
      expect(result.needsConfirmation).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 0));

      // Both should be in the queue
      const state = syncOrchestrator.getState();
      const iphone = state.queue.find(item => item.type === 'iphone');
      const contacts = state.queue.find(item => item.type === 'contacts');
      expect(iphone).toBeDefined();
      expect(iphone!.status).toBe('running');
      expect(contacts).toBeDefined();
      expect(contacts!.status).toBe('complete');
    });

    it('should still block requestSync when an internal sync is running', async () => {
      let resolveSync: (() => void) | null = null;
      syncOrchestrator.registerSyncFunction('contacts', async () => {
        await new Promise<void>(resolve => {
          resolveSync = resolve;
        });
      });

      // Start an internal sync
      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(syncOrchestrator.getState().isRunning).toBe(true);

      // Try to request another sync - should be blocked by the internal running sync
      const result = syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      expect(result.started).toBe(false);
      expect(result.needsConfirmation).toBe(true);

      // Clean up
      syncOrchestrator.cancel();
      if (resolveSync) resolveSync();
    });
  });

  // ===========================================================================
  // TASK-2150: New sync types and options tests
  // ===========================================================================

  describe('SyncRequest options (TASK-2150)', () => {
    it('should pass options through to sync function', async () => {
      const syncFn = jest.fn().mockResolvedValue(undefined);
      syncOrchestrator.registerSyncFunction('contacts', syncFn);

      syncOrchestrator.requestSync({
        types: ['contacts'],
        userId: 'test-user',
        options: { forceReimport: true },
      });

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(syncFn).toHaveBeenCalledWith(
        'test-user',
        expect.any(Function),
        { forceReimport: true },
        expect.any(Object), // AbortSignal
      );
    });

    it('should pass undefined options when not provided', async () => {
      const syncFn = jest.fn().mockResolvedValue(undefined);
      syncOrchestrator.registerSyncFunction('emails', syncFn);

      syncOrchestrator.requestSync({
        types: ['emails'],
        userId: 'test-user',
      });

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(syncFn).toHaveBeenCalledWith(
        'test-user',
        expect.any(Function),
        undefined,
        expect.any(Object), // AbortSignal
      );
    });
  });

  // ===========================================================================
  // TASK-2151: AbortSignal propagation tests
  // ===========================================================================

  describe('AbortSignal propagation (TASK-2151)', () => {
    it('should pass AbortSignal to sync functions', async () => {
      let receivedSignal: AbortSignal | undefined;
      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, onProgress: (p: number) => void, _options?: unknown, signal?: AbortSignal) => {
        receivedSignal = signal;
        onProgress(100);
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal!.aborted).toBe(false);
    });

    it('should abort the signal when cancel() is called', async () => {
      let receivedSignal: AbortSignal | undefined;
      let resolveSync: (() => void) | null = null;

      syncOrchestrator.registerSyncFunction('contacts', async (_userId: string, _onProgress: (p: number) => void, _options?: unknown, signal?: AbortSignal) => {
        receivedSignal = signal;
        await new Promise<void>(resolve => {
          resolveSync = resolve;
        });
      });

      syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(false);

      // Cancel the sync
      syncOrchestrator.cancel();

      // The signal should now be aborted
      expect(receivedSignal!.aborted).toBe(true);

      // Clean up
      if (resolveSync) resolveSync();
    });

    it('should skip sync function when signal is already aborted before execution', async () => {
      const syncFn1 = jest.fn().mockImplementation(async (_userId: string, _onProgress: (p: number) => void) => {
        // First sync runs, then we cancel
        syncOrchestrator.cancel();
      });
      const syncFn2 = jest.fn().mockResolvedValue(undefined);

      syncOrchestrator.registerSyncFunction('contacts', syncFn1);
      syncOrchestrator.registerSyncFunction('emails', syncFn2);

      syncOrchestrator.requestSync({ types: ['contacts', 'emails'], userId: 'test-user' });
      await new Promise(resolve => setTimeout(resolve, 0));

      // contacts sync ran
      expect(syncFn1).toHaveBeenCalled();
      // emails sync should NOT have run because signal was aborted
      expect(syncFn2).not.toHaveBeenCalled();
    });
  });

  describe('new sync types (TASK-2150)', () => {
    it('should register and execute reindex sync function', async () => {
      (window as any).api.system.reindexDatabase.mockResolvedValue({ success: true });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('reindex');
      expect(syncFn).toBeDefined();

      const onProgress = jest.fn();
      await syncFn('test-user', onProgress);

      expect((window as any).api.system.reindexDatabase).toHaveBeenCalled();
      expect(onProgress).toHaveBeenCalledWith(0, 'optimizing');
      expect(onProgress).toHaveBeenCalledWith(100);
    });

    it('should throw on reindex failure', async () => {
      (window as any).api.system.reindexDatabase.mockResolvedValue({
        success: false,
        error: 'DB locked',
      });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('reindex');
      await expect(syncFn('test-user', jest.fn())).rejects.toThrow('DB locked');
    });

    it('should register and execute backup sync function', async () => {
      (window as any).api.databaseBackup.backup.mockResolvedValue({ success: true });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('backup');
      expect(syncFn).toBeDefined();

      const onProgress = jest.fn();
      await syncFn('test-user', onProgress);

      expect((window as any).api.databaseBackup.backup).toHaveBeenCalled();
      expect(onProgress).toHaveBeenCalledWith(0, 'backing up');
      expect(onProgress).toHaveBeenCalledWith(100);
    });

    it('should handle cancelled backup dialog gracefully (no error)', async () => {
      (window as any).api.databaseBackup.backup.mockResolvedValue({ cancelled: true });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('backup');
      const onProgress = jest.fn();

      // Should not throw
      await expect(syncFn('test-user', onProgress)).resolves.toBe('cancelled');

      // Should NOT call onProgress(100) since it was cancelled
      expect(onProgress).toHaveBeenCalledWith(0, 'backing up');
      expect(onProgress).not.toHaveBeenCalledWith(100);
    });

    it('should register and execute restore sync function', async () => {
      (window as any).api.databaseBackup.restore.mockResolvedValue({ success: true });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('restore');
      expect(syncFn).toBeDefined();

      const onProgress = jest.fn();
      await syncFn('test-user', onProgress);

      expect((window as any).api.databaseBackup.restore).toHaveBeenCalled();
      expect(onProgress).toHaveBeenCalledWith(0, 'restoring');
      expect(onProgress).toHaveBeenCalledWith(100);
    });

    it('should handle cancelled restore dialog gracefully (no error)', async () => {
      (window as any).api.databaseBackup.restore.mockResolvedValue({ cancelled: true });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('restore');
      const onProgress = jest.fn();

      await expect(syncFn('test-user', onProgress)).resolves.toBe('cancelled');
      expect(onProgress).not.toHaveBeenCalledWith(100);
    });

    it('should register and execute ccpa-export sync function', async () => {
      (window as any).api.privacy.exportData.mockResolvedValue({ success: true });
      (window as any).api.privacy.onExportProgress.mockReturnValue(jest.fn()); // cleanup fn

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('ccpa-export');
      expect(syncFn).toBeDefined();

      const onProgress = jest.fn();
      await syncFn('test-user', onProgress);

      expect((window as any).api.privacy.exportData).toHaveBeenCalledWith('test-user');
      expect(onProgress).toHaveBeenCalledWith(0, 'exporting');
      expect(onProgress).toHaveBeenCalledWith(100);
    });

    it('should handle cancelled CCPA export gracefully', async () => {
      (window as any).api.privacy.exportData.mockResolvedValue({
        success: false,
        error: 'Export cancelled by user',
      });
      (window as any).api.privacy.onExportProgress.mockReturnValue(jest.fn());

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('ccpa-export');
      const onProgress = jest.fn();

      // Should not throw for user cancellation
      await expect(syncFn('test-user', onProgress)).resolves.toBe('cancelled');
    });

    it('should throw on CCPA export failure', async () => {
      (window as any).api.privacy.exportData.mockResolvedValue({
        success: false,
        error: 'Disk full',
      });
      (window as any).api.privacy.onExportProgress.mockReturnValue(jest.fn());

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('ccpa-export');
      await expect(syncFn('test-user', jest.fn())).rejects.toThrow('Disk full');
    });
  });

  describe('contacts forceReimport option (TASK-2150)', () => {
    beforeEach(() => {
      (window as any).api.contacts.syncExternal = jest.fn().mockResolvedValue({ success: true });
      (window as any).api.contacts.syncOutlookContacts = jest.fn().mockResolvedValue({ success: true, count: 5 });
      (window as any).api.contacts.forceReimport = jest.fn().mockResolvedValue({ success: true });
      (window as any).api.preferences.get = jest.fn().mockResolvedValue({ success: true, preferences: {} });

      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);
    });

    it('should call forceReimport before normal sync when option is set', async () => {
      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      await syncFn('test-user', jest.fn(), { forceReimport: true });

      // forceReimport should be called first
      expect((window as any).api.contacts.forceReimport).toHaveBeenCalledWith('test-user');
      // Then normal sync should proceed
      expect((window as any).api.contacts.syncExternal).toHaveBeenCalledWith('test-user');
    });

    it('should NOT call forceReimport when option is not set', async () => {
      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      await syncFn('test-user', jest.fn());

      expect((window as any).api.contacts.forceReimport).not.toHaveBeenCalled();
      expect((window as any).api.contacts.syncExternal).toHaveBeenCalled();
    });

    it('should throw when forceReimport fails', async () => {
      (window as any).api.contacts.forceReimport.mockResolvedValue({
        success: false,
        error: 'Wipe failed',
      });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
      await expect(syncFn('test-user', jest.fn(), { forceReimport: true }))
        .rejects.toThrow('Wipe failed');
    });
  });

  describe('messages forceReimport option (TASK-2150)', () => {
    beforeEach(() => {
      (window as any).api.messages.importMacOSMessages = jest.fn().mockResolvedValue({
        success: true,
        messagesImported: 100,
      });
      (window as any).api.messages.onImportProgress = jest.fn().mockReturnValue(jest.fn());
      (window as any).api.preferences.get = jest.fn().mockResolvedValue({
        success: true,
        preferences: { messages: { source: 'macos-native' } },
      });

      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);
    });

    it('should pass forceReimport to importMacOSMessages when option is set', async () => {
      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('messages');
      await syncFn('test-user', jest.fn(), { forceReimport: true });

      expect((window as any).api.messages.importMacOSMessages)
        .toHaveBeenCalledWith('test-user', true);
    });

    it('should pass undefined forceReimport when option is not set', async () => {
      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('messages');
      await syncFn('test-user', jest.fn());

      expect((window as any).api.messages.importMacOSMessages)
        .toHaveBeenCalledWith('test-user', undefined);
    });
  });

  describe('BACKLOG-1467: skip macOS messages for android-companion', () => {
    beforeEach(() => {
      (window as any).api.messages.importMacOSMessages = jest.fn().mockResolvedValue({
        success: true,
        messagesImported: 100,
      });
      (window as any).api.messages.onImportProgress = jest.fn().mockReturnValue(jest.fn());

      const platformMock = require('../../utils/platform');
      platformMock.isMacOS.mockReturnValue(true);
    });

    it('should skip macOS messages import when import source is android-companion', async () => {
      (window as any).api.preferences.get = jest.fn().mockResolvedValue({
        success: true,
        preferences: { messages: { source: 'android-companion' } },
      });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('messages');
      const onProgress = jest.fn();
      await syncFn('test-user', onProgress);

      // Should NOT have called importMacOSMessages
      expect((window as any).api.messages.importMacOSMessages).not.toHaveBeenCalled();
      // Should have set progress to 100 (skipped cleanly)
      expect(onProgress).toHaveBeenCalledWith(100);
    });

    it('should skip macOS messages import when import source is iphone-sync', async () => {
      (window as any).api.preferences.get = jest.fn().mockResolvedValue({
        success: true,
        preferences: { messages: { source: 'iphone-sync' } },
      });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('messages');
      const onProgress = jest.fn();
      await syncFn('test-user', onProgress);

      // Should NOT have called importMacOSMessages
      expect((window as any).api.messages.importMacOSMessages).not.toHaveBeenCalled();
      // Should have set progress to 100 (skipped cleanly)
      expect(onProgress).toHaveBeenCalledWith(100);
    });

    it('should proceed with macOS messages import when import source is macos-native', async () => {
      (window as any).api.preferences.get = jest.fn().mockResolvedValue({
        success: true,
        preferences: { messages: { source: 'macos-native' } },
      });

      syncOrchestrator.initializeSyncFunctions();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncFn = (syncOrchestrator as any).syncFunctions.get('messages');
      await syncFn('test-user', jest.fn());

      // Should have called importMacOSMessages
      expect((window as any).api.messages.importMacOSMessages).toHaveBeenCalled();
    });
  });
});
