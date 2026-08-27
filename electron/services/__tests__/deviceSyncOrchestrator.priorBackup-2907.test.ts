/**
 * BACKLOG-2907 — the orchestrator must report the prior-backup state as a FACT.
 *
 * The first-sync banner in `SyncProgress.tsx` had no first-sync condition, so it
 * rendered on every sync that had started transferring bytes. The founder saw it on
 * a run where the backend had already logged `Previous backup did not finish (6.5 GB
 * on disk)`.
 *
 * The signal these tests pin down has THREE states, and the third one is the point.
 * `checkBackupStatus` returns `null` both for "no backup directory" (ENOENT) and for
 * "the check itself threw" (`backupService.ts:1489` — that conflation is BACKLOG-2917).
 * So the orchestrator MUST NOT map `null` to "no prior backup". It maps it to
 * `"unknown"`, and the renderer shows nothing.
 *
 * That means `"none"` is currently unproducible, on purpose. The test below asserts
 * that directly: it is the guard that stops a future edit from "simplifying" the
 * mapping into the two-state guess this item exists to remove. When BACKLOG-2917
 * lands and `null` becomes decomposable, that test is the one that should be updated.
 */

import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn().mockReturnValue("/tmp") },
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
  jest.fn().mockResolvedValue({
    diskPath: "C:",
    free: 500 * 1024 * 1024 * 1024,
    size: 1000 * 1024 * 1024 * 1024,
  }),
);

