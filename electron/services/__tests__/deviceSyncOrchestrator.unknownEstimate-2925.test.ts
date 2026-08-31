/**
 * BACKLOG-2925, second pass — an estimate the app could not determine is not a size,
 * and must not be spent as one.
 *
 * ## What the founder saw, 2026-08-27, on int/sync-observability
 *
 * The first pass of this item worked: the disk guard REFUSED to size itself from a
 * 19.4 GB interrupted partial. Then the fallback returned nothing, and the guard spent
 * the nothing:
 *
 *     [DeviceDetection] Storage info: {"totalCapacity":0,"availableSpace":0,
 *                                      "usedSpace":0,"estimatedBackupSize":0}
 *     [DeviceSyncOrchestrator] Estimated backup size from storage: 0 MB (used space: 0 GB)
 *     [DeviceSyncOrchestrator] Disk space: 15 GB free on /
 *     [DeviceSyncOrchestrator] Disk space check passed: 15 GB available
 *
 * `0 x 1.5 = 0`, and 15 GB clears 0, so the guard did not merely fail to refuse — it
 * REPORTED SUCCESS, for a backup that had measured 58.8 GB on that machine. He was
 * told to cancel, and did.
 *
 * ## The shape, third time
 *
 * BACKLOG-2899: the guard warned and proceeded. BACKLOG-2925 first pass: the guard was
 * sized from a partial, a lower bound by construction. Now: sized from nothing. Each
 * fix moved the failure one step upstream while leaving `number` as the currency —
 * and `number` has no way to say "unknown", so each upstream fix had to invent a
 * stand-in, and every stand-in was spendable. The estimate is a discriminated union
 * now: `unknown` carries no `bytes`, so there is nothing for the guard to multiply.
 *
 * ## Fixture provenance
 *
 * `ZERO_STORAGE` is transcribed from the log line above (17:36:56.164) — a payload the
 * production producer really emitted at 67a2b98b0. The producer half of this fix stops
 * emitting it (`parseStorageInfo` now returns `null` instead of a device with no
 * storage), so this suite drives a state the CURRENT producer no longer produces. That
 * is deliberate defence in depth, not dead code: the orchestrator's contract is with
 * the interface, and this suite is the pin that the guard refuses a zero WHOEVER hands
 * it one. `deviceDetectionService.storageInfo-2925.test.ts` covers the producer.
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

/**
 * 15 GB free — the founder's machine, from `Disk space: 15 GB free on /` in the same
 * run. Above SYNC_DISK_RESERVE_BYTES (2.25 GB), so the up-front reserve refusal does
 * NOT fire and mask the branch under test; below the 48 GB the residual case needs, so
 * that branch is observable too. With the 500 GB other suites use, several assertions
 * below could not distinguish pass from fail.
 */
jest.mock("check-disk-space", () =>
  jest.fn().mockResolvedValue({
    diskPath: "/",
    free: 15 * 1024 * 1024 * 1024,
    size: 1000 * 1024 * 1024 * 1024,
  }),
);

jest.mock("../diagnostics/diskSpaceDiagnostics", () => ({
  ...jest.requireActual("../diagnostics/diskSpaceDiagnostics"),
  checkDiskSpaceForOperation: jest
    .fn()
    .mockResolvedValue({ sufficient: true, availableMB: 15000, requiredMB: 1000 }),
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

/**
 * THE PAYLOAD, TRANSCRIBED. Field for field from
 * `[DeviceDetection] Storage info: {...}` on 2026-08-27 17:36:56.164. Not invented:
 * inventing it would risk describing a state the producer cannot emit, which proves
 * nothing (the 2026-08-04 lesson).
 */
const ZERO_STORAGE = {
  totalCapacity: 0,
  availableSpace: 0,
  usedSpace: 0,
  estimatedBackupSize: 0,
};

/** A device that answers properly. 8 GB x 1.5 = 12 GB, which fits in 15 GB free. */
const GOOD_STORAGE_THAT_FITS = {
  totalCapacity: 128 * GB,
  availableSpace: 96 * GB,
  usedSpace: 32 * GB,
  estimatedBackupSize: 8 * GB,
};

/** 32 GB x 1.5 = 48 GB, which does NOT fit in 15 GB free. The residual case. */
const GOOD_STORAGE_THAT_DOES_NOT_FIT = {
  totalCapacity: 256 * GB,
  availableSpace: 128 * GB,
  usedSpace: 128 * GB,
  estimatedBackupSize: 32 * GB,
};

/**
 * The founder's on-disk state that night: a 19.4 GB partial from an interrupted run.
 * The byte count is his, from `ignoredPartialBytes=20832508667`; it is a size, not an
 * identifier.
 */
const INTERRUPTED_PARTIAL = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: 20832508667 },
  lastModified: new Date("2026-08-27T23:30:00Z"),
};

/** Proven ENOENT: a genuine first sync. */
const ABSENT = {
  state: "absent" as const,
  isComplete: false,
  isInterrupted: false,
  snapshotState: "absent" as const,
  size: { measured: true as const, bytes: 0 },
  lastModified: null,
};

/** A complete prior backup of 10 GB. 10 x 1.1 = 11 GB, which fits in 15 GB free. */
const COMPLETE_PRIOR = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: 10 * GB },
  lastModified: new Date("2026-08-26T16:11:44Z"),
};

