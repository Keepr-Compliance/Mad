/**
 * BACKLOG-2917 — the orchestrator must not turn "we don't know" into "first sync".
 *
 * ## The defect these tests pin
 *
 * `deviceSyncOrchestrator` held `let existingBackupSize = 0` and keyed four decisions
 * off `existingBackupSize > 0`:
 *
 *   :554  which estimate is used
 *   :566  the `backup-estimate` mark's `source`
 *   :568  `reusedPreviousBackup`
 *   :582  the headroom multiplier
 *
 * `0` meant BOTH "there is no previous backup" and "we could not find out", because
 * `checkBackupStatus` returned `null` for both. So a check that THREW produced a
 * confident first-sync estimate and a telemetry mark stating `reusedPreviousBackup:
 * false` as a measured fact. BACKLOG-2917's own table calls that out: the state
 * "check threw / size walk failed" was reported as "no prior backup" and must report
 * `source: "unknown"`.
 *
 * ## Why both the mark AND the multiplier are asserted
 *
 * The item's control text says "the headroom branch is not taken on an unknown". The
 * fix keeps 1.5x for an unknown basis — the same NUMBER as the first-sync branch,
 * because both estimate from device storage, which is what 1.5x is sized for. So a
 * test asserting only the multiplier could not tell the two branches apart, and a
 * test asserting only the mark would not notice if 1.1x were applied to an unknown.
 * Both are asserted, and the multiplier is observed through the orchestrator's own
 * "~N GB recommended" warning rather than by reading a variable.
 *
 * ## Fixtures
 *
 * The `checkBackupStatus` return values below are the real three-state shape from
 * `electron/types/backup.ts`, not a test-local invention. Device storage figures
 * mirror the existing orchestrator suites.
 */

import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";

const GB = 1024 * 1024 * 1024;
/** What `getDeviceStorageInfo` reports below. Drives the device-storage estimate. */
const DEVICE_STORAGE_ESTIMATE = 50 * GB;
/**
 * Free space chosen so BOTH headroom branches warn, and the warning's "~N GB
 * recommended" therefore reports which multiplier ran:
 *   1.1 x 50 GB = 55.0 GB      1.5 x 50 GB = 75.0 GB
 * It is above SYNC_DISK_RESERVE_BYTES (2 GB) so the up-front refusal does not fire
 * first and mask the branch under test.
 */
const FREE_SPACE = 10 * GB;

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const logLines: string[] = [];

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn().mockReturnValue("/tmp") },
}));

// The timeline's default sink is `log.info`, so capturing info gives us the marks.
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
  jest.fn().mockImplementation(async () => ({
    diskPath: "C:",
    free: 10 * 1024 * 1024 * 1024,
    size: 1000 * 1024 * 1024 * 1024,
  })),
);

// Pass the real module through and override only the one call this test drives.
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

const mockGetDeviceStorageInfo = jest.fn();

jest.mock("../deviceDetectionService", () => {
  const svc = new EventEmitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([]),
    getDeviceStorageInfo: (...args: unknown[]) => mockGetDeviceStorageInfo(...args),
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

/** The three-state shapes `checkBackupStatus` now returns. */
const ABSENT = { state: "absent" as const };
const UNKNOWN = { state: "unknown" as const, reason: "EACCES" };
const MEASURED_COMPLETE = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: DEVICE_STORAGE_ESTIMATE },
  lastModified: new Date("2026-08-26T16:11:44Z"),
};
/** Present on disk, but the size walk threw — BACKLOG-2917's second collapse. */
const PRESENT_SIZE_UNMEASURED = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: false as const, reason: "EACCES" },
  lastModified: new Date("2026-08-26T16:11:44Z"),
};

async function runSync(status: unknown, opts: { storageInfo?: unknown } = {}) {
  logLines.length = 0;
  mockCheckBackupStatus.mockReset().mockResolvedValue(status);
  mockGetDeviceStorageInfo.mockReset().mockResolvedValue(
    "storageInfo" in opts
      ? opts.storageInfo
      : {
          totalSpace: 256 * GB,
          usedSpace: 128 * GB,
          freeSpace: 128 * GB,
          estimatedBackupSize: DEVICE_STORAGE_ESTIMATE,
        },
  );
  mockStartBackup
    .mockReset()
    .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

  const orchestrator = new DeviceSyncOrchestrator();
  const messages: string[] = [];
  orchestrator.on("progress", (p: SyncProgress) => {
    if (p.message) messages.push(p.message);
  });
  orchestrator.on("error", () => {
    /* swallow: the run is stopped deliberately at startBackup */
  });

  await orchestrator.sync({ udid: UDID });

  return { messages, lines: [...logLines] };
}

