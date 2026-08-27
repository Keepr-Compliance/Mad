/**
 * BACKLOG-2925 — a partial backup is not an accurate prior backup.
 *
 * ## The line
 *
 * `deviceSyncOrchestrator.ts` assigned `existingBackupSize = backupStatus.sizeBytes`
 * UNCONDITIONALLY. BACKLOG-2911 made `isInterrupted` available three lines later and
 * used it only for the user-facing message; nothing downstream consulted it. So when
 * the previous run was interrupted:
 *
 *   - the estimate became a PARTIAL'S size — a lower bound by construction
 *   - the headroom dropped to 1.1x, the branch commented "for existing backups
 *     (accurate size)"
 *   - telemetry recorded `source: "existing-backup", reusedPreviousBackup: true` on a
 *     run where reuse is impossible (BACKLOG-2911 established there is no host-side
 *     resume)
 *
 * ## Why this is emergent
 *
 * Each PR was correct alone. BACKLOG-2911 established that an interrupted backup is
 * not reusable; BACKLOG-2899 applies its most permissive headroom to exactly that
 * case; BACKLOG-2898's mark — built to answer "did incremental run?" — records reuse
 * where reuse cannot happen. The defect exists only on the assembled tree.
 *
 * ## BACKLOG-2899's guard manufactures the state it is then weakened by
 *
 * Its mid-transfer abort deliberately leaves the partial on disk. The next run then
 * drops headroom to 1.1x against a number that abort GUARANTEED is too small. The
 * guard makes its own next invocation weaker — which is the case this file pins.
 *
 * ## The gate
 *
 * `isComplete && !isInterrupted`, as the item specifies. Deliberately NOT also
 * `snapshotState === "finished"`: that would demote STATE D (manifest present,
 * Status.plist absent — a real backup predating this device writing one) from a
 * measured size to the `0.25 x used space` estimate BACKLOG-2918 documents as
 * untrustworthy. Ruled on by SR review.
 */

import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";
const GB = 1024 * 1024 * 1024;

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const mockGetStorageInfo = jest.fn();
const logLines: string[] = [];

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn().mockReturnValue("/tmp") },
}));

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

// 10 GB free: comfortably ABOVE SYNC_DISK_RESERVE_BYTES (2 GB), so the up-front
// refusal does not fire and mask the branch under test, and BELOW both candidate
// requirements (50 GB x 1.1 = 55 GB, 50 GB x 1.5 = 75 GB) so the orchestrator's own
// "~N GB recommended" warning fires and REPORTS which headroom branch ran. With the
// 500 GB the other suites use, the check simply passes and the branch is unobservable
// — the assertion would be structurally unable to distinguish pass from fail.
jest.mock("check-disk-space", () =>
  jest.fn().mockResolvedValue({
    diskPath: "C:",
    free: 10 * 1024 * 1024 * 1024,
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
    getDeviceStorageInfo: (...args: unknown[]) => mockGetStorageInfo(...args),
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

const FIFTY_GB = 50 * GB;

/** A complete, uninterrupted prior backup — the normal incremental path. */
const COMPLETE_PRIOR = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: FIFTY_GB },
  lastModified: new Date("2026-08-26T16:11:44Z"),
};

/**
 * The founder's real torn backup: `SnapshotState: "uploading"`, 6.5 GB on disk, and
 * no manifest. Observed 2026-08-26 at 22:22:41 — the run that logged
 * `reusedPreviousBackup=true` while telling him the previous sync did not finish.
 */
const INTERRUPTED_PRIOR = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: 6.5 * GB },
  lastModified: new Date("2026-08-26T22:22:41Z"),
};

/** Torn incremental: the PREVIOUS run's manifest survives, so `isComplete` is true. */
const INTERRUPTED_WITH_STALE_MANIFEST = {
  ...INTERRUPTED_PRIOR,
  isComplete: true,
};

async function runSync(status: unknown) {
  logLines.length = 0;
  mockCheckBackupStatus.mockReset().mockResolvedValue(status);
  if (mockGetStorageInfo.getMockImplementation() === undefined) {
    mockGetStorageInfo.mockResolvedValue({
      totalSpace: 256 * GB,
      usedSpace: 128 * GB,
      freeSpace: 128 * GB,
      estimatedBackupSize: FIFTY_GB,
    });
  }
  mockStartBackup
    .mockReset()
    .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

  const orchestrator = new DeviceSyncOrchestrator();
  const messages: string[] = [];
  orchestrator.on("progress", (p: SyncProgress) => {
    if (p.message) messages.push(p.message);
  });
  orchestrator.on("error", () => {
    /* stopped deliberately at startBackup */
  });
  await orchestrator.sync({ udid: UDID });
  return { messages, lines: [...logLines] };
}