async function runSync(status: unknown, storageInfo: unknown) {
  logLines.length = 0;
  mockCheckBackupStatus.mockReset().mockResolvedValue(status);
  mockGetStorageInfo.mockReset().mockResolvedValue(storageInfo);
  mockStartBackup
    .mockReset()
    .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

  const orchestrator = new DeviceSyncOrchestrator();
  const messages: string[] = [];
  const errors: { message: string; userError?: { code?: string } }[] = [];
  orchestrator.on("progress", (p: SyncProgress) => {
    if (p.message) messages.push(p.message);
  });
  orchestrator.on("error", (e: { message: string; userError?: { code?: string } }) => {
    errors.push(e);
  });
  const result = await orchestrator.sync({ udid: UDID });
  return {
    messages,
    errors,
    result,
    lines: [...logLines],
    startedBackup: mockStartBackup.mock.calls.length > 0,
  };
}

function estimateMark(lines: string[]): string {
  const found = lines.filter((l) => l.includes("mark name=backup-estimate"));
  if (found.length !== 1) throw new Error(`expected one mark, got ${found.length}`);
  return found[0];
}

describe("BACKLOG-2925: a backup size that could not be determined cannot pass the guard", () => {
  it("CONTROL 1 — the founder's exact run REFUSES instead of passing", async () => {
    // Pre-fix this run logged "Disk space check passed: 15 GB available" and started a
    // multi-hour transfer that could not fit. Post-fix it never reaches the backup.
    const { result, errors, lines, startedBackup } = await runSync(
      INTERRUPTED_PARTIAL,
      ZERO_STORAGE,
    );

    expect(result.success).toBe(false);
    expect(startedBackup).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].userError?.code).toBe("BACKUP_SIZE_UNKNOWN");

    // The words the founder reads are the emitted `message` — `IPhoneSyncFlow.tsx`
    // renders the plain error string, not `userError`.
    expect(errors[0].message).toContain("couldn't work out how big this iPhone backup will be");
    expect(errors[0].message).toContain("Unlock your iPhone");
    expect(result.error).toBe(errors[0].message);

    // The line that made the failure invisible must be gone from this run.
    expect(lines.some((l) => l.includes("Disk space check passed"))).toBe(false);
    expect(lines.some((l) => l.includes("Sync refused: backup size could not be determined"))).toBe(
      true,
    );
  });

  it("CONTROL 2 — a device-storage query that returns NOTHING refuses the same way", async () => {
    // Previously its own branch: a flat 10 GB floor, then "Proceeding anyway" whatever
    // the answer. 15 GB free would have cleared that floor and started the sync. Same
    // epistemic state as the zeros, so the same refusal — not a sibling hole.
    const { result, errors, startedBackup, lines } = await runSync(ABSENT, null);

    expect(result.success).toBe(false);
    expect(startedBackup).toBe(false);
    expect(errors[0]?.userError?.code).toBe("BACKUP_SIZE_UNKNOWN");
    expect(lines.some((l) => l.includes("Very low disk space"))).toBe(false);
  });

  it("CONTROL 3 — a VALID estimate still passes; the fix is not 'always refuse'", async () => {
    const { result, errors, startedBackup, lines } = await runSync(
      ABSENT,
      GOOD_STORAGE_THAT_FITS,
    );

    expect(startedBackup).toBe(true);
    expect(errors.some((e) => e.userError?.code === "BACKUP_SIZE_UNKNOWN")).toBe(false);
    expect(lines.some((l) => l.includes("Disk space check passed"))).toBe(true);
    // The run still fails afterwards — `startBackup` is stubbed to fail — but NOT for
    // an unknown size, which is what this control is about.
    expect(result.error).not.toContain("couldn't work out how big");
  });

  it("CONTROL 4 — a MEASURED prior backup survives a dead storage query", async () => {
    // Before this change the entire estimate lived inside `if (storageInfo)`, so a
    // device that would not report its capacity discarded a size already measured on
    // disk and took the unavailable branch. A known number must not be thrown away
    // because an unrelated query failed.
    const { startedBackup, lines, errors } = await runSync(COMPLETE_PRIOR, null);

    expect(startedBackup).toBe(true);
    expect(errors.some((e) => e.userError?.code === "BACKUP_SIZE_UNKNOWN")).toBe(false);
    expect(estimateMark(lines)).toContain("source=existing-backup");
    expect(estimateMark(lines)).toContain(`bytes=${10 * GB}`);
    expect(lines.some((l) => l.includes("Using existing backup size for estimate: 10 GB"))).toBe(
      true,
    );
  });

  it("PIN — a KNOWN estimate that does not fit still warns and proceeds (the residual)", async () => {
    // NOT changed by this item, and pinned so the distinction cannot rot. Refusing on
    // `0.25 x used space` — a ratio BACKLOG-2896 has never validated — is BACKLOG-2918
    // and is the founder's call, not an engineer's. This item is about a size that is
    // not known at all.
    const { startedBackup, lines, errors } = await runSync(
      ABSENT,
      GOOD_STORAGE_THAT_DOES_NOT_FIT,
    );

    expect(startedBackup).toBe(true);
    expect(errors.some((e) => e.userError?.code === "BACKUP_SIZE_UNKNOWN")).toBe(false);
    expect(lines.some((l) => l.includes("~48.0 GB recommended"))).toBe(true);
    expect(lines.some((l) => l.includes("Proceeding anyway"))).toBe(true);
  });
});