/** The one `backup-estimate` mark emitted by a run. */
function estimateMark(lines: string[]): string {
  const found = lines.filter((l) => l.includes("mark name=backup-estimate"));
  if (found.length !== 1) {
    throw new Error(`expected exactly one backup-estimate mark, got ${found.length}`);
  }
  return found[0];
}

/** The "~N GB recommended" figure, which reveals which headroom branch ran. */
function recommendedGB(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(/~([\d.]+) GB recommended/);
    if (m) return m[1];
  }
  return null;
}

describe("BACKLOG-2917: the estimate mark reports three states, not two", () => {
  it("a THROWN check reports source=unknown — not the reassuring 'device-storage'", async () => {
    const { lines } = await runSync(UNKNOWN);

    const mark = estimateMark(lines);
    expect(mark).toContain("source=unknown");
    expect(mark).toContain("reusedPreviousBackup=false");
    // The defect: this run was indistinguishable from a genuine first sync.
    expect(mark).not.toContain("source=device-storage");
    expect(mark).not.toContain("source=existing-backup");
  });

  it("a PROVEN absent backup still reports source=device-storage", async () => {
    const { lines } = await runSync(ABSENT);

    const mark = estimateMark(lines);
    expect(mark).toContain("source=device-storage");
    expect(mark).toContain("reusedPreviousBackup=false");
    expect(mark).not.toContain("source=unknown");
  });

  it("a measured prior backup still reports source=existing-backup", async () => {
    const { lines } = await runSync(MEASURED_COMPLETE);

    const mark = estimateMark(lines);
    expect(mark).toContain("source=existing-backup");
    expect(mark).toContain("reusedPreviousBackup=true");
  });

  it("the three sources are mutually distinct — the instrument can separate all three", async () => {
    const unknown = estimateMark((await runSync(UNKNOWN)).lines);
    const absent = estimateMark((await runSync(ABSENT)).lines);
    const measured = estimateMark((await runSync(MEASURED_COMPLETE)).lines);

    const sourceOf = (line: string) => line.match(/source=(\S+)/)?.[1];
    const sources = [sourceOf(unknown), sourceOf(absent), sourceOf(measured)];
    expect(new Set(sources).size).toBe(3);
  });

  it("a backup that EXISTS but could not be measured is unknown, not a first sync", async () => {
    // The size-walk half of BACKLOG-2917, seen from the orchestrator. The directory
    // is there; only its size is unavailable. Reporting device-storage here would be
    // the same lie as reporting it for a thrown check.
    const { lines } = await runSync(PRESENT_SIZE_UNMEASURED);

    const mark = estimateMark(lines);
    expect(mark).toContain("source=unknown");
    expect(mark).toContain("reusedPreviousBackup=false");
  });
});

describe("BACKLOG-2917: the headroom branch is not taken on an unknown", () => {
  it("an unknown basis uses 1.5x (75.0 GB), NOT the 1.1x existing-backup branch (55.0 GB)", async () => {
    const { lines } = await runSync(UNKNOWN);

    // 1.1x is justified by "this number is a prior backup's MEASURED size on disk".
    // With an unknown basis that justification does not exist.
    expect(recommendedGB(lines)).toBe("75.0");
    expect(recommendedGB(lines)).not.toBe("55.0");
  });

  it("a measured prior backup still gets the tight 1.1x branch — the fix must not penalise the normal path", async () => {
    const { lines } = await runSync(MEASURED_COMPLETE);
    expect(recommendedGB(lines)).toBe("55.0");
  });

  it("a proven first sync gets 1.5x, same as unknown — which is why the MARK is the discriminator", async () => {
    const { lines } = await runSync(ABSENT);
    expect(recommendedGB(lines)).toBe("75.0");
  });
});

describe("BACKLOG-2917: the user is never told 'first sync' on a guess", () => {
  it("does not announce a first sync when the check failed", async () => {
    const { messages } = await runSync(UNKNOWN);

    for (const message of messages) {
      expect(message).not.toMatch(/first sync/i);
    }
  });

  it("still announces a first sync when one is genuinely established", async () => {
    // The counter-control: suppressing the message everywhere would pass the test
    // above while removing a true and useful thing the app says.
    const { messages } = await runSync(ABSENT);
    expect(messages.some((m) => /first sync/i.test(m))).toBe(true);
  });
});

