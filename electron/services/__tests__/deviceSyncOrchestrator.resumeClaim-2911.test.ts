/**
 * BACKLOG-2911 — the orchestrator's "Resuming…" claim.
 *
 * On finding an interrupted backup the orchestrator logged "will attempt to resume",
 * told the user `Found interrupted backup (N GB). Resuming...`, and then fell through
 * to a byte-for-byte identical `startBackup` invocation. Nothing resumed. Nothing
 * could: `idevicebackup2` never reads `Status.plist` on the backup path
 * (`mb2_status_check_snapshot_state` is called only from `CMD_RESTORE`), and the only
 * option the mobilebackup2 protocol accepts on a backup request is `ForceFullBackup`.
 * Continuation is device-driven and file-granular; the host has no resume knob.
 *
 * These tests therefore assert two things that survive the fix:
 *
 *  1. The user-facing message never promises a resume the host cannot perform.
 *  2. The interrupted branch never changes the invocation — specifically it never
 *     injects `--full`/`forceFullBackup`. Together with "never delete the partial
 *     directory" (asserted in backupService.interruptedDetection-2911.test.ts), those
 *     are the only two host actions that could destroy device-side continuation.
 *
 * The "assert exact bytes not re-sent" control from the task brief is not expressible
 * here: what the device re-sends is decided device-side from the manifest, and is not
 * observable from the host without a physical iPhone and a 20-minute run.
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

const FIVE_GB = 5 * 1024 * 1024 * 1024;

/**
 * Run one sync to the point where the backup is requested, and report both what the
 * user was told and how `startBackup` was invoked.
 *
 * `startBackup` is stubbed to fail immediately so the run stops at the invocation
 * under test instead of walking the whole parse pipeline.
 */
async function runToBackupInvocation(status: Record<string, unknown>) {
  mockCheckBackupStatus.mockReset().mockResolvedValue(status);
  mockStartBackup
    .mockReset()
    .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

  const orchestrator = new DeviceSyncOrchestrator();
  const messages: string[] = [];
  orchestrator.on("progress", (p: SyncProgress) => {
    if (p.message) messages.push(p.message);
  });

  await orchestrator.sync({ udid: UDID });

  return { messages, invocation: mockStartBackup.mock.calls[0]?.[0] };
}

// BACKLOG-2917: the shape `checkBackupStatus` now returns. `sizeBytes` became a
// three-state `size` reading and the deprecated `isCorrupted` alias is gone (its own
// doc gave PR #2409 + BACKLOG-2910 landing as the removal condition; both are in this
// branch's base).
const interruptedStatus = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  // BACKLOG-2926: `isInterrupted` IS `snapshotState === "unfinished"`. The orchestrator
  // now switches on the snapshot state itself, so a fixture omitting it describes a
  // state `checkBackupStatus` cannot emit — every arm of the union sets it.
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: FIVE_GB },
  lastModified: new Date("2026-08-26T18:05:04Z"),
};

// BACKLOG-2917: `null` used to mean this AND "the check threw". It now means only
// what it says, and the thrown case is a separate state asserted in
// deviceSyncOrchestrator.unknownBasis-2917.test.ts.
const noBackupStatus = { state: "absent" as const };