describe("BACKLOG-2925: the refusal is recorded, and records only what it knows", () => {
  it("emits the estimate mark BEFORE refusing, with its own source and no bytes", async () => {
    // A refusal that emits no mark is the BACKLOG-2917 invisible-branch defect reborn:
    // the runs that most need counting would be the ones missing from the aggregate.
    const { lines } = await runSync(INTERRUPTED_PARTIAL, ZERO_STORAGE);
    const mark = estimateMark(lines);

    expect(mark).toContain("source=device-storage-unusable");
    // Its own token. `device-storage-unavailable` is a DIFFERENT fact — that query
    // returned nothing; this one answered and answered uselessly.
    expect(mark).not.toContain("source=device-storage-unavailable");
    // `bytes=0` for an unknown size is the exact lie BACKLOG-2917 removed elsewhere.
    expect(mark).not.toMatch(/\bbytes=/);
    expect(mark).toContain("estimateUnknownReason=");
    expect(mark).toContain("reusedPreviousBackup=false");
    expect(mark).toContain("snapshotState=unfinished");
    // The first pass of this item still holds: the partial is recorded, never spent.
    expect(mark).toContain("ignoredPartialBytes=20832508667");
  });

  it("keeps the two unknowns separable when the query returns nothing at all", async () => {
    const { lines } = await runSync(ABSENT, null);
    const mark = estimateMark(lines);

    expect(mark).toContain("source=device-storage-unavailable");
    expect(mark).toContain("priorBackup=none");
    expect(mark).not.toMatch(/\bbytes=/);
  });

  it("never quotes a size or a verdict it does not have", async () => {
    // COUNTER-CONTROL. A refusal that invented "you need 58.8 GB" would be the same
    // defect facing the other way: BACKLOG-2886's rule is that an unknown is never
    // rendered as a confident number, and that binds the refusal too.
    const { errors } = await runSync(INTERRUPTED_PARTIAL, ZERO_STORAGE);

    expect(errors[0].message).not.toMatch(/\d+(\.\d+)?\s?(GB|MB)/);
    expect(errors[0].message).not.toMatch(/passed/i);
  });
});
