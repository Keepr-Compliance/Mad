/**
 * BACKLOG-2897 — BACKUP PROGRESS IS FORWARDED AT MOST ONCE A SECOND.
 *
 * `backupService` emits a `progress` event per parsed stdout chunk. Before this change the
 * orchestrator's listener forwarded every one to `sync:progress`, and the renderer built a
 * new state object (one React render) per event: 10,000 events in, 10,000 sends out.
 *
 * The listener now throttles by TIME (the `backupAtRest` precedent, 1000 ms): one send per
 * interval, the last value seen in the interval sent when it ends, phase changes and
 * message changes sent at once, and nothing sent after the sync ends.
 *
 * FIXTURES ARE TRANSCRIBED, NOT INVENTED:
 * - transfer events: `backupService.parseProgress` byte branch (`phase: "transferring"`,
 *   `currentFile: null`, `filesTransferred: this.filesCompleted`, `totalBytes: null`);
 * - the first transfer event: its `"Receiving files"` branch (`percentComplete: 1`,
 *   `filesTransferred: 0`, `bytesTransferred: 0`);
 * - the end-of-backup event: the `finishing` emit in `backupService` (BACKLOG-2917 shape);
 * - the tool-hold notice: the `TOOL_START_HOLD_STATUS_MESSAGE` `preparing` emit.
 *   No live producer emits a `transferring` event that carries its own `message`; the live
 *   transfer-phase message change is the orchestrator's own "Starting file transfer..." ->
 *   "Receiving files from iPhone..." once `filesTransferred` is above zero.
 *
 * Scaffold: `deviceSyncOrchestrator.runEvidence-3440.test.ts`.
 */

import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";
const GB = 1024 * 1024 * 1024;

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const mockCancelBackup = jest.fn();
const mockStopForQuit = jest.fn();

jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("electron", () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  app: { isPackaged: false, getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()) },
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({ all: jest.fn(), get: jest.fn(), run: jest.fn() }),
    close: jest.fn(),
  })),
);

jest.mock("check-disk-space", () =>
  jest.fn().mockResolvedValue({ diskPath: "C:", free: 500 * GB, size: 1000 * GB }),
);

jest.mock("../diagnostics/diskSpaceDiagnostics", () => ({
  ...jest.requireActual("../diagnostics/diskSpaceDiagnostics"),
  checkDiskSpaceForOperation: jest
    .fn()
    .mockResolvedValue({ sufficient: true, availableMB: 500000, requiredMB: 1000 }),
}));

jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest
    .fn()
    .mockResolvedValue({ isInstalled: true, serviceRunning: true, version: "12.0.0", error: null }),
}));

jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn(() => true),
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
}));

let backupServiceInstance: EventEmitter | null = null;

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => {
    const svc = new EventEmitter();
    backupServiceInstance = svc;
    return Object.assign(svc, {
      checkBackupStatus: mockCheckBackupStatus,
      startBackup: mockStartBackup,
      cancelBackup: mockCancelBackup,
      stopForQuit: mockStopForQuit,
      sweepLeftoverBackups: jest.fn().mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] }),
      classifyBackupFolder: jest.fn().mockResolvedValue("absent"),
      removeLeftoverBackup: jest.fn().mockResolvedValue({ outcome: "kept", folder: "absent" }),
    });
  }),
}));

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  })),
  backupDecryptionService: { isBackupEncrypted: jest.fn().mockResolvedValue(false) },
}));

jest.mock("../deviceDetectionService", () => {
  const svc = new EventEmitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([
      {
        udid: UDID,
        name: "Test iPhone",
        productType: "iPhone18,2",
        productVersion: "26.6.1",
        serialNumber: "F2LX00000000",
        isConnected: true,
      },
    ]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * GB,
      usedSpace: 128 * GB,
      availableSpace: 128 * GB,
      estimatedBackupSize: 11_547 * 1024 * 1024,
    }),
  });
  return {
    DeviceDetectionService: jest.fn().mockImplementation(() => svc),
    deviceDetectionService: svc,
  };
});

jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getConversationsAsync: jest.fn().mockResolvedValue([]),
    getMessagesAsync: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../iosContactsParser", () => ({
  iOSContactsParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getAllContacts: jest.fn().mockReturnValue([]),
    lookupByHandle: jest.fn().mockReturnValue({ contact: null, matchType: null }),
  })),
}));

import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { syncTimeline } from "../syncTimeline";
import { TOOL_START_HOLD_STATUS_MESSAGE } from "../toolStartHold";
import type { BackupProgress } from "../../types/backup";
import type { SyncProgress } from "../deviceSyncOrchestrator";

/** `parseProgress` byte branch, transcribed. */
function transferEvent(bytesTransferred: number, filesTransferred = 5): BackupProgress {
  return {
    phase: "transferring",
    percentComplete: 10,
    currentFile: null,
    filesTransferred,
    totalFiles: null,
    bytesTransferred,
    totalBytes: null,
    estimatedTimeRemaining: null,
  };
}

