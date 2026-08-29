/**
 * BACKLOG-2914 (built as FIX 4 of BACKLOG-2911) — THE OUTCOME ROW, AS THE ORCHESTRATOR
 * ACTUALLY FILLS IT IN.
 *
 * `syncTimeline.outcomeRow-2914.test.ts` pins the row's SHAPE against the timeline
 * directly. This file pins the WIRING: that the orchestrator puts the right values in
 * it on a real run, through the real code path.
 *
 * Two dimensions get their own controls here, because both were measured wrong on the
 * founder's machine on 2026-08-28 and both would corrupt the primary axis of the model:
 *
 *   `incremental`   logged `true` for a 61.2 GB / 52-minute transfer whose
 *                   `Status.plist` said `IsFullBackup: 1`. The flag came from whether a
 *                   directory existed. First-sync and incremental are the two
 *                   distributions the model must separate, and a 52-minute full run
 *                   filed as incremental teaches it that incremental syncs take an hour.
 *
 *   `priorBackup`   the recorded first-sync flag. BACKLOG-2894's control is that
 *                   flipping `isUsablePriorBackup` must change it — which is why it is
 *                   RECORDED at the point of decision rather than inferred later from
 *                   something that happens to correlate.
 *
 * Fixtures are the founder's two real on-disk states, the same ones
 * `deviceSyncOrchestrator.interruptedIsUsable-2911.test.ts` uses.
 */

import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * The founder's measured prior backup, 57.9 GB. Deliberately NOT a round number and
 * deliberately far from the device-storage guess below, so an assertion on `bytes`
 * cannot pass by coincidence.
 */
const MEASURED_PRIOR_BACKUP_BYTES = Math.round(57.9 * GB);

/**
 * The number Keepr actually printed on 2026-08-28: "Estimated backup size: 11547 MB
 * (25% of used space)". Wired in as the device-storage answer so the WRONG number is
 * reachable — a fixture where both paths give the same figure could not tell them
 * apart. This is the 2918 half of the item.
 */
const DEVICE_STORAGE_GUESS_BYTES = 11_547 * MB;

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn().mockReturnValue("/tmp") },
}));

const logLines: string[] = [];

jest.mock("electron-log", () => ({
  info: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  },
  warn: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  },
  error: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  },
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

/**
 * The service instance the orchestrator constructs, captured so a test can make it
 * emit `waiting-for-passcode` / `passcode-entered` — the two events the wait phase is
 * cut on. Without driving the real events this file would assert the phase split
 * against nothing, which is how a wiring test comes to prove only that a constant
 * exists.
 */
let backupServiceInstance: EventEmitter | null = null;

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => {
    const svc = new EventEmitter();
    backupServiceInstance = svc;
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
    // A connected device with a NAME, deliberately. The PII control below asserts the
    // name does not reach the row, and it can only assert that if a name was available
    // to leak. "Daniel's iPhone" is a placeholder — the founder's real device name is a
    // personal nickname and does not belong in a public repo.
    getConnectedDevices: jest.fn().mockReturnValue([
      {
        udid: UDID,
        name: "Daniel's iPhone",
        productType: "iPhone14,2",
        productVersion: "17.6.1",
        serialNumber: "F2LX00000000",
        isConnected: true,
      },
    ]),
    // The REAL `DeviceStorageInfo` field names — `totalCapacity` / `availableSpace`,
    // not `totalSpace` / `freeSpace`. The first draft of this mock used the latter,
    // copied from a sibling suite where only `estimatedBackupSize` is read, and the
    // outcome row came out saying `deviceCapacityBytes=undefined`. A fixture whose
    // shape its producer cannot emit is how a green test proves nothing.
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      availableSpace: 128 * 1024 * 1024 * 1024,
      // 11,547 MB — the exact wrong number from the 2026-08-28 run.
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

import { DeviceSyncOrchestrator, SyncProgress } from "../deviceSyncOrchestrator";
import type { PriorBackupState } from "../../types/ipc/window-api-platform";

// ---------------------------------------------------------------------------
// Fixtures — the founder's two real on-disk states, three days apart
// ---------------------------------------------------------------------------

/** 2026-08-28, after the deliberate interruption. Manifest intact -> usable. */
const INTERRUPTED_MANIFEST_INTACT = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: Math.round(57.9 * GB) },
  lastModified: new Date("2026-08-28T12:24:42Z"),
};

/** 2026-08-27. `BackupState: empty`, `SnapshotState: uploading`, no manifest. */
const MANIFEST_MISSING = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: 6_343_173 },
  lastModified: new Date("2026-08-27T09:07:11Z"),
};

/** Proven ENOENT: no prior backup at all. */
const ABSENT = { state: "absent" as const };

/** The check itself failed. Establishes nothing. */
const CHECK_FAILED = { state: "unknown" as const, reason: "EACCES" };

interface BackupOutcome {
  /** What the device said, or `null` when it never said. */
  deviceReportedBackupMode?: "incremental" | "full" | null;
  isIncremental?: boolean;
  isEncrypted?: boolean;
}

