/**
 * BACKLOG-3784 — the two renderer → main telemetry channels reach the timeline.
 *
 * Channel names are the ones the preload sends (electron/preload/deviceBridge.ts:
 * `reportCompletionShown` → "sync:completion-shown", `rendererTick` →
 * "sync:renderer-tick"). Malformed payloads are dropped to undefined/false, never
 * thrown.
 */

import { EventEmitter } from "events";

const listeners = new Map<string, (event: unknown, payload: unknown) => void>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn(),
    removeHandler: jest.fn(),
    removeAllListeners: jest.fn((channel: string) => listeners.delete(channel)),
    on: jest.fn((channel: string, fn: (event: unknown, payload: unknown) => void) =>
      listeners.set(channel, fn),
    ),
  },
  BrowserWindow: jest.fn(),
}));

jest.mock("../../services/deviceDetectionService", () => ({
  deviceDetectionService: new EventEmitter(),
}));
jest.mock("../../services/deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: Object.assign(new (jest.requireActual("events").EventEmitter)(), {
    stopDeviceDetection: jest.fn(),
  }),
  DeviceSyncOrchestrator: class {},
}));
jest.mock("../../services/iPhoneSyncStorageService", () => ({ iPhoneSyncStorageService: {} }));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn(),
  expandAttachedThreadsForUser: jest.fn(),
}));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/syncStatusService", () => ({ syncStatusService: {} }));
jest.mock("../../services/syncTimeline", () => ({
  syncTimeline: {
    markCompletionShown: jest.fn(),
    noteRendererTick: jest.fn(),
    markStorageCompleteSent: jest.fn(),
  },
}));

jest.mock("../../services/rendererFreezeProfiler", () => ({
  rendererFreezeProfiler: { noteTick: jest.fn() },
}));

import { registerSyncHandlers, cleanupSyncHandlers } from "../syncHandlers";
import { rendererFreezeProfiler } from "../../services/rendererFreezeProfiler";
import { syncTimeline } from "../../services/syncTimeline";

const timeline = syncTimeline as unknown as {
  markCompletionShown: jest.Mock;
  noteRendererTick: jest.Mock;
};

describe("BACKLOG-3784: telemetry IPC", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerSyncHandlers({} as never);
  });

  afterEach(() => cleanupSyncHandlers());

  it("sync:completion-shown records the ack with the renderer's stamps", () => {
    listeners.get("sync:completion-shown")?.({}, { receivedAt: 100, shownAt: 250 });
    expect(timeline.markCompletionShown).toHaveBeenCalledWith({ receivedAt: 100, shownAt: 250 });
  });

  it("sync:completion-shown drops malformed stamps", () => {
    listeners.get("sync:completion-shown")?.({}, { receivedAt: "x" });
    listeners.get("sync:completion-shown")?.({}, null);
    expect(timeline.markCompletionShown.mock.calls).toEqual([
      [{ receivedAt: undefined, shownAt: undefined }],
      [{ receivedAt: undefined, shownAt: undefined }],
    ]);
  });

  it("sync:renderer-tick forwards first/hidden as booleans", () => {
    listeners.get("sync:renderer-tick")?.({}, { first: true, hidden: false });
    listeners.get("sync:renderer-tick")?.({}, { first: "yes", hidden: 1 });
    expect(timeline.noteRendererTick.mock.calls).toEqual([
      [{ first: true, hidden: false }],
      [{ first: false, hidden: false }],
    ]);
  });

  it("BACKLOG-3785: sync:renderer-tick also feeds the freeze profiler with the sender, stopped and screen", () => {
    const sender = { id: 1 };
    listeners.get("sync:renderer-tick")?.({ sender }, { first: false, hidden: false, stopped: true, screen: "dashboard" });
    listeners.get("sync:renderer-tick")?.({ sender }, { stopped: "yes", screen: 42 });
    expect((rendererFreezeProfiler.noteTick as jest.Mock).mock.calls).toEqual([
      [sender, { first: false, hidden: false, stopped: true, screen: "dashboard" }],
      [sender, { first: false, hidden: false, stopped: false, screen: undefined }],
    ]);
  });

  it("cleanup removes both listeners", () => {
    cleanupSyncHandlers();
    expect(listeners.has("sync:completion-shown")).toBe(false);
    expect(listeners.has("sync:renderer-tick")).toBe(false);
  });
});
