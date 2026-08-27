/**
 * BACKLOG-2926 — the state where the app said nothing at all.
 *
 * ## The defect
 *
 * The orchestrator had exactly two branches after checking for a previous backup:
 *
 *     if (backupStatus.isInterrupted)      -> "Previous sync didn't finish..."
 *     else if (backupStatus.isComplete)    -> "Found previous backup..."
 *     // and nothing else
 *
 * `isInterrupted` is `snapshotState === "unfinished"`, so a snapshot state of
 * `"absent"` produced `false` — the same value a FINISHED snapshot produces. A
 * directory that is neither interrupted nor complete therefore fired NEITHER branch
 * and the user was told nothing whatsoever. BACKLOG-2911's commit message names that
 * silence as the defect it was filed to fix; it closed it for `uploading` and left it
 * open for `absent`.
 *
 * ## Reachability — measured, on the founder's production install
 *
 * A device backup directory holding a 6.3 MB `Info.plist` and nothing else: no
 * `Status.plist`, no `Manifest.db`, no blob directories. That is `snapshotState:
 * "absent"` with `isComplete: false` — the silent state, live, today. Full detail
 * (path, device identifier) is in the BACKLOG-2926 Supabase comments, kept out of this
 * public repo.
 *
 * ## TWO states reached that silence, not one
 *
 * The item names `absent`. But `finished` + no `Manifest.db` lands in exactly the same
 * place by a different route — a snapshot the device called finished which never
 * produced a manifest. Both are swept here, which is why the fix is an exhaustive
 * `switch` over `snapshotState` rather than one more `if`.
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

/**
 * The founder's live production directory, as `checkBackupStatus` reports it:
 * `Info.plist` present, so the directory exists and has a measurable size; no
 * `Status.plist` (snapshot state absent) and no `Manifest.db` (not complete).
 */
const SILENT_ABSENT = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: false,
  snapshotState: "absent" as const,
  size: { measured: true as const, bytes: 6_343_173 },
  lastModified: new Date("2026-07-28T21:42:28Z"),
};

/** The second route to the same silence: finished snapshot, no manifest. */
const SILENT_FINISHED_NO_MANIFEST = {
  ...SILENT_ABSENT,
  snapshotState: "finished" as const,
};

const INTERRUPTED = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: 5 * GB },
  lastModified: new Date("2026-08-26T18:05:04Z"),
};

const COMPLETE = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: 54.7 * GB },
  lastModified: new Date("2026-08-26T16:11:44Z"),
};