// Pass the real module through and override only the one call this test drives.
// deviceSyncOrchestrator reads other exports from here at MODULE level (PR #2409
// evaluates `DISK_SPACE_THRESHOLDS.sync` while computing SYNC_DISK_RESERVE_BYTES),
// and a mock that enumerates exports breaks the suite at import time the moment a
// new one is added. Verified against the merged tree.
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

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => {
    const svc = new EventEmitter();
    return Object.assign(svc, {
      checkBackupStatus: mockCheckBackupStatus,
      startBackup: mockStartBackup,
      cancelBackup: jest.fn(),
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
    getConnectedDevices: jest.fn().mockReturnValue([]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalSpace: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      freeSpace: 128 * 1024 * 1024 * 1024,
      estimatedBackupSize: 50 * 1024 * 1024 * 1024,
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

import { DeviceSyncOrchestrator, SyncProgress } from "../deviceSyncOrchestrator";
import type { PriorBackupState } from "../../types/ipc/window-api-platform";

/**
 * The founder's run, transcribed rather than invented.
 *
 * Observed 2026-08-26 at 22:22:41: `Previous backup did not finish (6.5 GB on disk)`
 * with `reusedPreviousBackup=true`. `checkBackupStatus` logs `hasManifest` and
 * `snapshotState` but does not return them; the observed `snapshotState: "unfinished"`
 * is what sets `isInterrupted: true`, and the observed `hasManifest: false` is what
 * makes `isComplete` false. Those two return fields are the transcription of those
 * two log fields.
 */
const SIX_POINT_FIVE_GB = 6.5 * 1024 * 1024 * 1024;

const founderInterruptedStatus = {
  exists: true,
  isComplete: false,
  isInterrupted: true,
  isCorrupted: true,
  sizeBytes: SIX_POINT_FIVE_GB,
  lastModified: new Date("2026-08-26T22:22:41Z"),
};

const completePriorBackupStatus = {
  exists: true,
  isComplete: true,
  isInterrupted: false,
  isCorrupted: false,
  sizeBytes: 54.7 * 1024 * 1024 * 1024,
  lastModified: new Date("2026-08-26T16:08:00Z"),
};

/**
 * Run one sync and collect the `priorBackup` value carried by every progress event.
 * `startBackup` is stubbed to fail immediately so the run stops after the prior-backup
 * check rather than walking the whole parse pipeline.
 */
async function collectPriorBackupStates(
  status: Record<string, unknown> | null,
  orchestrator = new DeviceSyncOrchestrator(),
): Promise<Array<PriorBackupState | undefined>> {
  mockCheckBackupStatus.mockReset().mockResolvedValue(status);
  mockStartBackup
    .mockReset()
    .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

  const states: Array<PriorBackupState | undefined> = [];
  orchestrator.on("progress", (p: SyncProgress) => states.push(p.priorBackup));

  await orchestrator.sync({ udid: UDID });
  return states;
}

/**
 * The states emitted AFTER the check has run — i.e. every event that could reach a
 * banner. Events emitted before the check necessarily carry `"unknown"`.
 */
function statesAfterCheck(states: Array<PriorBackupState | undefined>) {
  return states.slice(1);
}

describe("BACKLOG-2907: a prior backup on disk is reported as `exists`", () => {
  it("reports `exists` for the founder's 6.5 GB interrupted backup", async () => {
    const states = await collectPriorBackupStates(founderInterruptedStatus);

    expect(states.length).toBeGreaterThan(1);
    // Partial or whole, a prior backup means this is not a first sync. The
    // partial/complete conflation (BACKLOG-2925) is real but does not change THIS
    // answer, which is why this item did not have to wait for 2925.
    expect(statesAfterCheck(states).every((s) => s === "exists")).toBe(true);
  });

  it("reports `exists` for a complete prior backup", async () => {
    const states = await collectPriorBackupStates(completePriorBackupStatus);

    expect(statesAfterCheck(states).every((s) => s === "exists")).toBe(true);
  });

  it("never reports `none` when a backup is on disk", async () => {
    const states = await collectPriorBackupStates(founderInterruptedStatus);

    expect(states).not.toContain("none");
  });
});

describe("BACKLOG-2907: an unestablished answer is reported as `unknown`, never as `none`", () => {
  it("reports `unknown` — NOT `none` — when the check returns null", async () => {
    const states = await collectPriorBackupStates(null);

    // `null` is ENOENT *or* a thrown check. Reporting it as "no prior backup" would
    // claim a two-hour first sync every time the check throws, which is the original
    // defect in a new hat. Until BACKLOG-2917 splits those two cases, uncertainty is
    // reported as uncertainty.
    expect(states.every((s) => s === "unknown")).toBe(true);
    expect(states).not.toContain("none");
  });

  it("reports `unknown` when the check rejects outright", async () => {
    // A rejection is a REAL state, not an invented one: `checkBackupStatus` catches
    // everything inside its `try`, but `validateDeviceUdid` runs BEFORE that block
    // (`backupService.ts:1430`), so a malformed UDID rejects rather than returning
    // null. Note this is the one failure mode 2917 does NOT collapse — every other
    // throw has already been converted to `null` by the time we see it, which is
    // exactly why the `null` case above cannot be read as "no prior backup".
    mockCheckBackupStatus.mockReset().mockRejectedValue(new Error("Invalid device UDID"));
    mockStartBackup
      .mockReset()
      .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

    const orchestrator = new DeviceSyncOrchestrator();
    const states: Array<PriorBackupState | undefined> = [];
    orchestrator.on("progress", (p: SyncProgress) => states.push(p.priorBackup));
    // The run fails. EventEmitter rethrows an unheard "error" event, so this listener
    // is what keeps the assertion below reachable.
    orchestrator.on("error", () => {});

    await orchestrator.sync({ udid: UDID });

    expect(states.length).toBeGreaterThan(0);
    expect(states).not.toContain("none");
    expect(states).not.toContain("exists");
  });
});

describe("BACKLOG-2907: each run establishes its own answer", () => {
  it("does not carry run 1's `exists` into run 2 when run 2 finds nothing", async () => {
    const orchestrator = new DeviceSyncOrchestrator();

    const firstRun = await collectPriorBackupStates(founderInterruptedStatus, orchestrator);
    expect(statesAfterCheck(firstRun).every((s) => s === "exists")).toBe(true);

    // Same orchestrator instance — this is the case the per-run reset exists for. A
    // stale `"exists"` here would be harmless today (it only ever hides the banner),
    // but once BACKLOG-2917 makes `"none"` producible, a stale value becomes a wrong
    // answer carried across runs.
    const secondRun = await collectPriorBackupStates(null, orchestrator);
    expect(secondRun).not.toContain("exists");
  });
});

describe("BACKLOG-2907: every progress event carries the signal", () => {
  it("attaches priorBackup to progress events centrally, not per call site", async () => {
    const states = await collectPriorBackupStates(founderInterruptedStatus);

    // Attached in `emitProgress`, so no emit can omit it. An `undefined` here would
    // mean some call site bypassed the attach point.
    expect(states.every((s) => s !== undefined)).toBe(true);
  });
});