describe("BACKLOG-2911: the interrupted branch must not promise a resume", () => {
  it("never uses the word 'resume' when it finds an interrupted backup", async () => {
    const { messages } = await runToBackupInvocation(interruptedStatus);

    const interruptedMessage = messages.find((m) => /interrupt|didn't finish|did not finish/i.test(m));
    expect(interruptedMessage).toBeDefined();

    // The defect: `Found interrupted backup (5.0 GB). Resuming...` was shown to the
    // user, and then an identical backup was issued. A decorative reassurance is worse
    // than an honest "starting over".
    for (const message of messages) {
      expect(message).not.toMatch(/resum/i);
    }
  });

  it("tells the user the sync is starting over, and how much is already on disk", async () => {
    const { messages } = await runToBackupInvocation(interruptedStatus);

    expect(messages.some((m) => /starting over/i.test(m))).toBe(true);
    // The partial size is still worth reporting — it is what the disk already holds.
    expect(messages.some((m) => m.includes("5.0 GB"))).toBe(true);
  });
});

describe("BACKLOG-2911: finding an interrupted backup must not change the invocation", () => {
  it("issues the same backup request whether or not the previous run was interrupted", async () => {
    const interrupted = await runToBackupInvocation(interruptedStatus);
    const firstEverSync = await runToBackupInvocation(noBackupStatus);

    // Identical invocation. This is the fact that made "Resuming…" a lie, and it is
    // ALSO the correct behaviour: there is no resume argument to add. The fix is to
    // stop claiming otherwise, not to invent a flag the protocol does not have.
    expect(interrupted.invocation).toEqual(firstEverSync.invocation);
  });

  it("never injects forceFullBackup — that would discard device-side continuation", async () => {
    const { invocation } = await runToBackupInvocation(interruptedStatus);

    // `--full` sets `ForceFullBackup` on the backup request, which makes the device
    // re-send everything. Doing that on an interrupted backup would turn a recoverable
    // situation into a guaranteed full re-transfer.
    expect(invocation).toBeDefined();
    expect(invocation.forceFullBackup).toBeFalsy();
    expect(invocation.udid).toBe(UDID);
  });

  it("passes forceFullBackup through only when the caller asked for it", async () => {
    mockCheckBackupStatus.mockReset().mockResolvedValue(interruptedStatus);
    mockStartBackup
      .mockReset()
      .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

    const orchestrator = new DeviceSyncOrchestrator();
    await orchestrator.sync({ udid: UDID, forceFullBackup: true });

    expect(mockStartBackup.mock.calls[0][0].forceFullBackup).toBe(true);
  });
});

describe("BACKLOG-2911: a torn backup is never silently treated as usable", () => {
  /**
   * REVERSED ON EVIDENCE, 2026-08-28 — and the reversal is recorded rather than the
   * assertion quietly deleted, because the original reasoning was sound on what was
   * known at the time.
   *
   * This case used to forbid "synced N minutes ago" for an interrupted-but-complete
   * backup, on the argument that a surviving `Manifest.db` is STALE and therefore
   * "describes a backup that does not exist". The founder's controlled interruption
   * measured the opposite: the manifest was BYTE-IDENTICAL before and after the cable
   * was pulled (sha `fa9c84e8768334d3…`), the transferred delta was kept (57.57 ->
   * 58.47 GB), the device still reported `IsFullBackup: 0`, and the next run
   * transferred incrementally against that very manifest — growing the folder rather
   * than restarting it. A manifest the interruption never touched is not stale; it is
   * the index the device diffs against, which is exactly why the directory is reusable.
   *
   * What does NOT change, and is still asserted below: the interruption is still
   * reported to the user, and nothing anywhere claims a RESUME. There is still no
   * host-side resume — `idevicebackup2` never reads `Status.plist` on the backup path.
   * The device continuing on its own is a different fact from Keepr resuming, and this
   * file's original finding on that stands untouched.
   */
  it("reports the interruption, keeps the backup, and still promises no resume", async () => {
    const { messages } = await runToBackupInvocation({
      ...interruptedStatus,
      isComplete: true,
    });

    // The interruption is still surfaced — hiding it would be a different lie.
    expect(messages.some((m) => /interrupt|didn't finish|did not finish/i.test(m))).toBe(true);

    // REVERSED: the prior backup is now reused, so it is described. Before the fix the
    // founder was told "Previous sync didn't finish (57.9 GB saved). Starting over..."
    // for a 57.9 GB backup the device went on to continue from.
    expect(messages.some((m) => /synced .* ago/i.test(m))).toBe(true);
    expect(messages.some((m) => /Starting over/i.test(m))).toBe(false);

    // UNCHANGED, and the reason this file exists: no message may claim a resume.
    for (const message of messages) {
      expect(message).not.toMatch(/resum/i);
    }
  });

  it("a torn backup with NO manifest is still treated as unusable", async () => {
    // The other half of the same rule, and the BACKLOG-2925 guard: without an index
    // there is nothing to continue from, so this one really does start over.
    const { messages } = await runToBackupInvocation({
      ...interruptedStatus,
      isComplete: false,
    });

    expect(messages.some((m) => /didn't finish/i.test(m))).toBe(true);
    expect(messages.some((m) => /synced .* ago/i.test(m))).toBe(false);
    for (const message of messages) {
      expect(message).not.toMatch(/resum/i);
    }
  });
});