describe("BACKLOG-2917: device storage being unavailable is its own state", () => {
  it("emits a mark with its own source instead of emitting nothing at all", async () => {
    // This branch previously emitted NO mark, so every sync taking it was invisible
    // in the aggregate BACKLOG-2894 is being built on — an absence that reads as
    // "never happens" rather than "not recorded".
    const { lines } = await runSync(ABSENT, { storageInfo: null });

    const mark = estimateMark(lines);
    expect(mark).toContain("source=device-storage-unavailable");
    // Two independent unknowns must not share one label: device storage being
    // unreadable says nothing about whether a prior backup exists.
    expect(mark).not.toContain("source=unknown");
    expect(mark).toContain("priorBackup=none");
  });

  it("carries the prior-backup basis separately, so the two unknowns stay separable", async () => {
    const { lines } = await runSync(UNKNOWN, { storageInfo: null });

    const mark = estimateMark(lines);
    expect(mark).toContain("source=device-storage-unavailable");
    expect(mark).toContain("priorBackup=unknown");
  });
});

/**
 * Drive a run where `startBackup` SUCCEEDS, so `syncTimeline.annotate("backup", ...)`
 * is actually reached. Every other test here stops the run at `startBackup` and
 * therefore cannot observe this line at all — which is exactly how the `:590`
 * downstream site came to be fixed with nothing able to see a regression.
 */
async function runSyncWithCompletedBackup(backupSize: number | null) {
  logLines.length = 0;
  mockCheckBackupStatus.mockReset().mockResolvedValue(ABSENT);
  mockGetDeviceStorageInfo.mockReset().mockResolvedValue({
    totalSpace: 256 * GB,
    usedSpace: 128 * GB,
    freeSpace: 128 * GB,
    estimatedBackupSize: DEVICE_STORAGE_ESTIMATE,
  });
  mockStartBackup.mockReset().mockResolvedValue({
    success: true,
    backupPath: "/tmp/keepr-2917-does-not-exist",
    error: null,
    duration: 1_464_030,
    deviceUdid: UDID,
    isIncremental: true,
    // BACKLOG-2917: `null` means the walk failed, NOT that nothing transferred.
    backupSize,
    isEncrypted: false,
  });

  const orchestrator = new DeviceSyncOrchestrator();
  orchestrator.on("error", () => {
    /* the run fails later at parsing; the annotate under test already happened */
  });
  await orchestrator.sync({ udid: UDID });
  return [...logLines];
}

describe("BACKLOG-2917: a completed backup is never annotated as zero bytes", () => {
  it("omits `bytes` and says so when the size walk failed on a SUCCESSFUL backup", async () => {
    // The founder's real run measured 58,761,372,853 bytes. If its size walk had
    // thrown, the timeline used to record `bytes=0` for it — and BACKLOG-2894 will
    // aggregate over exactly this field.
    const lines = await runSyncWithCompletedBackup(null);

    const phaseEnd = lines.find((l) => l.includes("phase-end phase=backup"));
    expect(phaseEnd).toBeDefined();
    expect(phaseEnd).toContain("bytesUnmeasured=true");
    // The defect, stated as the assertion that would have caught it.
    expect(phaseEnd).not.toContain("bytes=0");
    expect(phaseEnd).not.toMatch(/\bbytes=/);
  });

  it("records the real byte count when the walk succeeded — the counter-control", async () => {
    const lines = await runSyncWithCompletedBackup(58_761_372_853);

    const phaseEnd = lines.find((l) => l.includes("phase-end phase=backup"));
    expect(phaseEnd).toBeDefined();
    expect(phaseEnd).toContain("bytes=58761372853");
    expect(phaseEnd).not.toContain("bytesUnmeasured");
  });
});

describe("BACKLOG-2917: processExistingBackup separates 'none' from 'could not tell'", () => {
  it("does not claim 'No existing backup found' when the check itself failed", async () => {
    mockCheckBackupStatus.mockReset().mockResolvedValue(UNKNOWN);
    const orchestrator = new DeviceSyncOrchestrator();

    const result = await orchestrator.processExistingBackup({ udid: UDID });

    expect(result.success).toBe(false);
    // Telling a user their backup is missing, when in fact we failed to look, sends
    // them hunting for data that is probably still on disk.
    expect(result.error).not.toBe("No existing backup found for this device");
    expect(result.error).toMatch(/could not read/i);
  });

  it("still says 'No existing backup found' when the backup is genuinely absent", async () => {
    mockCheckBackupStatus.mockReset().mockResolvedValue(ABSENT);
    const orchestrator = new DeviceSyncOrchestrator();

    const result = await orchestrator.processExistingBackup({ udid: UDID });

    expect(result.success).toBe(false);
    expect(result.error).toBe("No existing backup found for this device");
  });
});