/**
 * Runs a sync to the point where the backup returns, then reads the ONE outcome row.
 * The backup is failed deliberately so the run terminates through `errorResult`, which
 * is itself a `endSync` path — and the dimensions under test are recorded BEFORE that
 * return, which is the property the failure fixtures here depend on.
 */
async function outcomeRowFor(status: unknown, backup: BackupOutcome = {}): Promise<string> {
  logLines.length = 0;
  mockCheckBackupStatus.mockReset().mockResolvedValue(status);
  mockStartBackup.mockReset().mockResolvedValue({
    success: false,
    backupPath: null,
    error: "stopped by test",
    duration: 1000,
    deviceUdid: UDID,
    backupSize: 61_217_118_530,
    isIncremental: backup.isIncremental ?? true,
    isEncrypted: backup.isEncrypted ?? false,
    deviceReportedBackupMode: backup.deviceReportedBackupMode ?? null,
  });

  const orchestrator = new DeviceSyncOrchestrator();
  orchestrator.on("error", () => {});
  await orchestrator.sync({ udid: UDID });

  const rows = logLines.filter((l) => l.includes("sync-outcome"));
  if (rows.length !== 1) throw new Error(`expected one outcome row, got ${rows.length}`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// CONTROL (d) — the device's answer beats the inference
// ---------------------------------------------------------------------------

describe("BACKLOG-2914: `incremental` comes from the device, not from a directory", () => {
  it("THE CONTROL — a prior backup exists but the DEVICE says full: the row says full", async () => {
    // The founder's 09:07 run, in one assertion. A 4.4 GB partial was on disk, so the
    // old derivation said "incremental". `Status.plist` said `IsFullBackup: 1` and
    // idevicebackup2 printed "Full backup mode." — and 61.2 GB then moved in 52 minutes.
    const row = await outcomeRowFor(INTERRUPTED_MANIFEST_INTACT, {
      deviceReportedBackupMode: "full",
      isIncremental: false,
    });

    expect(row).toContain("incremental=false");
    expect(row).toContain("backupModeSource=device-reported");
  });

  it("the device saying INCREMENTAL is recorded as reported, not inferred", async () => {
    const row = await outcomeRowFor(INTERRUPTED_MANIFEST_INTACT, {
      deviceReportedBackupMode: "incremental",
      isIncremental: true,
    });

    expect(row).toContain("incremental=true");
    expect(row).toContain("backupModeSource=device-reported");
  });

  it("when the device never said, the row admits the flag was INFERRED", async () => {
    // A run that dies before idevicebackup2 prints its mode line still has to answer.
    // It answers with the old derivation and says so, rather than presenting a guess
    // and a measurement as the same kind of fact.
    const row = await outcomeRowFor(INTERRUPTED_MANIFEST_INTACT, {
      deviceReportedBackupMode: null,
    });

    expect(row).toContain("backupModeSource=inferred");
  });
});

// ---------------------------------------------------------------------------
// CONTROL (e) — the first-sync flag follows the predicate
// ---------------------------------------------------------------------------

describe("BACKLOG-2914: the first-sync flag is recorded from `isUsablePriorBackup`", () => {
  it("THE CONTROL — the interrupted-but-complete backup records `exists`", async () => {
    // Flip `isUsablePriorBackup` back to `&& !isInterrupted` and this reds. That is
    // BACKLOG-2894's stated control, and it is the reason the flag is recorded at the
    // point of decision instead of inferred afterwards from something correlated.
    const row = await outcomeRowFor(INTERRUPTED_MANIFEST_INTACT);

    expect(row).toContain("priorBackup=exists");
  });

  it("no manifest records `none` — a full transfer is coming", async () => {
    const row = await outcomeRowFor(MANIFEST_MISSING);

    expect(row).toContain("priorBackup=none");
  });

  it("a proven ENOENT records `none`", async () => {
    const row = await outcomeRowFor(ABSENT);

    expect(row).toContain("priorBackup=none");
  });

  it("a FAILED CHECK records `unknown` — never collapsed to true or false", async () => {
    // Two states, not three, is the BACKLOG-2917 defect, and here it would poison the
    // very split this field exists to make: a failed check counted as "first sync"
    // would drag first-sync durations toward the incremental distribution.
    const row = await outcomeRowFor(CHECK_FAILED);

    expect(row).toContain("priorBackup=unknown");
  });
});

// ---------------------------------------------------------------------------
// The environment, and what must never be in it
// ---------------------------------------------------------------------------

describe("BACKLOG-2914: the row carries the environment and no identifiers", () => {
  it("records the host, and the device model and iOS version", async () => {
    const row = await outcomeRowFor(INTERRUPTED_MANIFEST_INTACT);

    expect(row).toContain("source=iphone-backup");
    expect(row).toMatch(/hostOsRelease=\S+/);
    expect(row).toMatch(/hostTotalMemBytes=\d+/);
    expect(row).toMatch(/deviceUsedBytes=\d+/);
    expect(row).toMatch(/deviceCapacityBytes=\d+/);
    expect(row).toContain("deviceModel=iPhone14,2");
    expect(row).toContain("deviceIosVersion=17.6.1");
  });

  it("a value that was NOT established is absent, never the string \"undefined\"", async () => {
    // How this case came to exist: the first draft of this file's device-storage mock
    // used `totalSpace`/`freeSpace` where the real `DeviceStorageInfo` has
    // `totalCapacity`/`availableSpace`, and the row came out reading
    // `deviceCapacityBytes=undefined`. Parsed back out, that is indistinguishable from
    // a capacity of zero. `setContext` now drops non-finite values at the boundary, so
    // no producer can put one in the row.
    const row = await outcomeRowFor(INTERRUPTED_MANIFEST_INTACT);

    expect(row).not.toContain("undefined");
    expect(row).not.toContain("NaN");
    expect(row).not.toContain("null");
  });

  it("PII — no UDID, no serial, no device name", async () => {
    // The repo is public and this row goes to a support log. The founder's device name
    // is a personal nickname; `productType` ("iPhone14,2") is a model identifier and is
    // the thing worth aggregating on.
    const row = await outcomeRowFor(INTERRUPTED_MANIFEST_INTACT);

    expect(row).not.toContain(UDID);
    expect(row).not.toContain("Daniel's iPhone");
    expect(row).not.toContain("F2LX00000000");
    expect(row).not.toMatch(/deviceName=/);
    expect(row).not.toMatch(/serial/i);
    expect(row).not.toMatch(/udid/i);
  });
});

// ---------------------------------------------------------------------------
// CONTROL (f) — the wait phase, driven through the real events
// ---------------------------------------------------------------------------

describe("BACKLOG-2914: the orchestrator cuts the wait out of the backup phase", () => {
  it("THE CONTROL — the device's silence becomes `backup:waiting-for-device`", async () => {
    // The founder's shape: the backup is requested, nothing transfers, the backup
    // service emits `waiting-for-passcode` at five seconds, and 903.9 s later the first
    // file arrives and `passcode-entered` fires. Those two events are the phase
    // boundaries. Remove either `enterBackupPhase` call and this reds.
    logLines.length = 0;
    mockCheckBackupStatus.mockReset().mockResolvedValue(INTERRUPTED_MANIFEST_INTACT);
    mockStartBackup.mockReset().mockImplementation(async () => {
      backupServiceInstance?.emit("waiting-for-passcode");
      backupServiceInstance?.emit("passcode-entered");
      return { success: false, backupPath: null, error: "stopped by test" };
    });

    const orchestrator = new DeviceSyncOrchestrator();
    orchestrator.on("error", () => {});
    await orchestrator.sync({ udid: UDID });

    const row = logLines.filter((l) => l.includes("sync-outcome"))[0];
    expect(row).toContain("backup:waiting-for-device:");
    expect(row).toContain("backup:transferring:");
  });

  it("a run that never waited records ONE backup phase, not a zero-length wait", async () => {
    // Both events are gated on `hasEmittedPasscodeWaiting` in the backup service, so a
    // transfer starting inside five seconds emits neither. Recording a zero-length wait
    // would be inventing an event that did not happen.
    logLines.length = 0;
    mockCheckBackupStatus.mockReset().mockResolvedValue(INTERRUPTED_MANIFEST_INTACT);
    mockStartBackup
      .mockReset()
      .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

    const orchestrator = new DeviceSyncOrchestrator();
    orchestrator.on("error", () => {});
    await orchestrator.sync({ udid: UDID });

    const row = logLines.filter((l) => l.includes("sync-outcome"))[0];
    expect(row).not.toContain("backup:waiting-for-device");
    expect(row).toContain("phases=backup:");
  });

  it("the backup's bytes follow the phase — they are not annotated onto a closed record", async () => {
    // `annotate` matches on the phase NAME and returns quietly when it matches nothing.
    // Once the sub-phases open, annotating "backup" would attach the bytes to a record
    // that closed at the start of the wait — silently.
    logLines.length = 0;
    mockCheckBackupStatus.mockReset().mockResolvedValue(INTERRUPTED_MANIFEST_INTACT);
    mockStartBackup.mockReset().mockImplementation(async () => {
      backupServiceInstance?.emit("waiting-for-passcode");
      backupServiceInstance?.emit("passcode-entered");
      return {
        success: true,
        backupPath: "/mock/backup",
        error: null,
        duration: 1000,
        deviceUdid: UDID,
        backupSize: 61_217_118_530,
        isIncremental: true,
        isEncrypted: false,
        deviceReportedBackupMode: "incremental" as const,
      };
    });

    const orchestrator = new DeviceSyncOrchestrator();
    orchestrator.on("error", () => {});
    await orchestrator.sync({ udid: UDID });

    const phaseEnd = logLines.find(
      (l) => l.includes("phase-end phase=backup:transferring"),
    );
    expect(phaseEnd).toBeDefined();
    expect(phaseEnd).toContain("bytes=61217118530");
  });
});
