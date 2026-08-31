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
 * UPDATED — BACKLOG-2917 HAS LANDED, and this file's own instruction was to update
 * these tests when it did.
 *
 * `checkBackupStatus` no longer returns `{...} | null`. It returns a discriminated
 * union: `absent` (proven ENOENT) | `unknown` (the check threw) | `present`. So
 * `"none"` is now PRODUCIBLE, from `absent` and only from `absent`, and the banner
 * finally has a reachable path — before this, `priorBackup` was only ever `"exists"`
 * or `"unknown"`, so a banner gated on `"none"` rendered in NO state at all.
 *
 * What has NOT changed, and is still asserted below: a check that FAILED is reported
 * as `"unknown"`, never as `"none"`. That was the whole point of refusing to map
 * `null` to `"none"`, and splitting the union preserves it rather than relaxing it.
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
      // BACKLOG-2915: the orchestrator opens a sync scope here; a mock without it
      // throws, which is the wiring being pinned rather than assumed.
      beginSyncScope: jest.fn(),
      attachDeviceDisconnectFeed: jest.fn(),
      noteDeviceDisconnected: jest.fn(),
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

// BACKLOG-2917: the three-state shape `checkBackupStatus` now returns. `sizeBytes`
// became a `size` reading whose unmeasured arm carries no bytes, and the deprecated
// `isCorrupted` alias is gone.
const founderInterruptedStatus = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: SIX_POINT_FIVE_GB },
  lastModified: new Date("2026-08-26T22:22:41Z"),
};

const completePriorBackupStatus = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: 54.7 * 1024 * 1024 * 1024 },
  lastModified: new Date("2026-08-26T16:08:00Z"),
};

/** Proven ENOENT. BACKLOG-2917 makes this distinguishable from a failed check. */
const noBackupStatus = { state: "absent" as const };

/** The check itself failed. Establishes nothing — must never read as "no backup". */
const checkFailedStatus = { state: "unknown" as const, reason: "EACCES" };

/**
 * Run one sync and collect the `priorBackup` value carried by every progress event.
 * `startBackup` is stubbed to fail immediately so the run stops after the prior-backup
 * check rather than walking the whole parse pipeline.
 */
async function collectPriorBackupStates(
  status: Record<string, unknown>,
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

describe("BACKLOG-2907: a USABLE prior backup is reported as `exists`", () => {
  it("BACKLOG-2938 REVERSED THIS — the founder's 6.5 GB interrupted backup reports `none`", async () => {
    const states = await collectPriorBackupStates(founderInterruptedStatus);

    expect(states.length).toBeGreaterThan(1);
    // This assertion used to read `every((s) => s === "exists")`, on the argument that
    // "partial or whole, a prior backup means this is not a first sync". Founder
    // ruling, 2026-08-27: "if the sync isn't useable show the this may take two hours
    // msg." The banner is a warning about a coming wait, not a description of the
    // disk, so an interrupted backup — which cannot be resumed, per BACKLOG-2911 —
    // reports `"none"`. See `deviceSyncOrchestrator.usabilityParity-2938.test.ts`.
    expect(statesAfterCheck(states).every((s) => s === "none")).toBe(true);
  });

  it("reports `exists` for a complete prior backup", async () => {
    const states = await collectPriorBackupStates(completePriorBackupStatus);

    // Unchanged by BACKLOG-2938, and the control that keeps the fix from becoming
    // "always show".
    expect(statesAfterCheck(states).every((s) => s === "exists")).toBe(true);
  });

  it("BACKLOG-2938 REVERSED THIS — an UNUSABLE backup on disk does report `none`", async () => {
    const states = await collectPriorBackupStates(founderInterruptedStatus);

    // Formerly "never reports `none` when a backup is on disk". Existence is no longer
    // the question; usability is.
    expect(statesAfterCheck(states)).not.toContain("exists");
  });
});

describe("BACKLOG-2907: an unestablished answer is reported as `unknown`, never as `none`", () => {
  it("reports `unknown` — NOT `none` — when the CHECK FAILED", async () => {
    const states = await collectPriorBackupStates(checkFailedStatus);

    // Reporting a failed check as "no prior backup" would claim a two-hour first sync
    // every time the check throws — the original defect in a new hat. BACKLOG-2917
    // split this from ENOENT precisely so that uncertainty stays uncertainty while a
    // PROVEN absence becomes usable.
    expect(states.every((s) => s === "unknown")).toBe(true);
    expect(states).not.toContain("none");
  });

  it("reports `none` — the value 2917 makes producible — for a PROVEN absence", async () => {
    // This is the assertion that unblocks the banner. Before BACKLOG-2917 nothing in
    // the orchestrator could produce `"none"`, so `SyncProgress.tsx`'s
    // `isEstablishedFirstSync = priorBackup === "none"` was false in every reachable
    // state and the banner rendered nowhere.
    const states = await collectPriorBackupStates(noBackupStatus);

    expect(statesAfterCheck(states).every((s) => s === "none")).toBe(true);
    expect(states).not.toContain("exists");
  });

  it("reports `unknown` when the check rejects outright", async () => {
    // A rejection is a REAL state, not an invented one: `checkBackupStatus` catches
    // everything inside its `try`, but `validateDeviceUdid` runs BEFORE that block
    // (`backupService.ts:1430`), so a malformed UDID rejects rather than returning
    // null. BACKLOG-2917 deliberately left `validateDeviceUdid` outside the `try`:
    // a malformed UDID is a bad call, not an unknown backup state, and laundering it
    // into a soft value would hide a programming error.
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

    // BACKLOG-2938: the fixture is the COMPLETE backup, not the founder's interrupted
    // one. This test exists to prove run 1's `"exists"` is not carried into run 2, so
    // run 1 has to actually produce `"exists"` — and after 2938 only a usable prior
    // backup does. Using the interrupted fixture here would make run 1 `"none"` and
    // the test would pass without testing anything.
    const firstRun = await collectPriorBackupStates(completePriorBackupStatus, orchestrator);
    expect(statesAfterCheck(firstRun).every((s) => s === "exists")).toBe(true);

    // Same orchestrator instance — this is the case the per-run reset exists for. A
    // stale `"exists"` here would be harmless today (it only ever hides the banner),
    // but once BACKLOG-2917 makes `"none"` producible, a stale value becomes a wrong
    // answer carried across runs.
    // BACKLOG-2917: run 2 finding nothing is now a PROVEN absence, so the correct
    // answer is `"none"` — not `"unknown"`. The comment above anticipated exactly
    // this: a stale `"exists"` was harmless while `"none"` was unproducible, and
    // becomes a wrong answer carried across runs the moment it is not.
    const secondRun = await collectPriorBackupStates(noBackupStatus, orchestrator);
    expect(secondRun).not.toContain("exists");
    expect(statesAfterCheck(secondRun).every((s) => s === "none")).toBe(true);
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
