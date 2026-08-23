/**
 * Unit tests for useAutoRefresh hook
 *
 * TASK-1003: Tests auto-refresh functionality including:
 * - Platform-specific sync behavior
 * - Delay before auto-trigger
 * - Progress state management
 *
 * TASK-1783: Updated to mock SyncOrchestrator instead of SyncQueueService
 */

import React from "react";
import { renderHook, act } from "@testing-library/react";
import { useAutoRefresh, resetAutoRefreshTrigger } from "../useAutoRefresh";
import { setMessagesImportTriggered, resetMessagesImportTrigger } from "../../utils/syncFlags";

// Mock the platform context
jest.mock("../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

// Mock the orchestrator state
const mockOrchestratorState = {
  isRunning: false,
  queue: [] as Array<{ type: string; status: string; progress: number; error?: string }>,
  currentSync: null,
  overallProgress: 0,
  pendingRequest: null,
};

const mockRequestSync = jest.fn().mockReturnValue({ started: true, needsConfirmation: false });
const mockForceSync = jest.fn();
const mockAcceptPending = jest.fn();
const mockRejectPending = jest.fn();
const mockCancel = jest.fn();

// Mock useSyncOrchestrator hook
jest.mock("../useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({
    state: mockOrchestratorState,
    isRunning: mockOrchestratorState.isRunning,
    queue: mockOrchestratorState.queue,
    currentSync: mockOrchestratorState.currentSync,
    overallProgress: mockOrchestratorState.overallProgress,
    pendingRequest: mockOrchestratorState.pendingRequest,
    requestSync: mockRequestSync,
    forceSync: mockForceSync,
    acceptPending: mockAcceptPending,
    rejectPending: mockRejectPending,
    cancel: mockCancel,
  })),
}));

// Import the mock after mocking
import { usePlatform } from "../../contexts/PlatformContext";
import { useSyncOrchestrator } from "../useSyncOrchestrator";

