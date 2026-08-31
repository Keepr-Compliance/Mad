/**
 * BACKLOG-2938 — the two-hour banner follows USABILITY, not existence.
 *
 * ## The defect, in the founder's own case
 *
 * His `Backups/<udid>/` holds a 6.3 MB `Info.plist` and no manifest. Nothing usable
 * was ever transferred. On sync the app told him
 *
 *     Previous backup can't be used. Starting a fresh backup...
 *
 * and, in the same run, WITHHELD
 *
 *     First sync may take up to two hours depending on your phone's data.
 *
 * One fact, two answers, because the message and the banner were driven by different
 * logic: the message asked "is this directory usable?" while the mapping that feeds
 * the banner asked only "is a directory there?".
 *
 * Founder ruling, 2026-08-27: "if the sync isn't useable show the this may take two
 * hours msg."
 *
 * ## What this file pins, and why it is shaped this way
 *
 * The fix hoists ONE predicate — `isUsablePriorBackup` — and feeds both consumers
 * from it. A test that compared that predicate to itself would be unfalsifiable, so
 * this file compares the two consumers' OBSERVABLE outputs instead:
 *
 *     the message the user is shown   <->   the `priorBackup` the banner gates on
 *
 * Either consumer deriving the condition again, differently, breaks the biconditional
 * and reds this file. That is the reintroduction guard for this item.
 *
 * Deliberately NOT pinned to telemetry or to the estimate basis. A usable prior backup
 * whose size walk threw is `priorBackup: "exists"` (correct — no banner, the sync is
 * incremental) but basis `kind: "unknown"`. Parity against telemetry would red on a
 * correct tree; `SIZE_UNMEASURED_COMPLETE` below is the fixture that proves it.
 *
 * ## Fixtures
 *
 * Every `present` fixture obeys the producer's own invariant, `backupService.ts:1538`:
 *
 *     const isInterrupted = snapshotState === "unfinished";
 *
 * so no fixture here describes a state `checkBackupStatus` cannot emit. UDIDs and
 * sizes are invented except `SILENT_ABSENT`, which is transcribed from the founder's
 * production install (see `deviceSyncOrchestrator.silentState-2926.test.ts`, where the
 * same 6,343,173-byte reading is used).
 */

import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";
const GB = 1024 * 1024 * 1024;

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

// Pass the real module through and override only the one call this test drives:
// `deviceSyncOrchestrator` reads other exports from here at MODULE level, so a mock
// that enumerates exports breaks at import time the moment a new one is added.
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

// ---------------------------------------------------------------------------
// The fixture sweep: EVERY shape `checkBackupStatus` can return, not a sample.
// ---------------------------------------------------------------------------

/**
 * THE FOUNDER'S CASE, and the reason this item exists. Transcribed from his
 * production install: `Info.plist` present (so the directory exists and has a
 * measurable size), no `Status.plist` (snapshot state absent, hence NOT interrupted)
 * and no `Manifest.db` (hence not complete). Nothing usable was ever transferred.
 */
const SILENT_ABSENT = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: false,
  snapshotState: "absent" as const,
  size: { measured: true as const, bytes: 6_343_173 },
  lastModified: new Date("2026-07-28T21:42:28Z"),
};

/** The second route to the same unusable directory: finished snapshot, no manifest. */
const SILENT_FINISHED_NO_MANIFEST = {
  ...SILENT_ABSENT,
  snapshotState: "finished" as const,
};

/** A genuine partial: a torn transfer where data really did move. */
const INTERRUPTED_INCOMPLETE = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: 6.5 * GB },
  lastModified: new Date("2026-08-26T22:22:41Z"),
};

/**
 * A backup that WAS complete and whose latest snapshot then tore. `isComplete` and
 * `isInterrupted` are both true.
 *
 * BACKLOG-2911 (second pass), 2026-08-28: this fixture MOVED SIDES. It used to be the
 * combination that made `isComplete` alone an insufficient usability test; the
 * founder's controlled interruption showed it is the combination that makes
 * `!isInterrupted` a wrong one. `Manifest.db` was byte-identical before and after the
 * cable was pulled, the delta was kept, and the device transferred incrementally
 * against that manifest. It is USABLE, and the parity sweep below says so.
 */
