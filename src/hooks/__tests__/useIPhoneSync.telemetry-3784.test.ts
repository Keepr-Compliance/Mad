/**
 * BACKLOG-3784 — iPhone sync telemetry, renderer half.
 *
 * 1. The database-save phase ("storing", sent by syncHandlers for every save tick)
 *    must reach the modal as "storing", not fall through to "backing_up" — which
 *    read "Exporting - Keep connected" while saving.
 * 2. The completion-shown ack goes to main once, after the completion state commits,
 *    carrying the renderer's own receivedAt/shownAt stamps.
 * 3. The renderer heartbeat ticks once a second while syncing, first tick flagged,
 *    and stops when the sync leaves "syncing".
 *
 * Payload shapes are transcribed from the producers: progress from
 * electron/handlers/syncHandlers.ts (`sendToMainWindow("sync:progress", { phase:
 * "storing", percent, message })`), completion from the same file's
 * `sync:complete` / `sync:storage-complete` sends.
 */

import { renderHook, act } from "@testing-library/react";
import { useIPhoneSync, syncStateRef } from "../useIPhoneSync";

jest.mock("../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: false, isMacOS: false, isLinux: true, platform: "linux" }),
}));

type Cb = ((arg?: unknown) => void) | null;

describe("useIPhoneSync telemetry (BACKLOG-3784)", () => {
  let progressCb: Cb;
  let completeCb: Cb;
  let storageCompleteCb: Cb;
  let errorCb: Cb;
  let syncApi: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
    syncStateRef.isActive = false;
    syncStateRef.deferredLogout = false;
    progressCb = completeCb = storageCompleteCb = errorCb = null;
    const sub = (set: (cb: Cb) => void) =>
      jest.fn((cb: Cb) => {
        set(cb);
        return jest.fn();
      });
    syncApi = {
      startDetection: jest.fn(),
      stopDetection: jest.fn(),
      start: jest.fn().mockResolvedValue({ success: true }),
      cancel: jest.fn().mockResolvedValue(undefined),
      getUnifiedStatus: jest
        .fn()
        .mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
      onDeviceConnected: jest.fn(() => jest.fn()),
      onDeviceDisconnected: jest.fn(() => jest.fn()),
      onProgress: sub((cb) => (progressCb = cb)),
      onPasswordRequired: jest.fn(() => jest.fn()),
      onError: sub((cb) => (errorCb = cb)),
      onComplete: sub((cb) => (completeCb = cb)),
      onWaitingForPasscode: jest.fn(() => jest.fn()),
      onPasscodeEntered: jest.fn(() => jest.fn()),
      onStorageComplete: sub((cb) => (storageCompleteCb = cb)),
      onStorageError: jest.fn(() => jest.fn()),
      reportCompletionShown: jest.fn(),
      rendererTick: jest.fn(),
    };
    (window as unknown as { api: unknown }).api = { sync: syncApi };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    syncStateRef.isActive = false;
  });

  describe("phase label", () => {
    it.each([
      ["backup", "backing_up"],
      ["decrypting", "extracting"],
      ["parsing_messages", "extracting"],
      ["resolving", "extracting"],
      ["storing", "storing"],
      ["complete", "complete"],
    ])("main phase %s -> modal phase %s", (mainPhase, expected) => {
      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;
      act(() => {
        progressCb?.({ phase: mainPhase, overallProgress: 40, message: "x" });
      });
      expect(result.current.progress?.phase).toBe(expected);
    });

    it("a save tick after extraction keeps the modal on storing", () => {
      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;
      act(() => {
        completeCb?.({ success: true, messageCount: 37, contactCount: 1, conversationCount: 1 });
      });
      expect(result.current.progress?.phase).toBe("storing");
      act(() => {
        progressCb?.({ phase: "storing", overallProgress: 3, message: "Saving messages... 1 of 37" });
      });
      expect(result.current.progress?.phase).toBe("storing");
    });
  });

  describe("completion-shown ack", () => {
    it("sends one ack after the completion state commits, with renderer stamps", () => {
      jest.setSystemTime(new Date("2026-10-08T06:10:34.500Z"));
      const { result } = renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;
      act(() => {
        storageCompleteCb?.({ messagesStored: 37, contactsStored: 0, duration: 100 });
      });
      expect(result.current.syncStatus).toBe("complete");
      // Not before the frame + paint tick.
      expect(syncApi.reportCompletionShown).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(50);
      });
      expect(syncApi.reportCompletionShown).toHaveBeenCalledTimes(1);
      const ack = syncApi.reportCompletionShown.mock.calls[0][0] as {
        receivedAt: number;
        shownAt: number;
      };
      expect(ack.receivedAt).toBe(new Date("2026-10-08T06:10:34.500Z").getTime());
      expect(ack.shownAt).toBeGreaterThanOrEqual(ack.receivedAt);

      // A re-render does not send a second ack.
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(syncApi.reportCompletionShown).toHaveBeenCalledTimes(1);
    });

    it("a later sync that ends in a storage error sends no stale ack", () => {
      const storageErrorCbs: Cb[] = [];
      syncApi.onStorageError = jest.fn((cb: Cb) => {
        storageErrorCbs.push(cb);
        return jest.fn();
      });
      renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;
      act(() => {
        storageCompleteCb?.({ messagesStored: 37, contactsStored: 0, duration: 100 });
      });
      act(() => {
        jest.advanceTimersByTime(50);
      });
      expect(syncApi.reportCompletionShown).toHaveBeenCalledTimes(1);

      // Next sync: extraction done (status back to syncing), then storage fails.
      syncStateRef.isActive = true;
      act(() => {
        completeCb?.({ success: true, messageCount: 1, contactCount: 0, conversationCount: 1 });
      });
      act(() => {
        storageErrorCbs[storageErrorCbs.length - 1]?.({ error: "Database write failed" });
      });
      expect(storageErrorCbs.length).toBeGreaterThan(0);
      act(() => {
        jest.advanceTimersByTime(50);
      });
      expect(syncApi.reportCompletionShown).toHaveBeenCalledTimes(1);
    });

    it("sends no ack when storage did not complete", () => {
      renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;
      act(() => {
        errorCb?.({ message: "boom" });
        jest.advanceTimersByTime(100);
      });
      expect(syncApi.reportCompletionShown).not.toHaveBeenCalled();
    });
  });

  describe("renderer heartbeat", () => {
    it("ticks every second while syncing, first tick flagged, stops on completion", () => {
      renderHook(() => useIPhoneSync());
      syncStateRef.isActive = true;
      act(() => {
        completeCb?.({ success: true, messageCount: 37, contactCount: 1, conversationCount: 1 });
      });
      expect(syncApi.rendererTick).toHaveBeenCalledTimes(1);
      expect(syncApi.rendererTick.mock.calls[0][0]).toEqual({ first: true, hidden: false, stopped: false, screen: "unknown" });

      act(() => {
        jest.advanceTimersByTime(3000);
      });
      expect(syncApi.rendererTick).toHaveBeenCalledTimes(4);
      expect(syncApi.rendererTick.mock.calls[3][0]).toEqual({ first: false, hidden: false, stopped: false, screen: "unknown" });

      act(() => {
        storageCompleteCb?.({ messagesStored: 37, contactsStored: 0, duration: 100 });
      });
      const afterComplete = syncApi.rendererTick.mock.calls.length;
      // BACKLOG-3785: leaving "syncing" sends exactly one `stopped` tick.
      expect(syncApi.rendererTick.mock.calls[afterComplete - 1][0]).toEqual({
        first: false,
        hidden: false,
        stopped: true,
        screen: "unknown",
      });
      expect(syncApi.rendererTick.mock.calls.filter(([t]: [{ stopped?: boolean }]) => t.stopped)).toHaveLength(1);
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(syncApi.rendererTick).toHaveBeenCalledTimes(afterComplete);
    });

    it("does not tick when no sync is running", () => {
      renderHook(() => useIPhoneSync());
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(syncApi.rendererTick).not.toHaveBeenCalled();
    });
  });
});