function estimateMark(lines: string[]): string {
  const found = lines.filter((l) => l.includes("mark name=backup-estimate"));
  if (found.length !== 1) throw new Error(`expected one mark, got ${found.length}`);
  return found[0];
}

/** The "~N GB recommended" figure reveals which headroom branch ran. */
function recommendedGB(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(/~([\d.]+) GB recommended/);
    if (m) return m[1];
  }
  return null;
}

describe("BACKLOG-2925: an interrupted prior backup does not take the tight headroom", () => {
  it("CONTROL 1 — an interrupted prior does NOT take the 1.1x branch", async () => {
    const { lines } = await runSync(INTERRUPTED_PRIOR);

    // Pre-fix: estimate 6.5 GB x 1.1 = 7.2 GB required, against a real backup that
    // measured 58.8 GB on the founder's machine.
    // Post-fix: the device-storage estimate, 50 GB x 1.5 = 75.0 GB.
    expect(recommendedGB(lines)).toBe("75.0");
    expect(recommendedGB(lines)).not.toBe("7.2");
  });

  it("the estimate is not the partial's size", async () => {
    const { lines } = await runSync(INTERRUPTED_PRIOR);
    const mark = estimateMark(lines);

    // 50 GB from device storage, not 6.5 GB from the partial.
    expect(mark).toContain(`bytes=${FIFTY_GB}`);
    expect(mark).not.toContain(`bytes=${6.5 * GB}`);
  });

  it("a torn incremental with a STALE manifest is also gated out", async () => {
    // `isComplete` is true here because the previous run's Manifest.db survives, so a
    // gate on `isComplete` alone would let this through. `!isInterrupted` is what
    // catches it — which is why the item specifies BOTH conjuncts.
    const { lines } = await runSync(INTERRUPTED_WITH_STALE_MANIFEST);

    expect(recommendedGB(lines)).toBe("75.0");
    expect(estimateMark(lines)).toContain("reusedPreviousBackup=false");
  });
});

describe("BACKLOG-2925: the instrument must not report reuse where reuse is impossible", () => {
  it("CONTROL 2 — telemetry does NOT claim reusedPreviousBackup on an interrupted run", async () => {
    const { lines } = await runSync(INTERRUPTED_PRIOR);
    const mark = estimateMark(lines);

    // The founder's run logged exactly this lie at 22:22:41.
    expect(mark).toContain("reusedPreviousBackup=false");
    expect(mark).not.toContain("reusedPreviousBackup=true");
    expect(mark).not.toContain("source=existing-backup");
    expect(mark).toContain("source=device-storage");
  });

  it("records the partial's size as IGNORED rather than discarding the fact", async () => {
    const { lines } = await runSync(INTERRUPTED_PRIOR);

    // The bytes are real and worth reading in a timeline; they are simply not a number
    // anything may size a disk guard against.
    expect(estimateMark(lines)).toContain(`ignoredPartialBytes=${6.5 * GB}`);
  });

  it("does not emit ignoredPartialBytes on a healthy run", async () => {
    // Counter-control: a field that appears everywhere carries no information.
    expect(estimateMark((await runSync(COMPLETE_PRIOR)).lines)).not.toContain(
      "ignoredPartialBytes",
    );
  });
});

describe("BACKLOG-2925: the normal path must not be penalised", () => {
  it("CONTROL 3 — a genuinely complete prior backup still takes the tight 1.1x headroom", async () => {
    const { lines } = await runSync(COMPLETE_PRIOR);

    // 50 GB x 1.1 = 55.0 GB. If this regressed, every incremental sync would demand
    // 36% more free space than it needs, and BACKLOG-2918 could not be built at all.
    expect(recommendedGB(lines)).toBe("55.0");
    expect(estimateMark(lines)).toContain("source=existing-backup");
    expect(estimateMark(lines)).toContain("reusedPreviousBackup=true");
  });

  it("STATE D — absent snapshot WITH a manifest is still a measured prior backup", async () => {
    // A real backup from before this device wrote a Status.plist. The stricter gate I
    // considered (`&& snapshotState === "finished"`) would have demoted this to the
    // `0.25 x used space` estimate BACKLOG-2918 calls untrustworthy. SR ruled against
    // it; this test is what would catch the regression if anyone adds it later.
    const { lines } = await runSync({
      ...COMPLETE_PRIOR,
      snapshotState: "absent" as const,
    });

    expect(recommendedGB(lines)).toBe("55.0");
    expect(estimateMark(lines)).toContain("source=existing-backup");
  });
});