const INTERRUPTED_BUT_COMPLETE = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  size: { measured: true as const, bytes: 40 * GB },
  lastModified: new Date("2026-08-26T18:05:04Z"),
};

/** The ordinary good case: a finished, complete prior backup. Incremental. */
const COMPLETE_FINISHED = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: 54.7 * GB },
  lastModified: new Date("2026-08-26T16:11:44Z"),
};

/**
 * STATE D: a real backup predating this device writing a `Status.plist` — manifest
 * present, snapshot state absent. Usable, and deliberately NOT demoted by the gate
 * (see the note at the estimate site).
 */
const COMPLETE_SNAPSHOT_ABSENT = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "absent" as const,
  size: { measured: true as const, bytes: 31 * GB },
  lastModified: new Date("2026-08-20T09:14:00Z"),
};

/**
 * Usable, but the size walk threw. This is the fixture that makes telemetry-based
 * parity WRONG: the basis is `kind: "unknown"` while the banner must stay hidden,
 * because the sync is still incremental.
 */
const SIZE_UNMEASURED_COMPLETE = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: false as const, reason: "EACCES walking backup directory" },
  lastModified: new Date("2026-08-25T11:02:00Z"),
};

/** Proven ENOENT: there is no prior backup at all. */
const ABSENT = { state: "absent" as const };

/** The check itself failed. Establishes nothing. */
const CHECK_FAILED = { state: "unknown" as const, reason: "EACCES" };

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------

/**
 * The messages that tell the user a FULL transfer is coming. All three are emitted by
 * `deviceSyncOrchestrator`; "Previous backup can't be used" is the one the founder
 * saw alongside a hidden banner.
 */
const FULL_TRANSFER_MESSAGE = /can't be used|didn't finish|Preparing first sync/i;

/** The message that tells the user the prior backup is being REUSED. */
const INCREMENTAL_MESSAGE = /Found previous backup/i;

/** The message emitted when nothing was established. Claims neither. */
const CLAIMS_NOTHING_MESSAGE = /^Checking your iPhone/i;

interface Run {
  /** Every `priorBackup` value carried by a progress event AFTER the check ran. */
  statesAfterCheck: Array<PriorBackupState | undefined>;
  messages: string[];
  saysFullTransfer: boolean;
  saysIncremental: boolean;
  /**
   * The THIRD consumer of the predicate: the BACKLOG-2925 estimate gate, observed
   * through the `backup-estimate` mark it drives. `null` when no mark was emitted.
   */
  reusedPreviousBackup: boolean | null;
}

/** The `backup-estimate` mark, as `syncTimeline` writes it to the log. */
function estimateMark(lines: string[]): string | null {
  const found = lines.filter((l) => l.includes("mark name=backup-estimate"));
  if (found.length > 1) throw new Error(`expected at most one mark, got ${found.length}`);
  return found[0] ?? null;
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

  const mark = estimateMark(logLines);

  return {
    // The first event is emitted BEFORE the check resolves and necessarily carries
    // the constructor default; every later event is an answer.
    statesAfterCheck: states.slice(1),
    messages,
    saysFullTransfer: messages.some((m) => FULL_TRANSFER_MESSAGE.test(m)),
    saysIncremental: messages.some((m) => INCREMENTAL_MESSAGE.test(m)),
    reusedPreviousBackup: mark === null ? null : mark.includes("reusedPreviousBackup=true"),
  };
}

function theOneStateAfterCheck(run: Run): PriorBackupState | undefined {
  const distinct = [...new Set(run.statesAfterCheck)];
  // A run that changed its mind mid-flight would make the biconditional meaningless.
  expect(distinct).toHaveLength(1);
  return distinct[0];
}

// ---------------------------------------------------------------------------
// CONTROL 1 — the founder's exact case
// ---------------------------------------------------------------------------

