/**
 * BACKLOG-4115 SR B6: the Android pill polls only while enabled, and stops on
 * unmount / when disabled.
 */
import { renderHook, act } from "@testing-library/react";
import { useAndroidSyncState, ANDROID_PILL_POLL_MS } from "../useAndroidSyncState";
import { rcsImportService } from "../../services/rcsImportService";
import { EXT_BASE, LISTENING, job } from "../../appCore/shell/__tests__/syncPillFixtures";
import type { RcsJobInfo } from "../../../electron/types/ipc/window-api-rcs-import";

jest.mock("../../services/rcsImportService", () => ({
  rcsImportService: {
    getExtensionState: jest.fn(),
    getStatus: jest.fn(),
    getJob: jest.fn(),
    onJobProgress: jest.fn(),
  },
}));
const svc = rcsImportService as jest.Mocked<typeof rcsImportService>;
let progressCb: ((j: RcsJobInfo) => void) | null = null;
const unsubscribe = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  progressCb = null;
  svc.getExtensionState.mockResolvedValue({ success: true, data: EXT_BASE });
  svc.getStatus.mockResolvedValue({ success: true, data: LISTENING });
  svc.getJob.mockResolvedValue({ success: true, data: null });
  svc.onJobProgress.mockImplementation((cb) => {
    progressCb = cb;
    return unsubscribe;
  });
});
afterEach(() => jest.useRealTimers());

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

describe("useAndroidSyncState (B6)", () => {
  it("disabled: 0 reads, no subscription, after pollMs x 3", async () => {
    renderHook(() => useAndroidSyncState(false));
    await advance(ANDROID_PILL_POLL_MS * 3 + 1);
    expect(svc.getExtensionState).toHaveBeenCalledTimes(0);
    expect(svc.getStatus).toHaveBeenCalledTimes(0);
    expect(svc.getJob).toHaveBeenCalledTimes(0);
    expect(svc.onJobProgress).toHaveBeenCalledTimes(0);
  });

  it("enabled: >= 2 reads after pollMs x 3, one getJob, subscribed; none after unmount", async () => {
    const { result, unmount } = renderHook(() => useAndroidSyncState(true));
    await advance(ANDROID_PILL_POLL_MS * 3 + 1);
    expect(svc.getExtensionState.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(svc.getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(svc.getJob).toHaveBeenCalledTimes(1);
    expect(svc.onJobProgress).toHaveBeenCalledTimes(1);
    expect(result.current.ext).toEqual(EXT_BASE);
    expect(result.current.status).toEqual(LISTENING);
    const before = svc.getExtensionState.mock.calls.length;
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await advance(ANDROID_PILL_POLL_MS * 3 + 1);
    expect(svc.getExtensionState.mock.calls.length).toBe(before);
  });

  it("enabled -> disabled stops polling and unsubscribes", async () => {
    const { rerender } = renderHook(({ on }) => useAndroidSyncState(on), { initialProps: { on: true } });
    await advance(1);
    rerender({ on: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const before = svc.getExtensionState.mock.calls.length;
    await advance(ANDROID_PILL_POLL_MS * 3 + 1);
    expect(svc.getExtensionState.mock.calls.length).toBe(before);
  });

  it("maps job updates through orchestratorStepFor and re-reads the state when a Sync ends", async () => {
    const { result } = renderHook(() => useAndroidSyncState(true));
    await advance(1);
    const reads = svc.getExtensionState.mock.calls.length;
    act(() => progressCb?.(job({ state: "running", stage: "Saving your recent chats" })));
    expect(result.current.jobStep).toEqual({ kind: "progress", progress: 0, phase: "Saving your recent chats", indeterminate: true });
    expect(svc.getExtensionState.mock.calls.length).toBe(reads);
    act(() => progressCb?.(job({ state: "finished", stage: "Done" })));
    expect(result.current.jobStep).toEqual({ kind: "saving" });
    expect(svc.getExtensionState.mock.calls.length).toBe(reads + 1);
  });

  it("the link view follows browserLinkView: a saved, unproven link is 'checking' until the window ends", async () => {
    svc.getExtensionState.mockResolvedValue({ success: true, data: { ...EXT_BASE, extensionPaired: false } });
    const { result } = renderHook(() => useAndroidSyncState(true));
    await advance(1);
    await advance(1);
    expect(result.current.linkView).toBe("checking");
    await advance(5000);
    expect(result.current.linkView).toBe("linked");
  });
});
