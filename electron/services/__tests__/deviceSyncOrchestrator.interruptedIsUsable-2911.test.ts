/**
 * BACKLOG-2911 (second pass) — A COMPLETE BACKUP WHOSE LAST RUN WAS INTERRUPTED IS
 * STILL USABLE, and the one predicate that decides it feeds three consumers.
 *
 * ## The evidence this file is transcribed from
 *
 * The founder ran a controlled interruption on 2026-08-28: a complete 57.57 GB backup
 * on disk, an incremental sync underway with one 1.93 GB file already transferred,
 * then the cable pulled. State captured before and after:
 *
 *   | `Manifest.db` sha | `fa9c84e8768334d3…` -> `fa9c84e8768334d3…`  IDENTICAL   |
 *   | folder size       | 57.57 GB            -> 58.47 GB, the delta KEPT        |
 *   | `IsFullBackup`    | 0                   -> 0, still incremental            |
 *   | `SnapshotState`   | `finished`          -> `uploading`  <- the ONLY change  |
 *
 * Keepr then logged `isComplete=true, isInterrupted=true`, announced "starting a new
 * backup", replaced the measured 57.9 GB with an 11,547 MB guess (25% of used space),
 * and showed "First sync may take up to two hours" — on an incremental. The device
 * meanwhile transferred against the unchanged manifest at ~482 MB/min, growing the
 * folder from 58 GB rather than restarting at zero.
 *
 * ## What is pinned here
 *
 * `isUsablePriorBackup` dropping `!isInterrupted` is one line. This file exists because
 * that one line is read by THREE consumers, and the item's claim is that all three come
 * right together. A test of the predicate alone would prove none of it, so every
 * assertion below is on an OBSERVABLE:
 *
 *   1. the message the user is shown                     (this item)
 *   2. `priorBackup`, which `SyncProgress.tsx` gates the two-hour banner on   (2938)
 *   3. the `backup-estimate` mark's `source`/`bytes`                          (2918)
 *
 * ## The control that must never be deleted
 *
 * `MANIFEST_MISSING` is the founder's OTHER real state, measured 2026-08-27:
 * `BackupState: empty`, `SnapshotState: uploading`, no `Manifest.db`. It must still be
 * REFUSED. Without it this change is "always reuse", which reintroduces BACKLOG-2925 —
 * merged into this very base branch three days earlier.
 *
 * ## Fixture provenance
 *
 * Every `present` fixture obeys the producer's own invariant in `checkBackupStatus`:
 *
 *     const isInterrupted = snapshotState === "unfinished";
 *
 * and `readSnapshotState` maps the device's `SnapshotState: "uploading"` to
 * `"unfinished"` (it matches only the one known-good value, `"finished"`). So the
 * device-level `uploading` states above appear here as `snapshotState: "unfinished"`.
 * No fixture describes a state `checkBackupStatus` cannot emit. The UDID is invented;
 * the byte counts and dates are the founder's.
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
// Fixtures — the two states the founder actually had on disk, three days apart
// ---------------------------------------------------------------------------

/**
 * 2026-08-28, AFTER the deliberate interruption. Device reported
 * `SnapshotState: uploading` (-> `"unfinished"`) and `IsFullBackup: 0`; `Manifest.db`
 * was byte-identical to the pre-interruption capture, so `isComplete` is true.
 *
 * THIS IS THE ITEM. Before the fix it was refused.
 */
const INTERRUPTED_MANIFEST_INTACT = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: MEASURED_PRIOR_BACKUP_BYTES },
  lastModified: new Date("2026-08-28T12:24:42Z"),
};

/**
 * THE CONTROL. 2026-08-27, the founder's production install: `BackupState: empty`,
 * `SnapshotState: uploading`, NO `Manifest.db` — 6,343,173 bytes of `Info.plist` and
 * nothing else. Nothing usable was ever transferred and there is no index to diff
 * against. Must still be REFUSED.
 */