async function runSync(status: unknown) {
  logLines.length = 0;
  mockCheckBackupStatus.mockReset().mockResolvedValue(status);
  if (mockGetStorageInfo.getMockImplementation() === undefined) {
    // `mockResolvedValueOnce` set by a test survives this default.
    mockGetStorageInfo.mockResolvedValue({
      totalSpace: 256 * GB,
      usedSpace: 128 * GB,
      freeSpace: 128 * GB,
      estimatedBackupSize: 50 * GB,
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
    /* the run is stopped deliberately at startBackup */
  });

  await orchestrator.sync({ udid: UDID });
  return { messages, lines: [...logLines] };
}

/**
 * Messages emitted BEFORE the backup starts — the window where the app either says
 * something about the previous backup or says nothing. "Initializing sync..." is
 * emitted unconditionally by Step 0 and is not a statement about the prior backup.
 */
function priorBackupMessages(messages: string[]): string[] {
  return messages.filter(
    (m) => !/^Initializing sync/.test(m) && !/^Checking available disk space/.test(m),
  );
}

describe("BACKLOG-2926: the silent state now says something", () => {
  it("THE FOUNDER'S LIVE STATE — an unusable backup directory is reported, not ignored", async () => {
    const { messages } = await runSync(SILENT_ABSENT);

    const said = priorBackupMessages(messages);
    // The defect: this list was EMPTY. Both existing branches were skipped and the
    // sync went straight to transferring with no explanation.
    expect(said.length).toBeGreaterThan(0);
    expect(said.some((m) => /can't be used/i.test(m))).toBe(true);
  });

  it("never renders the founder's 6,343,173-byte directory as '0.0 GB'", async () => {
    // This assertion previously ran INVERTED — it pinned "0.0 GB on disk" as desired
    // output. That string is what he would actually have seen: this branch is by
    // construction the sub-GB case, so `toFixed(1)` on GB always yields "0.0" here.
    // It reads as a rendering bug and tells him nothing actionable, so the size is now
    // in the log (as exact bytes) and out of the message.
    const { messages, lines } = await runSync(SILENT_ABSENT);

    for (const message of messages) {
      expect(message).not.toContain("0.0 GB");
    }
    // ...but the diagnostic value is not lost: the log carries the exact byte count.
    expect(lines.some((l) => l.includes("6343173 bytes on disk"))).toBe(true);
  });

  it("does NOT claim the previous sync 'didn't finish' — there is no evidence it started", async () => {
    const { messages } = await runSync(SILENT_ABSENT);

    // `absent` means nothing said anything. Borrowing the interrupted branch's wording
    // would invent a cause, which is the same class of defect as BACKLOG-2917: stating
    // as fact something that was never established.
    for (const message of messages) {
      expect(message).not.toMatch(/didn't finish|did not finish/i);
      expect(message).not.toMatch(/resum/i);
    }
  });

  it("THE SECOND ROUTE — a finished snapshot with no manifest is equally unusable and equally reported", async () => {
    // Not named in the item. It reaches the same silence by a different path, and an
    // `if (snapshotState === "absent")` fix would have left it silent.
    const { messages } = await runSync(SILENT_FINISHED_NO_MANIFEST);

    const said = priorBackupMessages(messages);
    expect(said.some((m) => /can't be used/i.test(m))).toBe(true);
    expect(said.some((m) => /Found previous backup/i.test(m))).toBe(false);
  });

  it("the unusable state is DISTINCT from the interrupted one", async () => {
    const unusable = priorBackupMessages((await runSync(SILENT_ABSENT)).messages);
    const interrupted = priorBackupMessages((await runSync(INTERRUPTED)).messages);

    expect(unusable.some((m) => /can't be used/i.test(m))).toBe(true);
    expect(interrupted.some((m) => /didn't finish/i.test(m))).toBe(true);
    // Three on-disk states, three different things said. A test asserting only "some
    // message appears" would pass even if both said the same thing.
    expect(unusable).not.toEqual(interrupted);
  });
});

describe("BACKLOG-2926: the states that already worked must keep working", () => {
  it("an interrupted backup still says it didn't finish", async () => {
    const { messages } = await runSync(INTERRUPTED);
    expect(messages.some((m) => /didn't finish/i.test(m))).toBe(true);
    expect(messages.some((m) => /5\.0 GB/.test(m))).toBe(true);
  });

  it("a complete backup still says it was found, with its age", async () => {
    const { messages } = await runSync(COMPLETE);
    expect(messages.some((m) => /Found previous backup/i.test(m))).toBe(true);
    expect(messages.some((m) => /synced .* ago/i.test(m))).toBe(true);
    expect(messages.some((m) => /can't be used/i.test(m))).toBe(false);
  });

  it("STATE D — absent snapshot WITH a manifest is still the complete branch", async () => {
    // A real backup from before this device wrote a Status.plist. BACKLOG-2925's gate
    // depends on this staying usable, so the new branch must not capture it.
    const { messages } = await runSync({
      ...COMPLETE,
      snapshotState: "absent" as const,
      isComplete: true,
    });

    expect(messages.some((m) => /Found previous backup/i.test(m))).toBe(true);
    expect(messages.some((m) => /can't be used/i.test(m))).toBe(false);
  });
});

describe("BACKLOG-2926: the snapshot state reaches the telemetry", () => {
  it("records which snapshot state drove the estimate", async () => {
    // So "how often does the unusable state actually occur?" becomes a question
    // BACKLOG-2894's aggregate can answer, instead of a judgement made once in review.
    const { lines } = await runSync(SILENT_ABSENT);
    const mark = lines.find((l) => l.includes("mark name=backup-estimate"));
    expect(mark).toBeDefined();
    expect(mark).toContain("snapshotState=absent");
  });

  it("a FAILED check is not recorded as a proven absence", async () => {
    // BACKLOG-2917's defect, reproduced inside the field added to measure it: the
    // first version of this telemetry defaulted to "no-backup" and was overwritten
    // only on the `present` arm, so a run whose check THREW recorded the same token as
    // a proven ENOENT — while the log ten lines above said "NOT treating this as a
    // first sync". `GROUP BY snapshotState` could not separate the two.
    const failed = (await runSync({ state: "unknown", reason: "EACCES" })).lines.find((l) =>
      l.includes("mark name=backup-estimate"),
    );
    const absent = (await runSync({ state: "absent" })).lines.find((l) =>
      l.includes("mark name=backup-estimate"),
    );

    expect(failed).toContain("snapshotState=check-failed");
    expect(absent).toContain("snapshotState=no-backup");
    expect(failed).not.toContain("snapshotState=no-backup");
  });

  it("the device-storage-unavailable mark carries the snapshot dimension too", async () => {
    // That mark omitted the field entirely, so every sync taking the branch was
    // invisible to the aggregate on exactly the axis the field exists for.
    mockGetStorageInfo.mockResolvedValueOnce(null);
    const { lines } = await runSync(SILENT_ABSENT);

    const mark = lines.find((l) => l.includes("source=device-storage-unavailable"));
    expect(mark).toBeDefined();
    expect(mark).toContain("snapshotState=absent");
  });

  it("distinguishes the snapshot states in telemetry", async () => {
    const absent = (await runSync(SILENT_ABSENT)).lines.find((l) => l.includes("backup-estimate"));
    const finished = (await runSync(COMPLETE)).lines.find((l) => l.includes("backup-estimate"));
    const unfinished = (await runSync(INTERRUPTED)).lines.find((l) => l.includes("backup-estimate"));

    expect(absent).toContain("snapshotState=absent");
    expect(finished).toContain("snapshotState=finished");
    expect(unfinished).toContain("snapshotState=unfinished");
  });
});