/** `parseProgress` "Receiving files" branch, transcribed. */
const RECEIVING_FILES: BackupProgress = {
  phase: "transferring",
  percentComplete: 1,
  currentFile: null,
  filesTransferred: 0,
  totalFiles: null,
  bytesTransferred: 0,
  totalBytes: null,
  estimatedTimeRemaining: null,
};

/** The `finishing` emit at the end of a successful backup, transcribed. */
function finishingEvent(backupSize: number): BackupProgress {
  return {
    phase: "finishing",
    percentComplete: 100,
    currentFile: null,
    filesTransferred: 0,
    totalFiles: null,
    bytesTransferred: backupSize,
    totalBytes: backupSize,
    estimatedTimeRemaining: 0,
  };
}

/** The tool-start hold notice, transcribed (spread over the last transfer event). */
function toolHoldEvent(last: BackupProgress): BackupProgress {
  return { ...last, phase: "preparing", message: TOOL_START_HOLD_STATUS_MESSAGE };
}

interface Sent {
  at: number;
  progress: SyncProgress;
}

function harness() {
  const orchestrator = new DeviceSyncOrchestrator();
  const sent: Sent[] = [];
  orchestrator.on("progress", (p: SyncProgress) => sent.push({ at: Date.now(), progress: p }));
  orchestrator.on("error", () => {});
  expect(backupServiceInstance).not.toBeNull();
  const svc = backupServiceInstance!;
  return {
    orchestrator,
    sent,
    emit: (p: BackupProgress) => svc.emit("progress", p),
    sentBytes: () => sent.map((s) => s.progress.backupProgress?.bytesTransferred),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  syncTimeline.reset();
  backupServiceInstance = null;
});

describe("BACKLOG-2897: backup progress throttle (fake time)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const N = 10_000;
  const STEP_MS = 6; // 10,000 events over 60 s
  const BYTES_PER_EVENT = 540_000;

  /** The storm: 10,000 transfer events over 60 s, then 2 s of quiet. */
  function storm(h: ReturnType<typeof harness>): { lastInputAt: () => number } {
    let lastBytes = 0;
    const inputs: number[] = [];
    h.orchestrator.on("progress", () => inputs.push(lastBytes));
    for (let i = 1; i <= N; i++) {
      jest.advanceTimersByTime(STEP_MS);
      lastBytes = i * BYTES_PER_EVENT;
      h.emit(transferEvent(lastBytes));
    }
    jest.advanceTimersByTime(2000);
    return { lastInputAt: () => lastBytes };
  }

  it("C1 — 10,000 events over 60 s reach the renderer at most 62 times", () => {
    const h = harness();
    storm(h);
    expect(h.sent.length).toBeLessThanOrEqual(62);
    // ...and the bar keeps moving: at least one send per second of transfer.
    expect(h.sent.length).toBeGreaterThanOrEqual(59);
  });

  it("C2 — every send carries the newest value, and the final value lands exactly once", () => {
    const h = harness();
    let lastInput = 0;
    const newestAtSend: number[] = [];
    h.orchestrator.on("progress", () => newestAtSend.push(lastInput));
    for (let i = 1; i <= N; i++) {
      jest.advanceTimersByTime(STEP_MS);
      lastInput = i * BYTES_PER_EVENT;
      h.emit(transferEvent(lastInput));
    }
    const finalBytes = N * BYTES_PER_EVENT;
    jest.advanceTimersByTime(2000);

    // Each send is the last value seen at the moment it was sent (trailing, not stale).
    expect(h.sentBytes()).toEqual(newestAtSend);
    // The stream's last value is sent after the stream ends, once.
    expect(h.sentBytes()[h.sentBytes().length - 1]).toBe(finalBytes);
    expect(h.sentBytes().filter((b) => b === finalBytes)).toHaveLength(1);
    // Nothing further once the interval after the last value has passed.
    const count = h.sent.length;
    jest.advanceTimersByTime(10_000);
    expect(h.sent.length).toBe(count);
  });

  it("C3 — time-based, not count-based: one event a second is sent every time", () => {
    const h = harness();
    for (let i = 1; i <= 50; i++) {
      h.emit(transferEvent(i * GB));
      jest.advanceTimersByTime(1000);
    }
    expect(h.sent.length).toBeGreaterThanOrEqual(50);
  });

  it("C3 — an uneven stream: the last value of every burst is sent", () => {
    // Bursts of very different sizes, each followed by 1.2 s of quiet. A time throttle
    // sends every burst's last value; an every-Nth-event throttle misses most of them.
    const h = harness();
    const sizes = [1, 7, 250, 3, 1013, 2, 61, 1, 499, 17];
    let bytes = 0;
    const burstEnds: number[] = [];
    for (const size of sizes) {
      for (let j = 0; j < size; j++) {
        bytes += 1_000_003;
        h.emit(transferEvent(bytes));
        jest.advanceTimersByTime(size > 100 ? 0 : 5);
      }
      burstEnds.push(bytes);
      jest.advanceTimersByTime(1200);
    }
    const sent = h.sentBytes();
    for (const end of burstEnds) expect(sent).toContain(end);
    expect(sent[sent.length - 1]).toBe(bytes);
  });

  it("C4 — a phase change is sent at once and the held transfer value is never sent after it", () => {
    const h = harness();
    for (let i = 1; i <= 50; i++) h.emit(transferEvent(i * 1_000_000));
    jest.advanceTimersByTime(200);
    const before = h.sent.length;
    h.emit(finishingEvent(71_568_139_822));
    // Delivered synchronously, without waiting for the interval.
    expect(h.sent.length).toBe(before + 1);
    expect(h.sent[h.sent.length - 1].progress.backupProgress?.phase).toBe("finishing");
    jest.advanceTimersByTime(5000);
    // The bar does not step back to a stale transfer value.
    expect(h.sent.length).toBe(before + 1);
    expect(h.sent[h.sent.length - 1].progress.backupProgress?.phase).toBe("finishing");
  });

  it("C4 — the tool-hold notice 10 ms after a byte event is delivered at once", () => {
    const h = harness();
    const last = transferEvent(3 * GB);
    h.emit(transferEvent(2 * GB));
    jest.advanceTimersByTime(10);
    h.emit(last);
    jest.advanceTimersByTime(10);
    const before = h.sent.length;
    h.emit(toolHoldEvent(last));
    expect(h.sent.length).toBe(before + 1);
    expect(h.sent[h.sent.length - 1].progress.message).toBe(TOOL_START_HOLD_STATUS_MESSAGE);
    jest.advanceTimersByTime(5000);
    expect(h.sent[h.sent.length - 1].progress.message).toBe(TOOL_START_HOLD_STATUS_MESSAGE);
  });

  it("C4 — the transfer-phase message change is delivered at once, not coalesced", () => {
    const h = harness();
    h.emit(RECEIVING_FILES); // "Starting file transfer..."
    jest.advanceTimersByTime(10);
    h.emit(transferEvent(1_000_000, 0)); // same message: held
    jest.advanceTimersByTime(10);
    const before = h.sent.length;
    h.emit(transferEvent(2_000_000, 1)); // "Receiving files from iPhone..."
    expect(h.sent.length).toBe(before + 1);
    expect(h.sent[h.sent.length - 1].progress.message).toBe("Receiving files from iPhone...");
    expect(h.sent.map((s) => s.progress.message)).toEqual([
      "Starting file transfer...",
      "Receiving files from iPhone...",
    ]);
  });

  it("C5 — the timeline sees every event while the renderer sees at most 62", () => {
    const spy = jest.spyOn(syncTimeline, "recordBytesTransferred");
    const h = harness();
    storm(h);
    expect(spy).toHaveBeenCalledTimes(N);
    expect(spy).toHaveBeenLastCalledWith(N * BYTES_PER_EVENT);
    expect(h.sent.length).toBeLessThanOrEqual(62);
    spy.mockRestore();
  });

  it("C6 — cancel() leaves no held value to land afterwards", () => {
    const h = harness();
    h.emit(transferEvent(1 * GB));
    h.emit(transferEvent(2 * GB)); // held for the interval's end
    const before = h.sent.length;
    h.orchestrator.cancel();
    jest.advanceTimersByTime(5000);
    expect(h.sent.length).toBe(before);
  });

  it("C6 — forceReset() leaves no held value to land afterwards", () => {
    const h = harness();
    h.emit(transferEvent(1 * GB));
    h.emit(transferEvent(2 * GB));
    const before = h.sent.length;
    h.orchestrator.forceReset("reset");
    jest.advanceTimersByTime(5000);
    expect(h.sent.length).toBe(before);
  });
});