const MANIFEST_MISSING = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: 6_343_173 },
  lastModified: new Date("2026-08-27T09:07:11Z"),
};

/** The ordinary good case, unchanged by this item: complete and finished. */
const COMPLETE_FINISHED = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: Math.round(54.7 * GB) },
  lastModified: new Date("2026-08-26T16:11:44Z"),
};

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------

/** Every message that tells the user a FULL transfer is coming. */
const FULL_TRANSFER_MESSAGE = /can't be used|didn't finish|Preparing first sync/i;

/** The message that tells the user the prior backup is being kept and reused. */
const REUSE_MESSAGE = /Found previous backup/i;

interface Run {
  statesAfterCheck: Array<PriorBackupState | undefined>;
  messages: string[];
  saysFullTransfer: boolean;
  saysReuse: boolean;
  /** The `backup-estimate` mark line, as `syncTimeline` writes it. */
  estimateMark: string | null;
}

async function runSync(status: unknown): Promise<Run> {
  logLines.length = 0;
  mockCheckBackupStatus.mockReset().mockResolvedValue(status);
  mockStartBackup
    .mockReset()
    .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });

  const orchestrator = new DeviceSyncOrchestrator();
  const states: Array<PriorBackupState | undefined> = [];
  const messages: string[] = [];
  orchestrator.on("progress", (p: SyncProgress) => {
    states.push(p.priorBackup);
    if (p.message) messages.push(p.message);
  });
  orchestrator.on("error", () => {
    /* the run is stopped deliberately at startBackup */
  });

  await orchestrator.sync({ udid: UDID });

  const marks = logLines.filter((l) => l.includes("mark name=backup-estimate"));
  if (marks.length > 1) throw new Error(`expected at most one mark, got ${marks.length}`);

  return {
    // The first event is emitted BEFORE the check resolves and carries the
    // constructor default; every later event is an answer.
    statesAfterCheck: states.slice(1),
    messages,
    saysFullTransfer: messages.some((m) => FULL_TRANSFER_MESSAGE.test(m)),
    saysReuse: messages.some((m) => REUSE_MESSAGE.test(m)),
    estimateMark: marks[0] ?? null,
  };
}

function theOneStateAfterCheck(run: Run): PriorBackupState | undefined {
  const distinct = [...new Set(run.statesAfterCheck)];
  expect(distinct).toHaveLength(1);
  return distinct[0];
}

// ---------------------------------------------------------------------------
// THE CONTROL FIRST — the refusal that keeps this from becoming "always reuse"
// ---------------------------------------------------------------------------

describe("BACKLOG-2911 CONTROL: a backup with no Manifest.db is still refused", () => {
  it("the founder's 2026-08-27 state — uploading, no manifest — reports `none`", async () => {
    const run = await runSync(MANIFEST_MISSING);

    // If this ever reads "exists", the predicate has become "always reuse" and
    // BACKLOG-2925's refusal — merged into this branch's own base — is undone.
    expect(theOneStateAfterCheck(run)).toBe("none");
    expect(run.saysFullTransfer).toBe(true);
    expect(run.saysReuse).toBe(false);
  });

  it("and its 6.3 MB is NOT allowed to size the disk guard", async () => {
    const run = await runSync(MANIFEST_MISSING);

    // The measured bytes are recorded as `ignoredPartialBytes` and the estimate comes
    // from device storage. Sizing a 58 GB transfer against 6.3 MB is the BACKLOG-2925
    // defect exactly.
    expect(run.estimateMark).not.toBeNull();
    expect(run.estimateMark).toContain("source=device-storage");
    expect(run.estimateMark).toContain("reusedPreviousBackup=false");
    expect(run.estimateMark).toContain("ignoredPartialBytes=6343173");
    expect(run.estimateMark).not.toContain(`bytes=${MANIFEST_MISSING.size.bytes} `);
  });
});

// ---------------------------------------------------------------------------
// THE FIX — all three consumers, on the founder's measured state
// ---------------------------------------------------------------------------

