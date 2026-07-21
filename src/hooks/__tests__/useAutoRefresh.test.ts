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

  const defaultOptions = {
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
});