describe("BACKLOG-2897: no send after the sync ends (real run, real timers)", () => {
  it("C6 — a backup that fails with a value held sends nothing after the error", async () => {
    mockCheckBackupStatus.mockReset().mockResolvedValue({
      state: "present",
      isComplete: true,
      isInterrupted: false,
      snapshotState: "finished",
      size: { measured: true, bytes: Math.round(57.9 * GB) },
      lastModified: new Date("2026-09-14T12:24:42Z"),
    });
    mockStartBackup.mockReset().mockImplementation(async () => {
      backupServiceInstance!.emit("progress", transferEvent(1 * GB));
      backupServiceInstance!.emit("progress", transferEvent(2 * GB)); // held
      return {
        success: false,
        backupPath: null,
        duration: 1000,
        deviceUdid: UDID,
        backupSize: null,
        isIncremental: true,
        isEncrypted: false,
        deviceReportedBackupMode: null,
        error: "Backup process became unresponsive and was terminated",
        errorCode: "BACKUP_TIMEOUT",
      };
    });

    const orchestrator = new DeviceSyncOrchestrator();
    const events: string[] = [];
    orchestrator.on("progress", (p: SyncProgress) =>
      events.push(`progress:${p.backupProgress?.bytesTransferred ?? "-"}`),
    );
    orchestrator.on("error", () => events.push("error"));
    await orchestrator.sync({ udid: UDID });

    expect(events).toContain("error");
    expect(events).toContain(`progress:${1 * GB}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const afterError = events.slice(events.lastIndexOf("error") + 1);
    expect(afterError).toEqual([]);
  });
});
