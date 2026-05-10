/**
 * Unit tests for useIPhoneSync hook
 * Tests iPhone device detection, sync functionality, and error handling
 */

import { renderHook, act } from "@testing-library/react";
import { useIPhoneSync, syncStateRef } from "../useIPhoneSync";

describe("useIPhoneSync", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  // Store callbacks for triggering events in tests
  let deviceConnectedCallback: ((device: unknown) => void) | null = null;
  let deviceDisconnectedCallback: (() => void) | null = null;
  let syncProgressCallback: ((progress: unknown) => void) | null = null;
  let passwordRequiredCallback: (() => void) | null = null;
  let syncErrorCallback: ((err: { message: string }) => void) | null = null;
  let syncCompleteCallback: ((data: unknown) => void) | null = null;
  let waitingForPasscodeCallback: (() => void) | null = null;
  let passcodeEnteredCallback: (() => void) | null = null;
  let storageCompleteCallback: ((result: unknown) => void) | null = null;
  let storageErrorCallback: ((err: { error: string }) => void) | null = null;

  const mockDevice = {
    udid: "test-udid-123",
    name: "Test iPhone",
    productType: "iPhone14,2",
    productVersion: "17.0",
    serialNumber: "ABC123",
    isConnected: true,
  };

  const setupSyncApiMock = () => {
    return {
      startDetection: jest.fn(),
      stopDetection: jest.fn(),
      start: jest.fn().mockResolvedValue({ success: true }),
      cancel: jest.fn().mockResolvedValue(undefined),
      getUnifiedStatus: jest.fn().mockResolvedValue({
        isAnyOperationRunning: false,
        currentOperation: null,
      }),
      onDeviceConnected: jest.fn((cb) => {
        deviceConnectedCallback = cb;
        return jest.fn();
      }),
      onDeviceDisconnected: jest.fn((cb) => {
        deviceDisconnectedCallback = cb;
        return jest.fn();
      }),
      onProgress: jest.fn((cb) => {
        syncProgressCallback = cb;
        return jest.fn();
      }),
      onPasswordRequired: jest.fn((cb) => {
        passwordRequiredCallback = cb;
        return jest.fn();
      }),
      onError: jest.fn((cb) => {
        syncErrorCallback = cb;
        return jest.fn();
      }),
      onComplete: jest.fn((cb) => {
        syncCompleteCallback = cb;
        return jest.fn();
      }),
      onWaitingForPasscode: jest.fn((cb) => {
        waitingForPasscodeCallback = cb;
        return jest.fn();
      }),
      onPasscodeEntered: jest.fn((cb) => {
        passcodeEnteredCallback = cb;
        return jest.fn();
      }),
      onStorageComplete: jest.fn((cb) => {
        storageCompleteCallback = cb;
        return jest.fn();
      }),
      onStorageError: jest.fn((cb) => {
        storageErrorCallback = cb;
        return jest.fn();
      }),
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();

    // Reset sync state ref
    syncStateRef.isActive = false;
    syncStateRef.deferredLogout = false;

    // Reset callbacks
    deviceConnectedCallback = null;
    deviceDisconnectedCallback = null;
    syncProgressCallback = null;
    passwordRequiredCallback = null;
    syncErrorCallback = null;
    syncCompleteCallback = null;
    waitingForPasscodeCallback = null;
    passcodeEnteredCallback = null;
    storageCompleteCallback = null;
    storageErrorCallback = null;

    // Setup console spies
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

    // Setup basic window.api mock with device API (fallback path)
    (window as any).api = {
      device: {
        startDetection: jest.fn(),
        stopDetection: jest.fn(),
        onConnected: jest.fn(() => jest.fn()),
        onDisconnected: jest.fn(() => jest.fn()),
      },
      backup: {
        start: jest.fn(),
        startWithPassword: jest.fn(),
        cancel: jest.fn(),
        onProgress: jest.fn(() => jest.fn()),
        onError: jest.fn(() => jest.fn()),
        checkStatus: jest.fn().mockResolvedValue({ success: true, lastSyncTime: null }),
      },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    syncStateRef.isActive = false;
  });

  describe("initialization", () => {
    it("should start with default state", () => {
      const { result } = renderHook(() => useIPhoneSync());

      expect(result.current.isConnected).toBe(false);
      expect(result.current.device).toBeNull();
      expect(result.current.syncStatus).toBe("idle");
      expect(result.current.progress).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.needsPassword).toBe(false);
    });

    it("should provide all required hook methods", () => {
      const { result } = renderHook(() => useIPhoneSync());

      expect(typeof result.current.startSync).toBe("function");
      expect(typeof result.current.submitPassword).toBe("function");
      expect(typeof result.current.cancelSync).toBe("function");
    });

    it("should start device detection on mount", () => {
      renderHook(() => useIPhoneSync());

      expect(window.api.device.startDetection as jest.Mock).toHaveBeenCalled();
    });

    it("should stop detection on unmount", () => {
      const { unmount } = renderHook(() => useIPhoneSync());

      unmount();

      expect(window.api.device.stopDetection as jest.Mock).toHaveBeenCalled();
    });
  });

  describe("API unavailable scenarios", () => {
    it("should handle missing device API gracefully", () => {
      (window as any).api = {};

      const { result } = renderHook(() => useIPhoneSync());

      expect(result.current.isConnected).toBe(false);
      expect(result.current.device).toBeNull();
    });

    it("should handle missing backup API gracefully", () => {
      (window as any).api = {
        device: {
          startDetection: jest.fn(),
          stopDetection: jest.fn(),
          onConnected: jest.fn(() => jest.fn()),
          onDisconnected: jest.fn(() => jest.fn()),
        },
      };

      const { result } = renderHook(() => useIPhoneSync());

      expect(result.current).toBeDefined();
      expect(typeof result.current.startSync).toBe("function");
    });

    it("should handle completely missing window.api", () => {
      delete (window as any).api;

      const { result } = renderHook(() => useIPhoneSync());

      expect(result.current.isConnected).toBe(false);
      expect(result.current.device).toBeNull();
    });
  });

  describe("error logging", () => {
    it("should log error when starting sync without device", async () => {
      const { result } = renderHook(() => useIPhoneSync());

      await result.current.startSync();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[ERROR] [useIPhoneSync] Cannot start sync: No device connected"),
      );
    });

    it("should log error when submitting password without device", async () => {
      const { result } = renderHook(() => useIPhoneSync());

      await result.current.submitPassword("test-password");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[ERROR] [useIPhoneSync] Cannot submit password: No device connected"),
      );
    });
  });

  describe("sync API path", () => {
    it("should use sync API when available", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      renderHook(() => useIPhoneSync());

      expect(syncApi.startDetection).toHaveBeenCalled();
      expect(syncApi.onDeviceConnected).toHaveBeenCalled();
      expect(syncApi.onDeviceDisconnected).toHaveBeenCalled();
      expect(syncApi.onProgress).toHaveBeenCalled();
    });

    it("should stop sync detection on unmount", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { unmount } = renderHook(() => useIPhoneSync());
      unmount();

      expect(syncApi.stopDetection).toHaveBeenCalled();
    });

    it("should provide checkSyncStatus function", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      expect(typeof result.current.checkSyncStatus).toBe("function");
    });

    it("should provide isWaitingForPasscode state", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      expect(result.current.isWaitingForPasscode).toBe(false);
    });

    it("should provide syncLocked state", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      expect(result.current.syncLocked).toBe(false);
      expect(result.current.lockReason).toBeNull();
    });
  });

  describe("device connection events", () => {
    it("should update state when device connects via sync API", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        // Allow promises to resolve
        await Promise.resolve();
      });

      expect(result.current.isConnected).toBe(true);
      expect(result.current.device).toEqual({
        udid: mockDevice.udid,
        name: mockDevice.name,
        productType: mockDevice.productType,
        productVersion: mockDevice.productVersion,
        serialNumber: mockDevice.serialNumber,
        isConnected: true,
      });
      expect(result.current.error).toBeNull();
    });

    it("should clear device state on disconnect", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      // Connect first
      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      expect(result.current.isConnected).toBe(true);

      // Then disconnect
      act(() => {
        deviceDisconnectedCallback?.();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.device).toBeNull();
    });

    it("should fetch last sync time on device connect", async () => {
      const syncApi = setupSyncApiMock();
      const getIPhoneLastSyncTimeMock = jest.fn().mockResolvedValue({
        lastSyncTime: "2024-01-15T10:00:00Z",
      });
      (syncApi as any).getIPhoneLastSyncTime = getIPhoneLastSyncTimeMock;
      (window as any).api = { sync: syncApi };

      renderHook(() => useIPhoneSync());

      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(getIPhoneLastSyncTimeMock).toHaveBeenCalledWith(mockDevice.udid);
    });
  });

  describe("sync progress handling", () => {
    it("should update progress during backup phase", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      // Connect device and start sync
      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      // syncStateRef.isActive must be true for progress events to be processed
      syncStateRef.isActive = true;

      act(() => {
        syncProgressCallback?.({
          phase: "backup",
          overallProgress: 25,
          message: "Backing up...",
        });
      });

      expect(result.current.progress).toEqual({
        phase: "backing_up",
        percent: 25,
        message: "Backing up...",
        bytesProcessed: undefined,
        processedFiles: undefined,
        estimatedTotalBytes: undefined,
      });
    });

    it("should map decrypting phase to extracting", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;

      act(() => {
        syncProgressCallback?.({
          phase: "decrypting",
          overallProgress: 50,
          message: "Decrypting backup...",
        });
      });

      expect(result.current.progress?.phase).toBe("extracting");
    });

    it("should map parsing phases to extracting", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;

      act(() => {
        syncProgressCallback?.({
          phase: "parsing_messages",
          overallProgress: 60,
          message: "Parsing messages...",
        });
      });

      expect(result.current.progress?.phase).toBe("extracting");

      act(() => {
        syncProgressCallback?.({
          phase: "parsing_contacts",
          overallProgress: 70,
        });
      });

      expect(result.current.progress?.phase).toBe("extracting");

      act(() => {
        syncProgressCallback?.({
          phase: "resolving",
          overallProgress: 80,
        });
      });

      expect(result.current.progress?.phase).toBe("extracting");
    });

    it("should map complete phase", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;

      act(() => {
        syncProgressCallback?.({
          phase: "complete",
          overallProgress: 100,
          message: "Complete",
        });
      });

      expect(result.current.progress?.phase).toBe("complete");
      expect(result.current.progress?.percent).toBe(100);
    });

    it("should include backup progress details", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;

      act(() => {
        syncProgressCallback?.({
          phase: "backup",
          overallProgress: 30,
          message: "Transferring...",
          estimatedTotalBytes: 1000000,
          backupProgress: {
            bytesTransferred: 300000,
            filesTransferred: 50,
          },
        });
      });

      expect(result.current.progress).toEqual({
        phase: "backing_up",
        percent: 30,
        message: "Transferring...",
        bytesProcessed: 300000,
        processedFiles: 50,
        estimatedTotalBytes: 1000000,
      });
    });
  });

  describe("password handling", () => {
    it("should set needsPassword when password required event fires", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        passwordRequiredCallback?.();
      });

      expect(result.current.needsPassword).toBe(true);
    });

    it("should clear needsPassword on successful sync complete", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        passwordRequiredCallback?.();
      });

      expect(result.current.needsPassword).toBe(true);

      act(() => {
        syncCompleteCallback?.({ success: true, messageCount: 100 });
      });

      expect(result.current.needsPassword).toBe(false);
    });
  });

  describe("passcode waiting events", () => {
    it("should set isWaitingForPasscode when waiting event fires", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;

      act(() => {
        waitingForPasscodeCallback?.();
      });

      expect(result.current.isWaitingForPasscode).toBe(true);
      expect(result.current.progress?.message).toContain("preparing the export");
    });

    it("should clear isWaitingForPasscode when passcode entered", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;

      act(() => {
        waitingForPasscodeCallback?.();
      });

      expect(result.current.isWaitingForPasscode).toBe(true);

      act(() => {
        passcodeEnteredCallback?.();
      });

      expect(result.current.isWaitingForPasscode).toBe(false);
    });
  });

  describe("sync error handling", () => {
    it("should set error state on sync error event", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        syncErrorCallback?.({ message: "Backup failed: device locked" });
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.error).toBe("Backup failed: device locked");
    });

    it("should handle sync complete with failure", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        syncCompleteCallback?.({ success: false, error: "Extraction failed" });
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.error).toBe("Extraction failed");
    });
  });

  describe("sync complete handling", () => {
    it("should update state on successful sync extraction", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        syncCompleteCallback?.({
          success: true,
          messageCount: 500,
          contactCount: 50,
          conversationCount: 25,
        });
      });

      expect(result.current.syncStatus).toBe("syncing"); // Still syncing while storing
      expect(result.current.progress?.phase).toBe("storing");
      expect(result.current.progress?.message).toContain("500");
    });
  });

  describe("storage complete handling", () => {
    it("should update state on storage complete", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        storageCompleteCallback?.({
          messagesStored: 500,
          contactsStored: 50,
          duration: 5000,
        });
      });

      expect(result.current.syncStatus).toBe("complete");
      expect(result.current.progress?.phase).toBe("complete");
      expect(result.current.progress?.percent).toBe(100);
      expect(result.current.lastSyncTime).toBeInstanceOf(Date);
    });

    it("should handle storage error gracefully", () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        storageErrorCallback?.({ error: "Database write failed" });
      });

      // Still marks as complete since extraction succeeded
      expect(result.current.syncStatus).toBe("complete");
      expect(result.current.progress?.phase).toBe("complete");
    });
  });

  describe("startSync", () => {
    it("should set error when no device connected", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      await act(async () => {
        await result.current.startSync();
      });

      expect(result.current.error).toBe("No device connected");
    });

    it("should set error when sync API not available", async () => {
      (window as any).api = { device: { startDetection: jest.fn(), stopDetection: jest.fn(), onConnected: jest.fn(() => jest.fn()), onDisconnected: jest.fn(() => jest.fn()) } };

      const { result } = renderHook(() => useIPhoneSync());

      // Manually set device to simulate connected state
      await act(async () => {
        // We can't directly connect a device without the sync API path,
        // so this tests the fallback error handling
        await result.current.startSync();
      });

      expect(result.current.error).toBe("No device connected");
    });

    it("should start sync with connected device", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      // Connect device first
      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.startSync();
      });

      expect(syncApi.start).toHaveBeenCalledWith({
        udid: mockDevice.udid,
        password: undefined,
        forceFullBackup: false,
      });
      expect(result.current.syncStatus).toBe("syncing");
    });

    it("should block sync when another operation is running", async () => {
      const syncApi = setupSyncApiMock();
      syncApi.getUnifiedStatus.mockResolvedValue({
        isAnyOperationRunning: true,
        currentOperation: "email_sync",
      });
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      // Connect device
      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.startSync();
      });

      expect(result.current.syncLocked).toBe(true);
      expect(result.current.lockReason).toBe("email_sync");
      expect(syncApi.start).not.toHaveBeenCalled();
    });

    it("should handle sync start failure", async () => {
      const syncApi = setupSyncApiMock();
      syncApi.start.mockResolvedValue({ success: false, error: "Device not trusted" });
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.startSync();
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.error).toBe("Device not trusted");
    });

    it("should handle sync start exception", async () => {
      const syncApi = setupSyncApiMock();
      syncApi.start.mockRejectedValue(new Error("Connection timeout"));
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.startSync();
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.error).toBe("Connection timeout");
    });

    it("should block sync when deferredLogout is pending (TASK-2109)", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      // Connect device
      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      // Set deferred logout flag
      syncStateRef.deferredLogout = true;

      await act(async () => {
        await result.current.startSync();
      });

      expect(syncApi.start).not.toHaveBeenCalled();
      expect(result.current.error).toBe("Session expired. Please sign in again.");
    });
  });

  describe("submitPassword", () => {
    it("should retry sync with password", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.submitPassword("my-secret-password");
      });

      expect(syncApi.start).toHaveBeenCalledWith({
        udid: mockDevice.udid,
        password: "my-secret-password",
      });
    });

    it("should handle incorrect password error", async () => {
      const syncApi = setupSyncApiMock();
      syncApi.start.mockResolvedValue({ success: false, error: "Invalid password" });
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.submitPassword("wrong-password");
      });

      expect(result.current.needsPassword).toBe(true);
      expect(result.current.error).toBe("Incorrect password. Please try again.");
    });

    it("should handle password submit exception", async () => {
      const syncApi = setupSyncApiMock();
      syncApi.start.mockRejectedValue(new Error("Decryption failed"));
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.submitPassword("test");
      });

      expect(result.current.needsPassword).toBe(true);
      expect(result.current.error).toBe("Decryption failed");
    });
  });

  describe("cancelSync", () => {
    it("should cancel ongoing sync", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      await act(async () => {
        await result.current.cancelSync();
      });

      expect(syncApi.cancel).toHaveBeenCalled();
      expect(result.current.syncStatus).toBe("idle");
      expect(result.current.progress).toBeNull();
      expect(result.current.needsPassword).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should handle cancel error gracefully", async () => {
      const syncApi = setupSyncApiMock();
      syncApi.cancel.mockRejectedValue(new Error("Cancel failed"));
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      // Should not throw
      await act(async () => {
        await result.current.cancelSync();
      });

      expect(result.current.syncStatus).toBe("idle");
    });
  });

  describe("checkSyncStatus", () => {
    it("should update sync lock state", async () => {
      const syncApi = setupSyncApiMock();
      syncApi.getUnifiedStatus.mockResolvedValue({
        isAnyOperationRunning: true,
        currentOperation: "backup",
      });
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      // Initial check happens on mount, advance timers
      await act(async () => {
        jest.advanceTimersByTime(100);
        await Promise.resolve();
      });

      expect(result.current.syncLocked).toBe(true);
      expect(result.current.lockReason).toBe("backup");
    });

    it("should poll sync status periodically", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi };

      renderHook(() => useIPhoneSync());

      // Initial call
      expect(syncApi.getUnifiedStatus).toHaveBeenCalledTimes(1);

      // After 5 seconds
      await act(async () => {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(syncApi.getUnifiedStatus).toHaveBeenCalledTimes(2);

      // After another 5 seconds
      await act(async () => {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(syncApi.getUnifiedStatus).toHaveBeenCalledTimes(3);
    });

    it("should handle missing getUnifiedStatus gracefully", async () => {
      const syncApi = setupSyncApiMock();
      delete (syncApi as any).getUnifiedStatus;
      (window as any).api = { sync: syncApi };

      const { result } = renderHook(() => useIPhoneSync());

      // Should not throw
      await act(async () => {
        await result.current.checkSyncStatus();
      });

      expect(result.current.syncLocked).toBe(false);
    });
  });

  describe("device disconnect during sync", () => {
    it("should set error when disconnected during backup phase", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      // Connect and start sync
      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.startSync();
      });

      // Set phase to backing_up
      act(() => {
        syncProgressCallback?.({ phase: "backup", overallProgress: 50 });
      });

      // Disconnect during backup
      act(() => {
        deviceDisconnectedCallback?.();
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.error).toBe("Device disconnected during sync");
    });

    it("should not set error when disconnected during safe phase", async () => {
      const syncApi = setupSyncApiMock();
      (window as any).api = { sync: syncApi, backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) } };

      const { result } = renderHook(() => useIPhoneSync());

      // Connect and start sync
      await act(async () => {
        deviceConnectedCallback?.(mockDevice);
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.startSync();
      });

      // Set phase to extracting (safe to disconnect)
      act(() => {
        syncProgressCallback?.({ phase: "parsing_messages", overallProgress: 70 });
      });

      // Disconnect during extraction
      act(() => {
        deviceDisconnectedCallback?.();
      });

      // Should still be syncing, not error
      expect(result.current.syncStatus).toBe("syncing");
      expect(result.current.error).toBeNull();
    });
  });

  // BACKLOG-1702: tools-missing prompt must be platform-correct.
  // On macOS it should point at libimobiledevice (brew); on Windows it should
  // keep the existing iTunes / Microsoft Store guidance.
  describe("tools-missing user error (BACKLOG-1702)", () => {
    let toolsMissingCallback: (() => void) | null = null;
    const originalPlatform = process.platform;

    const setPlatform = (platform: NodeJS.Platform) => {
      Object.defineProperty(process, "platform", {
        value: platform,
        configurable: true,
      });
    };

    beforeEach(() => {
      toolsMissingCallback = null;
      (window as any).api = {
        device: {
          startDetection: jest.fn(),
          stopDetection: jest.fn(),
          onConnected: jest.fn(() => jest.fn()),
          onDisconnected: jest.fn(() => jest.fn()),
          onToolsMissing: jest.fn((cb: () => void) => {
            toolsMissingCallback = cb;
            return jest.fn();
          }),
          onToolsAvailable: jest.fn(() => jest.fn()),
        },
        backup: {
          start: jest.fn(),
          startWithPassword: jest.fn(),
          cancel: jest.fn(),
          onProgress: jest.fn(() => jest.fn()),
          onError: jest.fn(() => jest.fn()),
          checkStatus: jest.fn().mockResolvedValue({ success: true, lastSyncTime: null }),
        },
      };
    });

    afterEach(() => {
      setPlatform(originalPlatform);
    });

    it("suggests `brew install libimobiledevice` on macOS", () => {
      setPlatform("darwin");

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        toolsMissingCallback?.();
      });

      expect(result.current.userError).not.toBeNull();
      expect(result.current.userError?.code).toBe("MISSING_DRIVERS");
      expect(result.current.userError?.title).toBe("iPhone sync tools not installed");
      expect(result.current.userError?.description).toMatch(/libimobiledevice/i);
      expect(result.current.userError?.actionSuggestion).toMatch(/brew install libimobiledevice/i);
      expect(result.current.userError?.actionSuggestion).not.toMatch(/Microsoft Store/i);
    });

    it("keeps Microsoft Store / iTunes guidance on Windows", () => {
      setPlatform("win32");

      const { result } = renderHook(() => useIPhoneSync());

      act(() => {
        toolsMissingCallback?.();
      });

      expect(result.current.userError).not.toBeNull();
      expect(result.current.userError?.code).toBe("MISSING_DRIVERS");
      expect(result.current.userError?.title).toBe("Apple drivers not installed");
      expect(result.current.userError?.actionSuggestion).toMatch(/Microsoft Store/i);
      expect(result.current.userError?.actionSuggestion).not.toMatch(/brew/i);
    });
  });
});