describe("useAutoRefresh", () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  const mockPreferencesGet = jest.fn();
  const mockNotificationSend = jest.fn();
  // BACKLOG-2127: live connection check used by runAutoRefresh.
  const mockCheckAllConnections = jest.fn();

  // Annotated with the hook's real options type so `userId: null` (the logout
  // rerender below) is allowed instead of being widened away to `string`.
  const defaultOptions: Parameters<typeof useAutoRefresh>[0] = {
    userId: "test-user-123",
    hasEmailConnected: true,
    isDatabaseInitialized: true,
    hasPermissions: true,
    isOnDashboard: true,
    isOnboarding: false,
  };

  beforeEach(() => {
    jest.useFakeTimers();

    // Reset module-level state between tests
    resetAutoRefreshTrigger();
    resetMessagesImportTrigger();

    // Reset orchestrator mock state
    mockOrchestratorState.isRunning = false;
    mockOrchestratorState.queue = [];
    mockOrchestratorState.currentSync = null;
    mockOrchestratorState.overallProgress = 0;
    mockOrchestratorState.pendingRequest = null;

    // Reset mocks
    mockRequestSync.mockClear().mockReturnValue({ started: true, needsConfirmation: false });
    mockForceSync.mockClear();
    mockAcceptPending.mockClear();
    mockRejectPending.mockClear();
    mockCancel.mockClear();

    mockPreferencesGet.mockReset().mockResolvedValue({ success: true, preferences: { sync: { autoSyncOnLogin: true } } });
    mockNotificationSend.mockReset().mockResolvedValue(undefined);

    // Setup console spies
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();

    // Reset platform mock to macOS
    (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

    // Update useSyncOrchestrator mock to return fresh state
    (useSyncOrchestrator as jest.Mock).mockReturnValue({
      state: mockOrchestratorState,
      isRunning: mockOrchestratorState.isRunning,
      queue: mockOrchestratorState.queue,
      currentSync: mockOrchestratorState.currentSync,
      overallProgress: mockOrchestratorState.overallProgress,
      pendingRequest: mockOrchestratorState.pendingRequest,
      requestSync: mockRequestSync,
      forceSync: mockForceSync,
      acceptPending: mockAcceptPending,
      rejectPending: mockRejectPending,
      cancel: mockCancel,
    });

    // Setup window.api mock
    // BACKLOG-2127: runAutoRefresh now does a LIVE checkAllConnections before
    // enqueuing 'emails'. Default: both providers connected (so 'emails' is
    // enqueued exactly when the pre-fix snapshot would have — most existing
    // assertions are preserved). Individual tests override this mock.
    mockCheckAllConnections
      .mockReset()
      .mockResolvedValue({
        success: true,
        google: { connected: true, error: null },
        microsoft: { connected: true, error: null },
      });
    (window as any).api = {
      preferences: {
        get: mockPreferencesGet,
      },
      notification: {
        send: mockNotificationSend,
      },
      system: {
        checkAllConnections: mockCheckAllConnections,
      },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.clearAllMocks();
  });

  describe("initialization", () => {
    it("should start with default sync status", () => {
      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      expect(result.current.syncStatus.emails.isSyncing).toBe(false);
      expect(result.current.syncStatus.messages.isSyncing).toBe(false);
      expect(result.current.syncStatus.contacts.isSyncing).toBe(false);
      expect(result.current.isAnySyncing).toBe(false);
      expect(result.current.currentSyncMessage).toBeNull();
    });

    it("should provide triggerRefresh function", () => {
      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      expect(typeof result.current.triggerRefresh).toBe("function");
    });
  });

  describe("auto-trigger behavior", () => {
    it("should trigger orchestrator sync after delay when on dashboard", async () => {
      renderHook(() => useAutoRefresh(defaultOptions));

      // Preferences need to load first
      await act(async () => {
        await Promise.resolve();
      });

      // Advance timer to trigger auto-refresh (1.5 seconds)
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // Should have called requestSync with contacts and messages (macOS)
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("should include emails in sync when hasAIAddon is true", async () => {
      renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          hasAIAddon: true,
        })
      );

      // Preferences need to load first
      await act(async () => {
        await Promise.resolve();
      });

      // Advance timer to trigger auto-refresh
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // Should include emails since hasAIAddon is true
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("should NOT trigger refresh when not on dashboard", async () => {
      renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          isOnDashboard: false,
        })
      );

      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("should NOT trigger refresh during onboarding", async () => {
      renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          isOnboarding: true,
        })
      );

      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("should NOT trigger refresh when database not initialized", async () => {
      renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          isDatabaseInitialized: false,
        })
      );

      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("should NOT trigger refresh when userId is null", async () => {
      renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          userId: null,
        })
      );

      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("should NOT trigger refresh when autoSyncOnLogin is disabled", async () => {
      mockPreferencesGet.mockResolvedValue({
        success: true,
        preferences: { sync: { autoSyncOnLogin: false } },
      });

      renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("should only trigger once per dashboard entry", async () => {
      renderHook(() => useAutoRefresh(defaultOptions));

      // Step 1: Let preference loading complete
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Step 2: Advance timer to trigger auto-refresh
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // First trigger should have happened
      expect(mockRequestSync).toHaveBeenCalledTimes(1);

      // Step 3: Advance more time - should not trigger again
      await act(async () => {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("platform-specific sync behavior", () => {
    it("should include contacts and messages on macOS with permissions", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await result.current.triggerRefresh();
      });

      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("should sync only Outlook contacts on non-macOS platforms with email connected", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await result.current.triggerRefresh();
      });

      // TASK-1953: Outlook contacts sync via Graph API on all platforms when email connected
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );
    });

    it("should sync only contacts on non-macOS when NO email provider is connected (live check)", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });
      // BACKLOG-2127: emails are gated on the LIVE connection check, not the
      // snapshot. Both providers NOT_CONNECTED → emails legitimately skipped.
      mockCheckAllConnections.mockResolvedValue({
        success: true,
        google: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
        microsoft: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
      });

      const { result } = renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          hasEmailConnected: false,
        })
      );

      await act(async () => {
        await result.current.triggerRefresh();
      });

      // TASK-2092: Contacts always syncs — orchestrator handles source-specific guards
      expect(mockRequestSync).toHaveBeenCalledWith(["contacts"], expect.any(String));
    });

    it("should sync only Outlook contacts without macOS permissions", async () => {
      const { result } = renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          hasPermissions: false,
        })
      );

      await act(async () => {
        await result.current.triggerRefresh();
      });

      // TASK-1953: Outlook contacts still sync without macOS permissions (uses Graph API)
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );
    });

    it("should include contacts and emails on non-macOS with AI addon", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      const { result } = renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          hasAIAddon: true,
        })
      );

      await act(async () => {
        await result.current.triggerRefresh();
      });

      // TASK-1953: contacts (Outlook) + emails (AI addon)
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );
    });
  });

  describe("BACKLOG-1842: resume sync after the FDA-grant relaunch", () => {
    // After the user grants Full Disk Access, PermissionsStep relaunches the app
    // (it no longer syncs itself). The fresh process starts with FDA granted, so
    // PermissionsStep is skipped and the app lands on the dashboard. This hook is
    // the resume seam: it AUTOMATICALLY runs the interrupted sync — including
    // macOS messages — with no manual action. Module-level flags are fresh
    // because the relaunch is a real process restart.
    it("automatically syncs contacts, emails, AND messages on dashboard entry when FDA is granted", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          hasPermissions: true,
          isOnDashboard: true,
          isOnboarding: false,
        })
      );

      // Let preference loading settle, then advance past the auto-refresh delay.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      // The interrupted messages sync now completes cleanly in the fresh process.
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });
  });

  describe("BACKLOG-1467: skip macOS messages for Android users", () => {
    it("should NOT include messages when import source is android-companion on macOS", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      // Return android-companion as import source
      mockPreferencesGet.mockResolvedValue({
        success: true,
        preferences: {
          sync: { autoSyncOnLogin: true },
          messages: { source: 'android-companion' },
        },
      });

      renderHook(() => useAutoRefresh(defaultOptions));

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Trigger auto-refresh after delay
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // Should have contacts + emails but NOT messages
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );
    });

    it("should NOT include messages when import source is iphone-sync on macOS", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      // Return iphone-sync as import source
      mockPreferencesGet.mockResolvedValue({
        success: true,
        preferences: {
          sync: { autoSyncOnLogin: true },
          messages: { source: 'iphone-sync' },
        },
      });

      renderHook(() => useAutoRefresh(defaultOptions));

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Trigger auto-refresh after delay
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // Should have contacts + emails but NOT messages
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );
    });

    it("should include messages when import source is macos-native on macOS", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      // Return macos-native (default) as import source
      mockPreferencesGet.mockResolvedValue({
        success: true,
        preferences: {
          sync: { autoSyncOnLogin: true },
          messages: { source: 'macos-native' },
        },
      });

      renderHook(() => useAutoRefresh(defaultOptions));

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Trigger auto-refresh after delay
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // Should include messages for macos-native
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("should skip messages via triggerRefresh when import source is android-companion", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      mockPreferencesGet.mockResolvedValue({
        success: true,
        preferences: {
          sync: { autoSyncOnLogin: true },
          messages: { source: 'android-companion' },
        },
      });

      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      mockRequestSync.mockClear();

      // Manual trigger should also respect import source
      await act(async () => {
        await result.current.triggerRefresh();
      });

      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );
    });
  });

  describe("sync status from orchestrator queue", () => {
    it("should reflect running status from orchestrator queue", async () => {
      // Update mock to return running state
      mockOrchestratorState.isRunning = true;
      mockOrchestratorState.queue = [
        { type: 'contacts', status: 'complete', progress: 100 },
        { type: 'messages', status: 'running', progress: 45 },
      ];

      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: true,
        queue: mockOrchestratorState.queue,
        currentSync: 'messages',
        overallProgress: 72,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      expect(result.current.isAnySyncing).toBe(true);
      expect(result.current.syncStatus.contacts.isSyncing).toBe(false); // complete
      expect(result.current.syncStatus.contacts.progress).toBe(100);
      expect(result.current.syncStatus.messages.isSyncing).toBe(true); // running
      expect(result.current.syncStatus.messages.progress).toBe(45);
    });

    it("should reflect error status from orchestrator queue", async () => {
      mockOrchestratorState.queue = [
        { type: 'contacts', status: 'error', progress: 0, error: 'Permission denied' },
      ];

      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: false,
        queue: mockOrchestratorState.queue,
        currentSync: null,
        overallProgress: 0,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      expect(result.current.syncStatus.contacts.error).toBe('Permission denied');
      expect(result.current.syncStatus.contacts.isSyncing).toBe(false);
    });

    it("should return default status for types not in queue", async () => {
      mockOrchestratorState.queue = [
        { type: 'messages', status: 'running', progress: 50 },
      ];

      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: true,
        queue: mockOrchestratorState.queue,
        currentSync: 'messages',
        overallProgress: 50,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      // Emails not in queue - should have default values
      expect(result.current.syncStatus.emails.isSyncing).toBe(false);
      expect(result.current.syncStatus.emails.progress).toBeNull();
      expect(result.current.syncStatus.emails.error).toBeNull();
    });
  });

  describe("OS notification", () => {
    it("should send notification when sync completes", async () => {
      // Start with syncing
      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: true,
        queue: [{ type: 'messages', status: 'running', progress: 50 }],
        currentSync: 'messages',
        overallProgress: 50,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      const { rerender } = renderHook(() => useAutoRefresh(defaultOptions));

      // Now sync completes
      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: false,
        queue: [{ type: 'messages', status: 'complete', progress: 100 }],
        currentSync: null,
        overallProgress: 100,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      rerender();

      expect(mockNotificationSend).toHaveBeenCalledWith(
        "Sync Complete",
        "Keepr is ready to use. Your data has been synchronized."
      );
    });

    // BACKLOG-2748: the import became cancellable, and a cancelled run leaves
    // its queue item at status 'complete' — so it walks past the "not if they
    // were removed (cancel)" guard, which was written for the EXTERNAL kind of
    // cancel that empties the queue. The test above ("should send notification
    // when sync completes") is the CONTROL for these two: identical transition,
    // no `cancelled` flag, notification expected.
    it("should NOT send a 'Sync Complete' notification when the user cancelled the run", async () => {
      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: true,
        queue: [{ type: 'messages', status: 'running', progress: 50 }],
        currentSync: 'messages',
        overallProgress: 50,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      const { rerender } = renderHook(() => useAutoRefresh(defaultOptions));

      // The exact queue item a cancelled import produces: complete, with the
      // partial count and the cancel discriminator.
      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: false,
        queue: [{ type: 'messages', status: 'complete', progress: 100, importedCount: 12431, cancelled: true }],
        currentSync: null,
        overallProgress: 100,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      rerender();

      // An OS notification outlives the window it came from — it sits in
      // Notification Center telling the user his data synchronized.
      expect(mockNotificationSend).not.toHaveBeenCalled();
    });

    it("should STILL send 'Sync Failed' when a cancelled run also had an error", async () => {
      // A cancel may silence a success notice; it must never silence a failure
      // one. Same rule as SyncStatusIndicator's completion card.
      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: true,
        queue: [
          { type: 'emails', status: 'running', progress: 50 },
          { type: 'messages', status: 'running', progress: 50 },
        ],
        currentSync: 'messages',
        overallProgress: 50,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      const { rerender } = renderHook(() => useAutoRefresh(defaultOptions));

      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: false,
        queue: [
          { type: 'emails', status: 'error', progress: 40, error: 'Outlook connection expired' },
          { type: 'messages', status: 'complete', progress: 100, importedCount: 12431, cancelled: true },
        ],
        currentSync: null,
        overallProgress: 100,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      rerender();

      expect(mockNotificationSend).toHaveBeenCalledWith(
        "Sync Failed",
        "One or more sync operations failed. Open Keepr for details."
      );
    });

    it("should NOT send notification when sync starts", async () => {
      // Start with not syncing
      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: false,
        queue: [],
        currentSync: null,
        overallProgress: 0,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      const { rerender } = renderHook(() => useAutoRefresh(defaultOptions));

      // Now sync starts
      (useSyncOrchestrator as jest.Mock).mockReturnValue({
        state: mockOrchestratorState,
        isRunning: true,
        queue: [{ type: 'messages', status: 'running', progress: 0 }],
        currentSync: 'messages',
        overallProgress: 0,
        pendingRequest: null,
        requestSync: mockRequestSync,
        forceSync: mockForceSync,
        acceptPending: mockAcceptPending,
        rejectPending: mockRejectPending,
        cancel: mockCancel,
      });

      rerender();

      expect(mockNotificationSend).not.toHaveBeenCalled();
    });
  });

  describe("onboarding import skip", () => {
    beforeEach(() => {
      resetMessagesImportTrigger();
    });

    it("should allow manual sync even when onboarding import flag is set", async () => {
      // Mark onboarding import complete
      setMessagesImportTriggered();

      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await result.current.triggerRefresh();
      });

      // Manual triggerRefresh should bypass the import flag
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("should allow sync when import flag not set", async () => {
      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await result.current.triggerRefresh();
      });

      expect(mockRequestSync).toHaveBeenCalled();
    });
  });

  describe("manual triggerRefresh", () => {
    it("should work without waiting for auto-trigger delay", async () => {
      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await result.current.triggerRefresh();
      });

      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("should do nothing when userId is null", async () => {
      const { result } = renderHook(() =>
        useAutoRefresh({
          ...defaultOptions,
          userId: null,
        })
      );

      await act(async () => {
        await result.current.triggerRefresh();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });
  });

  describe("preference loading", () => {
    it("should wait for preferences before triggering", async () => {
      let resolvePrefs: (value: any) => void;
      mockPreferencesGet.mockReturnValue(
        new Promise((resolve) => {
          resolvePrefs = resolve;
        })
      );

      renderHook(() => useAutoRefresh(defaultOptions));

      // Advance timer before prefs load
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3000);
      });

      // Should not have triggered yet
      expect(mockRequestSync).not.toHaveBeenCalled();

      // Now resolve preferences
      await act(async () => {
        resolvePrefs!({ success: true, preferences: { sync: { autoSyncOnLogin: true } } });
        await Promise.resolve();
      });

      // Now advance timer to trigger auto-refresh
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1500);
      });

      expect(mockRequestSync).toHaveBeenCalled();
    });

    it("should default to enabled when preference not set", async () => {
      mockPreferencesGet.mockResolvedValue({ success: true, preferences: {} });

      renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalled();
    });

    it("should default to enabled on preference load error", async () => {
      mockPreferencesGet.mockRejectedValue(new Error("Failed to load"));

      renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalled();
    });
  });

  describe("BACKLOG-1367: permission race condition", () => {
    it("should re-trigger sync with messages when hasPermissions flips from false to true on macOS", async () => {
      // Scenario: Onboarding completes with FDA already granted, but the async
      // permission check hasn't resolved yet. hasPermissions starts as false.
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      const { rerender } = renderHook(
        (props) => useAutoRefresh(props),
        { initialProps: { ...defaultOptions, hasPermissions: false } }
      );

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Auto-refresh fires after 1.5s delay with hasPermissions=false
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // First trigger: contacts + emails (no messages because hasPermissions=false)
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );

      mockRequestSync.mockClear();

      // Now hasPermissions resolves to true
      rerender({ ...defaultOptions, hasPermissions: true });

      // The effect should re-fire and schedule another sync
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // Second trigger: should now include messages
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("should NOT re-trigger when hasPermissions was already true on first sync", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      renderHook(() => useAutoRefresh(defaultOptions));

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Auto-refresh fires with hasPermissions=true
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );

      mockRequestSync.mockClear();

      // Further effect re-fires should be blocked
      await act(async () => {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("should not be affected by permission race on non-macOS", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      const { rerender } = renderHook(
        (props) => useAutoRefresh(props),
        { initialProps: { ...defaultOptions, hasPermissions: false } }
      );

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // Should trigger with contacts + emails (non-macOS never has messages)
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );

      mockRequestSync.mockClear();

      // hasPermissions flips to true — should NOT re-trigger on non-macOS
      rerender({ ...defaultOptions, hasPermissions: true });

      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });
  });

  describe("email precache re-fire on login", () => {
    it("enqueues emails from the LIVE check even when hasEmailConnected snapshot is false (macOS)", async () => {
      // BACKLOG-2127 core fix: the dead-token user has hasEmailConnected=false
      // at load. Previously that silently dropped 'emails' → green "0 new".
      // Now runAutoRefresh does a LIVE checkAllConnections; a broken-token
      // provider still enqueues 'emails' (which then errors → reconnect prompt).
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      mockCheckAllConnections.mockResolvedValue({
        success: true,
        google: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
        microsoft: {
          connected: false,
          error: { type: "TOKEN_REFRESH_FAILED", userMessage: "expired" },
        },
      });

      renderHook(
        (props) => useAutoRefresh(props),
        { initialProps: { ...defaultOptions, hasEmailConnected: false } }
      );

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Auto-refresh fires after 1.5s delay with hasEmailConnected=false
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      // Emails IS enqueued despite the false snapshot — the broken token is
      // surfaced, not silently dropped.
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("should NOT re-trigger when hasEmailConnected was already true on first sync", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      renderHook(() => useAutoRefresh(defaultOptions));

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Auto-refresh fires with hasEmailConnected=true
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );

      mockRequestSync.mockClear();

      // Further effect re-fires should be blocked
      await act(async () => {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("enqueues emails from the LIVE check on non-macOS even when snapshot is false", async () => {
      // BACKLOG-2127: same as above on non-macOS (no messages). A connected
      // provider reported by the live check enqueues 'emails' regardless of the
      // stale hasEmailConnected snapshot.
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });
      mockCheckAllConnections.mockResolvedValue({
        success: true,
        google: { connected: true, error: null },
        microsoft: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
      });

      renderHook(
        (props) => useAutoRefresh(props),
        { initialProps: { ...defaultOptions, hasEmailConnected: false } }
      );

      // Let preferences load
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails'],
        'test-user-123'
      );
    });
  });

  // ===========================================================================
  // BACKLOG-2127: live connection check drives email enqueue; async cleanup
  // must suppress a late requestSync; StrictMode must not double-fire.
  // ===========================================================================
  describe("BACKLOG-2127: live connection check + async safety", () => {
    it("does NOT enqueue emails when the live check reports both providers NOT_CONNECTED", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      mockCheckAllConnections.mockResolvedValue({
        success: true,
        google: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
        microsoft: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
      });

      renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      // contacts + messages, but NOT emails (both providers truly disconnected).
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'messages'],
        'test-user-123'
      );
    });

    it("enqueues emails when the live check reports a broken token (TOKEN_EXPIRED)", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      mockCheckAllConnections.mockResolvedValue({
        success: true,
        google: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
        microsoft: { connected: false, error: { type: "TOKEN_EXPIRED", userMessage: "expired" } },
      });

      const { result } = renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await Promise.resolve();
        await result.current.triggerRefresh();
      });

      expect(mockRequestSync).toHaveBeenCalledWith(
        ['contacts', 'emails', 'messages'],
        'test-user-123'
      );
    });

    it("suppresses a late requestSync when unmounted during the async connection check (abort flag)", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      // Hold the connection check open so we can unmount mid-flight.
      let resolveCheck: (v: unknown) => void = () => {};
      mockCheckAllConnections.mockReturnValue(
        new Promise((resolve) => {
          resolveCheck = resolve;
        })
      );

      const { unmount } = renderHook(() => useAutoRefresh(defaultOptions));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // Fire the delayed auto-refresh; it now awaits checkAllConnections.
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // Unmount while the check is still pending → cleanup sets aborted=true.
      unmount();

      // Now resolve the check; the aborted guard must prevent requestSync.
      await act(async () => {
        resolveCheck({
          success: true,
          google: { connected: true, error: null },
          microsoft: { connected: true, error: null },
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("fires the auto-refresh exactly once under React.StrictMode (value-comparison guard)", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      renderHook(() => useAutoRefresh(defaultOptions), {
        wrapper: ({ children }) =>
          React.createElement(React.StrictMode, null, children),
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      // StrictMode double-invokes effects; the module-level value-comparison
      // guard must still yield a single sync request (and a single live check).
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockCheckAllConnections).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanup", () => {
    it("should cancel pending timeout on unmount", async () => {
      const { unmount } = renderHook(() => useAutoRefresh(defaultOptions));

      // Load prefs
      await act(async () => {
        await Promise.resolve();
      });

      // Unmount before timeout fires
      unmount();

      // Advance timer
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });

      // Should not have triggered
      expect(mockRequestSync).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // BACKLOG-2314: the dashboard auto-sync must fire ONCE per app session, not on
  // every return to the dashboard. The once-per-session latch is decoupled from
  // the hasEmailConnected snapshot (its coupling caused the loop); a per-user
  // in-memory cooldown guards the case where the latch never sets (macOS FDA
  // permissions never resolve).
  // ===========================================================================
  describe("BACKLOG-2314: fire once, not on every dashboard return", () => {
    it("does NOT re-sync when returning to the dashboard (latch, permissions resolved)", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      const { rerender } = renderHook(
        (props) => useAutoRefresh(props),
        { initialProps: { ...defaultOptions, isOnDashboard: true } }
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      mockRequestSync.mockClear();

      // Leave the dashboard, then return — the effect re-runs but the latch blocks it.
      rerender({ ...defaultOptions, isOnDashboard: false });
      rerender({ ...defaultOptions, isOnDashboard: true });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("does NOT loop on dashboard return when macOS permissions never resolve (cooldown guard)", async () => {
      // Regression: pre-fix the latch never set while hasPermissions stayed false,
      // so every dashboard remount re-synced. The per-user cooldown now blocks the
      // return re-sync even though the latch is not set.
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      const { rerender } = renderHook(
        (props) => useAutoRefresh(props),
        { initialProps: { ...defaultOptions, isOnDashboard: true, hasPermissions: false } }
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      // First attempt fires (contacts + emails; no messages because perms unresolved).
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(['contacts', 'emails'], 'test-user-123');
      mockRequestSync.mockClear();

      // Return to the dashboard with permissions STILL unresolved — cooldown blocks it.
      rerender({ ...defaultOptions, isOnDashboard: false, hasPermissions: false });
      rerender({ ...defaultOptions, isOnDashboard: true, hasPermissions: false });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("re-syncs for a genuinely new login (latch + cooldown reset on userId change)", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      const { rerender } = renderHook(
        (props) => useAutoRefresh(props),
        { initialProps: { ...defaultOptions } }
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      mockRequestSync.mockClear();

      // A different user logs in — the latch and cooldown reset so they sync too.
      rerender({ ...defaultOptions, userId: "different-user-456" });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        expect.arrayContaining(['contacts']),
        'different-user-456'
      );
    });
  });

  // ===========================================================================
  // BACKLOG-2420: a SECOND concurrent hook instance must not re-arm the
  // once-per-session guards.
  //
  // useAppStateMachine is a plain hook, not a context, and Contacts.tsx (also
  // Transactions.tsx / TransactionList.tsx / AuditTransactionModal.tsx) calls it
  // just to read isDatabaseInitialized — which instantiates a whole SECOND
  // useAutoRefresh. Pre-fix, that instance's mount effect unconditionally set
  // hasTriggeredAutoRefresh = false and deleted the per-user cooldown, wiping the
  // BACKLOG-2314 guards the App-level instance had already set. Its own
  // auto-trigger effect then passed both gates and fired a full 14.6s sync
  // (address books re-parsed, ~1,124 rows re-upserted, opportunistic linking
  // re-run) EVERY time the user opened Clients & Contacts.
  //
  // The guard is now a value comparison on userId rather than a didMount side
  // effect — the same StrictMode didMount-guard antipattern this hook was already
  // bitten by (see BACKLOG-2127 StrictMode test above).
  // ===========================================================================
  describe("BACKLOG-2420: duplicate hook instance must not re-arm the session guards", () => {
    /** Mount the App-level instance and let it fire + latch once. */
    const mountAppInstanceAndLatch = async () => {
      const app = renderHook(() => useAutoRefresh(defaultOptions));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });
      return app;
    };

    it("does NOT re-sync when a second instance (Contacts screen) mounts, unmounts and remounts", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      // The App-level instance does the one legitimate startup sync.
      const app = await mountAppInstanceAndLatch();
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      mockRequestSync.mockClear();

      // --- Open Clients & Contacts (second concurrent useAutoRefresh) ---------
      let contacts = renderHook(() => useAutoRefresh(defaultOptions));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });
      const firesOnFirstOpen = mockRequestSync.mock.calls.length;
      mockRequestSync.mockClear();

      // --- Leave the screen, then open it again ------------------------------
      contacts.unmount();
      contacts = renderHook(() => useAutoRefresh(defaultOptions));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });
      const firesOnSecondOpen = mockRequestSync.mock.calls.length;

      // Pre-fix this reproduced { firesOnFirstOpen: 1, firesOnSecondOpen: 1 }:
      // the duplicate mount wiped the latch AND the cooldown each time.
      expect({ firesOnFirstOpen, firesOnSecondOpen }).toEqual({
        firesOnFirstOpen: 0,
        firesOnSecondOpen: 0,
      });

      contacts.unmount();
      app.unmount();
    });

    it("still blocks the duplicate instance when macOS permissions never resolve (cooldown must survive)", async () => {
      // Belt-and-braces: with permissions unresolved the latch never sets, so the
      // ONLY thing standing between the duplicate mount and a re-sync is the
      // per-user cooldown — which the pre-fix reset deleted.
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      const opts = { ...defaultOptions, hasPermissions: false };

      const app = renderHook(() => useAutoRefresh(opts));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      mockRequestSync.mockClear();

      const contacts = renderHook(() => useAutoRefresh(opts));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockRequestSync).not.toHaveBeenCalled();

      contacts.unmount();
      app.unmount();
    });

    it("still syncs after logout and re-login as the SAME user", async () => {
      // The guard clears on a falsy userId, so a real logout -> re-login is a
      // genuine new session and must sync — it must not be mistaken for a
      // duplicate mount just because the user id happens to match.
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      const { rerender } = renderHook((props) => useAutoRefresh(props), {
        initialProps: { ...defaultOptions },
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      mockRequestSync.mockClear();

      // Logout.
      rerender({ ...defaultOptions, userId: null });
      await act(async () => {
        await Promise.resolve();
      });

      // Same user logs back in.
      rerender({ ...defaultOptions, userId: defaultOptions.userId });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      expect(mockRequestSync).toHaveBeenCalledWith(
        expect.arrayContaining(['contacts']),
        'test-user-123'
      );
    });

    it("resetAutoRefreshTrigger() fully re-arms, including the duplicate-mount guard", async () => {
      // If resetAutoRefreshTrigger() did not clear lastResetUserId, a deliberate
      // reset would silently stop working for the same user.
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      const first = await mountAppInstanceAndLatch();
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      mockRequestSync.mockClear();
      first.unmount();

      resetAutoRefreshTrigger();

      const second = await mountAppInstanceAndLatch();
      expect(mockRequestSync).toHaveBeenCalledTimes(1);
      second.unmount();
    });
  });
});