describe("BACKLOG-2938: the founder's unusable directory shows the two-hour banner", () => {
  it("THE RULING — Info.plist only, no manifest, reports `none` so the banner renders", async () => {
    const run = await runSync(SILENT_ABSENT);

    // Before this item it reported `"exists"`, and `SyncProgress.tsx` gates the
    // banner on `"none"` — so he was told the old backup was worthless and NOT told
    // the replacement would run for hours.
    expect(theOneStateAfterCheck(run)).toBe("none");
    expect(run.saysFullTransfer).toBe(true);
    expect(run.messages).toContain("Previous backup can't be used. Starting a fresh backup...");
  });

  it("says both things, not one — the message and the banner now agree", async () => {
    const run = await runSync(SILENT_ABSENT);

    // The defect was not that either half was wrong. It was that they disagreed.
    expect(run.messages.some((m) => /can't be used/i.test(m))).toBe(true);
    expect(run.statesAfterCheck.every((s) => s === "none")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CONTROL 2 — the fix must not become "always show"
// ---------------------------------------------------------------------------

describe("BACKLOG-2938: a usable prior backup still renders NO banner", () => {
  it("a COMPLETE, finished prior backup reports `exists`", async () => {
    const run = await runSync(COMPLETE_FINISHED);

    // Re-introducing "always show" would be BACKLOG-2907's original defect, and worse
    // than the bug this fixes: the banner would be noise on every incremental sync.
    expect(theOneStateAfterCheck(run)).toBe("exists");
    expect(run.saysIncremental).toBe(true);
    expect(run.saysFullTransfer).toBe(false);
  });

  it("STATE D — a manifest with no Status.plist is usable and reports `exists`", async () => {
    const run = await runSync(COMPLETE_SNAPSHOT_ABSENT);

    expect(theOneStateAfterCheck(run)).toBe("exists");
    expect(run.saysFullTransfer).toBe(false);
  });

  it("a usable backup whose SIZE could not be measured still reports `exists`", async () => {
    // The sync is incremental regardless of whether the host could size the directory.
    // This is why parity is pinned to the message and not to the estimate basis, which
    // is `kind: "unknown"` here.
    const run = await runSync(SIZE_UNMEASURED_COMPLETE);

    expect(theOneStateAfterCheck(run)).toBe("exists");
    expect(run.saysIncremental).toBe(true);
    expect(run.saysFullTransfer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CONTROL 3 — unknown claims nothing
// ---------------------------------------------------------------------------

describe("BACKLOG-2938: an unestablished answer claims neither", () => {
  it("a failed check reports `unknown` and emits no full-transfer or incremental claim", async () => {
    const run = await runSync(CHECK_FAILED);

    expect(run.statesAfterCheck.every((s) => s === "unknown")).toBe(true);
    expect(run.statesAfterCheck).not.toContain("none");
    expect(run.statesAfterCheck).not.toContain("exists");
    // Neither half may speak. Claiming a two-hour first sync on a guess is the defect
    // BACKLOG-2917 exists to prevent, and this ruling does not relax it.
    expect(run.saysFullTransfer).toBe(false);
    expect(run.saysIncremental).toBe(false);
    expect(run.messages.some((m) => CLAIMS_NOTHING_MESSAGE.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE PARITY ITSELF — the two consumers of `isUsablePriorBackup`, swept
// ---------------------------------------------------------------------------

describe("BACKLOG-2938 PARITY: the message and the banner answer from one predicate", () => {
  /**
   * `sizeMeasured` decides whether the estimate-gate axis applies. A USABLE backup
   * whose size walk threw takes the `kind: "unknown"` basis and reports
   * `reusedPreviousBackup=false` while the banner correctly stays hidden — the two
   * are answering different questions there, and asserting parity would red on a
   * correct tree. That is the whole reason this axis is conditional rather than
   * unconditional.
   */
  const sweep: Array<{
    name: string;
    status: unknown;
    usable: boolean;
    sizeMeasured: boolean;
  }> = [
    { name: "founder's Info.plist-only directory", status: SILENT_ABSENT, usable: false, sizeMeasured: true },
    { name: "finished snapshot, no manifest", status: SILENT_FINISHED_NO_MANIFEST, usable: false, sizeMeasured: true },
    { name: "torn transfer, incomplete", status: INTERRUPTED_INCOMPLETE, usable: false, sizeMeasured: true },
    // BACKLOG-2911 (second pass): `usable` flipped false -> true here, on the measured
    // evidence above. The sweep is otherwise untouched, which is the point — one
    // fixture changed side and every consumer followed it without a second edit.
    { name: "complete but torn since", status: INTERRUPTED_BUT_COMPLETE, usable: true, sizeMeasured: true },
    { name: "complete and finished", status: COMPLETE_FINISHED, usable: true, sizeMeasured: true },
    { name: "complete, snapshot absent (state D)", status: COMPLETE_SNAPSHOT_ABSENT, usable: true, sizeMeasured: true },
    { name: "complete, size unmeasured", status: SIZE_UNMEASURED_COMPLETE, usable: true, sizeMeasured: false },
    { name: "proven ENOENT", status: ABSENT, usable: false, sizeMeasured: false },
  ];

  it.each(sweep)(
    "$name — the message, the banner state and the estimate gate never disagree",
    async ({ status, usable, sizeMeasured }) => {
      const run = await runSync(status);
      const state = theOneStateAfterCheck(run);

      // AXIS 1 — the message the user is shown, against the state the banner gates
      // on. Both directions. A consumer that derives the condition again —
      // `isComplete` alone at one site, `isComplete && !isInterrupted` at the other —
      // breaks one direction or the other and reds this case.
      expect(run.saysIncremental).toBe(state === "exists");
      expect(run.saysFullTransfer).toBe(state === "none");

      // And exactly one of the two is said: silence about a prior backup is the
      // BACKLOG-2926 defect, and saying both is the BACKLOG-2938 defect.
      expect(run.saysIncremental !== run.saysFullTransfer).toBe(true);

      // AXIS 2 — the BACKLOG-2925 estimate gate, observed through the mark it drives.
      // The item's requirement is that "usable" be the SAME predicate the 2925 gate
      // uses; without this axis, that gate could be re-derived differently and
      // nothing here would notice.
      if (sizeMeasured) {
        expect(run.reusedPreviousBackup).toBe(state === "exists");
      }

      expect(state).toBe(usable ? "exists" : "none");
    },
  );

  it("the size-unmeasured case is the ONE place the two questions diverge, on purpose", async () => {
    // Documented here rather than left as a silent hole in the sweep above. The sync
    // is incremental (no banner), and the estimate still refuses to size itself
    // against a number nobody measured. Both are right; they are different questions.
    const run = await runSync(SIZE_UNMEASURED_COMPLETE);

    expect(theOneStateAfterCheck(run)).toBe("exists");
    expect(run.reusedPreviousBackup).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The SECOND entry point reads the same predicate
// ---------------------------------------------------------------------------

describe("BACKLOG-2938: `processExistingBackup` reports usability, not existence", () => {
  async function runProcessExisting(status: unknown) {
    mockCheckBackupStatus.mockReset().mockResolvedValue(status);

    const orchestrator = new DeviceSyncOrchestrator();
    const states: Array<PriorBackupState | undefined> = [];
    orchestrator.on("progress", (p: SyncProgress) => states.push(p.priorBackup));
    orchestrator.on("error", () => {});

    // `forceResync` skips the change-detection filesystem read; the decryption service
    // and both parsers are mocked, so the run reaches its first progress emit.
    await orchestrator.processExistingBackup({ udid: UDID, forceResync: true });
    return states;
  }

  it("a complete-but-torn backup reports `exists` here too", async () => {
    // This entry point's own guard checks `isComplete`, and since BACKLOG-2911's second
    // pass so does `isUsablePriorBackup` — so the two now agree BY CONSTRUCTION rather
    // than by two edits staying in step. The divergence 2938 was filed for is gone in
    // the strongest available way: there is no second condition left to drift.
    //
    // Note which direction the agreement resolved. This path PARSES the backup, so
    // "none" meant announcing a full transfer while reading the prior one.
    const states = await runProcessExisting(INTERRUPTED_BUT_COMPLETE);

    expect(states.length).toBeGreaterThan(0);
    expect(states).not.toContain("none");
    expect(states.every((s) => s === "exists")).toBe(true);
  });

  it("a complete, finished backup still reports `exists` here", async () => {
    const states = await runProcessExisting(COMPLETE_FINISHED);

    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s === "exists")).toBe(true);
  });
});