describe("BACKLOG-2911: an interrupted backup with an intact manifest is usable", () => {
  it("THE PREDICATE — reports `exists`, so no full transfer is announced", async () => {
    const run = await runSync(INTERRUPTED_MANIFEST_INTACT);

    expect(theOneStateAfterCheck(run)).toBe("exists");
    expect(run.saysFullTransfer).toBe(false);
  });

  it("THE MESSAGE — says the data is kept, not that the sync starts over", async () => {
    const run = await runSync(INTERRUPTED_MANIFEST_INTACT);

    // What he was shown: "Previous sync didn't finish (57.9 GB saved). Starting over..."
    expect(run.messages).not.toContain(
      "Previous sync didn't finish (57.9 GB saved). Starting over...",
    );
    expect(run.saysReuse).toBe(true);
    // The interruption is still reported — it happened, and hiding it would be a
    // different lie. What changes is the consequence claimed.
    expect(
      run.messages.some((m) => /last sync was interrupted, but nothing is lost/i.test(m)),
    ).toBe(true);
  });

  it("BACKLOG-2938 FOR FREE — the two-hour first-sync banner stays hidden", async () => {
    const run = await runSync(INTERRUPTED_MANIFEST_INTACT);

    // `SyncProgress.tsx` renders the "First sync may take up to two hours" banner on
    // `priorBackup === "none"` alone. This is the whole of 2938's half of the item.
    expect(run.statesAfterCheck).not.toContain("none");
    expect(run.statesAfterCheck.every((s) => s === "exists")).toBe(true);
  });

  it("BACKLOG-2918 FOR FREE — the estimate is the measured 57.9 GB, not the 11,547 MB guess", async () => {
    const run = await runSync(INTERRUPTED_MANIFEST_INTACT);

    expect(run.estimateMark).not.toBeNull();
    expect(run.estimateMark).toContain("source=existing-backup");
    expect(run.estimateMark).toContain("reusedPreviousBackup=true");
    expect(run.estimateMark).toContain(`bytes=${MEASURED_PRIOR_BACKUP_BYTES}`);
    // The wrong number must be absent, not merely un-asserted. `estimatedBackupSize`
    // on the mocked device is exactly this, so a regression to the device-storage
    // branch would put it here.
    expect(run.estimateMark).not.toContain(`bytes=${DEVICE_STORAGE_GUESS_BYTES}`);
    expect(run.estimateMark).toContain("snapshotState=unfinished");
  });

  it("the second entry point agrees — `processExistingBackup` reports `exists` too", async () => {
    mockCheckBackupStatus.mockReset().mockResolvedValue(INTERRUPTED_MANIFEST_INTACT);

    const orchestrator = new DeviceSyncOrchestrator();
    const states: Array<PriorBackupState | undefined> = [];
    orchestrator.on("progress", (p: SyncProgress) => states.push(p.priorBackup));
    orchestrator.on("error", () => {});

    await orchestrator.processExistingBackup({ udid: UDID, forceResync: true });

    // This path PARSES the backup (its own guard is `!isComplete`) — so reporting
    // "none" here meant telling the user a full transfer was coming while reading the
    // prior backup. The two are now the same test by construction.
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s === "exists")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The unchanged case, so a regression here cannot hide behind the new one
// ---------------------------------------------------------------------------

describe("BACKLOG-2911: a complete, finished backup is unaffected", () => {
  it("still reports `exists` and still estimates from the measured size", async () => {
    const run = await runSync(COMPLETE_FINISHED);

    expect(theOneStateAfterCheck(run)).toBe("exists");
    expect(run.saysReuse).toBe(true);
    expect(run.saysFullTransfer).toBe(false);
    expect(run.estimateMark).toContain("source=existing-backup");
    expect(run.estimateMark).toContain(`bytes=${COMPLETE_FINISHED.size.bytes}`);
    // And it does NOT claim an interruption that did not happen.
    expect(run.messages.some((m) => /interrupted/i.test(m))).toBe(false);
  });
});
