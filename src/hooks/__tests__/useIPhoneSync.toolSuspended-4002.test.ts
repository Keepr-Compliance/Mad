/**
 * BACKLOG-4002 (SR N3) — the hook's half of the suspended notice.
 *
 * SyncProgress is fed by props (its own suite) and main is proven in
 * backupService.toolSuspended-4002. Neither covers THIS: a hook that sets the notice on
 * { suspended: true } and ignores { suspended: false } passes both. So: the bridge event
 * true then false, and the notice also cleared on a sync error, a sync complete and the
 * next sync start (cross-run stickiness), and never set once the sync is no longer active.
 */
import { renderHook, act } from "@testing-library/react";
import { useIPhoneSync, syncStateRef } from "../useIPhoneSync";

jest.mock("../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: true, isMacOS: false, isLinux: false, platform: "win32" }),
}));

const NOTICE = {
  code: "IPHONE_TOOL_SUSPENDED",
  title: "Your antivirus may have paused the backup",
  description: "d",
  actionSuggestion: "1. a\nIf this keeps happening, contact support.",
};

const device = {
  udid: "test-udid-123",
  name: "Test iPhone",
  productType: "iPhone14,2",
  productVersion: "17.0",
  serialNumber: "ABC123",
  isConnected: true,
};

type Cb<T> = ((v: T) => void) | null;
let connected: Cb<unknown> = null;
let toolSuspended: Cb<{ suspended: boolean; userError?: typeof NOTICE }> = null;
let onError: Cb<{ message: string; userError?: unknown }> = null;
let onComplete: Cb<unknown> = null;

function syncApi(start: jest.Mock) {
  return {
    startDetection: jest.fn(),
    stopDetection: jest.fn(),
    start,
    cancel: jest.fn().mockResolvedValue(undefined),
    getUnifiedStatus: jest.fn().mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
    onDeviceConnected: jest.fn((cb) => ((connected = cb), jest.fn())),
    onDeviceDisconnected: jest.fn(() => jest.fn()),
    onProgress: jest.fn(() => jest.fn()),
    onError: jest.fn((cb) => ((onError = cb), jest.fn())),
    onComplete: jest.fn((cb) => ((onComplete = cb), jest.fn())),
    onWaitingForPasscode: jest.fn(() => jest.fn()),
    onPasscodeEntered: jest.fn(() => jest.fn()),
    onToolSuspended: jest.fn((cb) => ((toolSuspended = cb), jest.fn())),
    onStorageComplete: jest.fn(() => jest.fn()),
    onStorageError: jest.fn(() => jest.fn()),
  };
}

async function runningSync() {
  const start = jest.fn().mockResolvedValue({ success: true });
  (window as unknown as { api: unknown }).api = {
    sync: syncApi(start),
    backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) },
  };
  const hook = renderHook(() => useIPhoneSync());
  await act(async () => {
    connected?.(device);
    await Promise.resolve();
  });
  await act(async () => {
    await hook.result.current.startSync();
  });
  expect(syncStateRef.isActive).toBe(true);
  return { hook, start };
}

const show = () => act(() => toolSuspended?.({ suspended: true, userError: NOTICE }));

beforeEach(() => {
  jest.useFakeTimers();
  syncStateRef.isActive = false;
  syncStateRef.deferredLogout = false;
  connected = toolSuspended = onError = onComplete = null;
  jest.spyOn(console, "error").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "log").mockImplementation();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  syncStateRef.isActive = false;
});

describe("BACKLOG-4002 useIPhoneSync: the suspended notice", () => {
  it("set by { suspended: true }, cleared by { suspended: false }", async () => {
    const { hook } = await runningSync();
    show();
    expect(hook.result.current.toolSuspendedNotice).toEqual(NOTICE);
    act(() => toolSuspended?.({ suspended: false }));
    expect(hook.result.current.toolSuspendedNotice).toBeNull();
  });

  it("cleared by a sync error", async () => {
    const { hook } = await runningSync();
    show();
    act(() => onError?.({ message: "Backup process became unresponsive and was terminated" }));
    expect(hook.result.current.toolSuspendedNotice).toBeNull();
  });

  it("cleared by a sync complete", async () => {
    const { hook } = await runningSync();
    show();
    act(() => onComplete?.({ success: true, messageCount: 1 }));
    expect(hook.result.current.toolSuspendedNotice).toBeNull();
  });

  it("cleared by the next sync start", async () => {
    const { hook } = await runningSync();
    show();
    expect(hook.result.current.toolSuspendedNotice).toEqual(NOTICE);
    await act(async () => {
      await hook.result.current.startSync();
    });
    expect(hook.result.current.toolSuspendedNotice).toBeNull();
  });

  it("cleared by Cancel", async () => {
    const { hook } = await runningSync();
    show();
    await act(async () => {
      await hook.result.current.cancelSync("progress-cancel");
    });
    expect(hook.result.current.toolSuspendedNotice).toBeNull();
  });

  it("never set when no sync is active (a late event after Cancel)", async () => {
    const { hook } = await runningSync();
    syncStateRef.isActive = false;
    show();
    expect(hook.result.current.toolSuspendedNotice).toBeNull();
  });
});
