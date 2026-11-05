/**
 * BACKLOG-4124: the iPhone never answered the backup-size query.
 *
 * `ideviceinfo -q com.apple.disk_usage` can exit 0 with nothing on either stream after
 * ~60 s (libimobiledevice's own two 30 s receive waits; Keepr's 90 s limit does not
 * fire). Before this item that run became the generic "couldn't work out how big this
 * backup will be" refusal, with no reason code and no `ended_by` in sync_outcomes.
 *
 * Now:
 *  - the producer reports "no first byte, exit 0" through `onNoAnswer`;
 *  - the size-unknown refusal, when that happened, says the phone did not answer and
 *    records DEVICE_NO_ANSWER / device-no-answer;
 *  - every other size-unknown refusal records BACKUP_SIZE_UNKNOWN / size-unknown;
 *  - a measured previous backup still lets the sync run (no new refusals);
 *  - the query is asked once. No retry (founder ruling on BACKLOG-3422).
 *
 * Fixtures are transcribed from deviceDetectionService.storageQueryTiming-3422.test.ts:
 * "THE FOUNDER'S SIGNATURE" (no bytes, exit 0, no signal) and its prompt-empty pair
 * ("CalculateDiskUsage: OkilyDokily", exit 0). The C9 shape (exit fires, close held
 * past the limit) is from deviceDetectionService.toolTimeout-3996.test.ts.
 *
 * The orchestrator half runs the REAL `getDeviceStorageInfo` against a stubbed
 * `spawn`, so the producer's condition and the orchestrator's branch are tested
 * together, and the recorded row is built by the real sync_outcomes row builder.
 */
import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";
/** A syntactically valid 40-hex UDID for the producer half. Not a real device's. */
const PRODUCER_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";
const GB = 1024 * 1024 * 1024;

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const mockCheckEncryptionStatus = jest.fn();
const mockGetDeviceStorageInfo = jest.fn();
const mockSpawn = jest.fn();

jest.mock("child_process", () => ({
  ...jest.requireActual("child_process"),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// BACKLOG-3816 S4-C: the kept backup's at-rest layer is not this suite's subject.
jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("electron", () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  app: { isPackaged: false, getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()) },
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
  jest.fn().mockResolvedValue({ diskPath: "/", free: 500 * GB, size: 1000 * GB }),
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
  ...jest.requireActual("../libimobiledeviceService"),
  getLibimobiledevicePath: () => "/nonexistent",
  canUseLibimobiledevice: jest.fn(() => true),
  getCommand: jest.fn((name: string) => name),
  isMockMode: jest.fn(() => false),
}));

// The row the Supabase writer would send. The real row builder runs on it.
const mockOutcomeRows: unknown[] = [];
jest.mock("../syncOutcomeSupabase", () => ({
  ...jest.requireActual("../syncOutcomeSupabase"),
  recordSyncOutcome: (row: unknown) => mockOutcomeRows.push(row),
  recordSyncRunStart: jest.fn(),
  recordSyncRunProgress: jest.fn(),
  recordSyncRunProgressWhileRunning: jest.fn(),
  recordSyncRunMetrics: jest.fn(),
}));

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => {
    const svc = new EventEmitter();
    return Object.assign(svc, {
      checkBackupStatus: mockCheckBackupStatus,
      startBackup: mockStartBackup,
      cancelBackup: jest.fn(),
      stopForQuit: jest.fn(),
      checkEncryptionStatus: (...a: unknown[]) => mockCheckEncryptionStatus(...a),
      sweepLeftoverBackups: jest.fn().mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] }),
      classifyBackupFolder: jest.fn().mockResolvedValue("absent"),
      removeLeftoverBackup: jest.fn().mockResolvedValue({ outcome: "kept", folder: "absent" }),
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

// The singleton the orchestrator holds is a stub; its storage query is routed (per
// test) to a REAL DeviceDetectionService instance, whose `spawn` is the stub above.
// The real class stays exported for the producer half.
jest.mock("../deviceDetectionService", () => {
  const svc = new EventEmitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([]),
    getDeviceStorageInfo: (...a: unknown[]) => mockGetDeviceStorageInfo(...a),
  });
  return {
    ...jest.requireActual("../deviceDetectionService"),
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

import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { DeviceDetectionService } from "../deviceDetectionService";
import { syncTimeline } from "../syncTimeline";
import { buildSyncOutcomeRow } from "../syncOutcomeSupabase";
import type { SyncOutcomeRow } from "../syncTimeline";
import { IPHONE_QUERY_TIMEOUT_MS } from "../iphoneToolProcess";

/** The copy the founder reads (brief for BACKLOG-4124). */
const NO_ANSWER_COPY =
  "Your iPhone didn't answer when Keepr checked the backup size, so the sync didn't start. Unlock it, unplug and replug it, then try again.";

/** Transcribed from the 3422 suite's prompt-empty pair. */
const PROMPT_EMPTY_STDOUT = "CalculateDiskUsage: OkilyDokily\n";

/** Proven ENOENT: a genuine first sync (from the 2925 suite). */
const ABSENT = {
  state: "absent" as const,
  isComplete: false,
  isInterrupted: false,
  snapshotState: "absent" as const,
  size: { measured: true as const, bytes: 0 },
  lastModified: null,
};

/** A complete, measured prior backup of 10 GB (from the 2925 suite). */
const COMPLETE_PRIOR = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: 10 * GB },
  lastModified: new Date("2026-08-26T16:11:44Z"),
};

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  args: string[];
  kill = jest.fn(() => true);
  constructor(pid: number, args: string[]) {
    super();
    this.pid = pid;
    this.args = args;
  }
}

type Reply =
  | { kind: "no-answer" }
  | { kind: "stdout"; stdout: string; code?: number; stderr?: string }
  | { kind: "held" };

let reply: Reply = { kind: "no-answer" };
let children: FakeChild[] = [];
let nextPid = 4124;

const flush = () =>
  new Promise<void>((r) => jest.requireActual<typeof import("timers")>("timers").setImmediate(r));

function storageSpawns(): FakeChild[] {
  return children.filter((c) => c.args.includes("com.apple.disk_usage"));
}

beforeEach(() => {
  jest.clearAllMocks();
  syncTimeline.reset();
  mockOutcomeRows.length = 0;
  logLines.length = 0;
  children = [];
  reply = { kind: "no-answer" };
  mockSpawn.mockReset().mockImplementation((cmd: string, args: string[]) => {
    const proc = new FakeChild(nextPid++, [cmd, ...args]);
    children.push(proc);
    const r = reply;
    if (r.kind !== "held") {
      void Promise.resolve().then(() => {
        if (r.kind === "stdout") {
          // No chunk for empty stdout: a real child writes no data event for nothing.
          if (r.stdout) proc.stdout.emit("data", Buffer.from(r.stdout));
          if (r.stderr) proc.stderr.emit("data", Buffer.from(r.stderr));
        }
        const code = r.kind === "stdout" ? (r.code ?? 0) : 0;
        proc.exitCode = code;
        proc.emit("exit", code, null);
        proc.emit("close", code, null);
      });
    }
    return proc;
  });
  const real = new DeviceDetectionService();
  mockGetDeviceStorageInfo
    .mockReset()
    .mockImplementation((udid: string, opts?: object) => real.getDeviceStorageInfo(udid, opts));
  mockCheckBackupStatus.mockReset().mockResolvedValue(ABSENT);
  mockCheckEncryptionStatus
    .mockReset()
    .mockResolvedValue({ isEncrypted: false, needsPassword: false, status: "off" });
  mockStartBackup
    .mockReset()
    .mockResolvedValue({ success: false, backupPath: null, error: "stopped by test" });
});

type Captured = Array<{ message: string; userError?: { code?: string } }>;

async function runSync() {
  const orchestrator = new DeviceSyncOrchestrator();
  const errors: Captured = [];
  orchestrator.on("error", (e) => errors.push(e));
  const result = await orchestrator.sync({ udid: UDID });
  return { errors, result, startedBackup: mockStartBackup.mock.calls.length > 0 };
}

function rowOf() {
  expect(mockOutcomeRows).toHaveLength(1);
  return buildSyncOutcomeRow(mockOutcomeRows[0] as SyncOutcomeRow, "user-1");
}

describe("BACKLOG-4124 orchestrator: the phone never answered the size query", () => {
  it("C1 — the founder's signature ends with DEVICE_NO_ANSWER, its own copy, and a recorded reason", async () => {
    reply = { kind: "no-answer" };
    const { errors, result, startedBackup } = await runSync();

    expect(result.success).toBe(false);
    expect(startedBackup).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].userError?.code).toBe("DEVICE_NO_ANSWER");
    // The screen renders the plain error string (IPhoneSyncFlow), so the copy is
    // asserted on the emitted message and on result.error.
    expect(errors[0].message).toBe(NO_ANSWER_COPY);
    expect(result.error).toBe(NO_ANSWER_COPY);

    const row = rowOf();
    expect(row.reason_code).toBe("DEVICE_NO_ANSWER");
    expect(row.ended_by).toBe("device-no-answer");
    expect(row.outcome).toBe("error");
  });

  it("C2 — a prompt EMPTY answer is still BACKUP_SIZE_UNKNOWN, now recorded", async () => {
    reply = { kind: "stdout", stdout: PROMPT_EMPTY_STDOUT };
    const { errors, result, startedBackup } = await runSync();

    expect(result.success).toBe(false);
    expect(startedBackup).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].userError?.code).toBe("BACKUP_SIZE_UNKNOWN");
    expect(errors[0].message).toContain("couldn't work out how big this iPhone backup will be");

    const row = rowOf();
    expect(row.reason_code).toBe("BACKUP_SIZE_UNKNOWN");
    expect(row.ended_by).toBe("size-unknown");
  });

  it("C4 — the no-answer copy is at most two sentences and never mentions Trust", async () => {
    reply = { kind: "no-answer" };
    const { errors } = await runSync();
    const message = errors[0]?.message ?? "";

    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toMatch(/trust/i);
    const sentences = message.split(/[.!?](?:\s|$)/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeLessThanOrEqual(2);
  });

  it("NO RETRY — the size query is asked exactly once", async () => {
    reply = { kind: "no-answer" };
    await runSync();

    expect(mockGetDeviceStorageInfo).toHaveBeenCalledTimes(1);
    expect(storageSpawns()).toHaveLength(1);
  });

  it("NO NEW REFUSAL — a measured previous backup still lets the sync run when the phone does not answer", async () => {
    mockCheckBackupStatus.mockResolvedValue(COMPLETE_PRIOR);
    reply = { kind: "no-answer" };
    const { errors, startedBackup } = await runSync();

    expect(startedBackup).toBe(true);
    expect(errors.map((e) => e.userError?.code)).not.toContain("DEVICE_NO_ANSWER");
    expect(errors.map((e) => e.userError?.code)).not.toContain("BACKUP_SIZE_UNKNOWN");
  });
});

describe("BACKLOG-4124 producer: getDeviceStorageInfo reports 'no answer' only for no first byte + exit 0", () => {
  async function query(r: Reply) {
    reply = r;
    const onNoAnswer = jest.fn();
    const onTimeout = jest.fn();
    const result = await new DeviceDetectionService().getDeviceStorageInfo(PRODUCER_UDID, {
      onTimeout,
      onNoAnswer,
    });
    return { result, onNoAnswer, onTimeout };
  }

  it("P1 — nothing on either stream, exit 0: onNoAnswer once, resolves null", async () => {
    const { result, onNoAnswer, onTimeout } = await query({ kind: "no-answer" });
    expect(result).toBeNull();
    expect(onNoAnswer).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("P2 — the prompt-empty pair (a first byte, nothing usable): NOT no-answer", async () => {
    const { result, onNoAnswer } = await query({ kind: "stdout", stdout: PROMPT_EMPTY_STDOUT });
    expect(result).toBeNull();
    expect(onNoAnswer).not.toHaveBeenCalled();
  });

  it("P3 — a non-zero exit with only stderr: NOT no-answer", async () => {
    const { result, onNoAnswer } = await query({
      kind: "stdout",
      stdout: "",
      code: 1,
      stderr: "ERROR: Could not connect to lockdownd, error code -3\n",
    });
    expect(result).toBeNull();
    expect(onNoAnswer).not.toHaveBeenCalled();
  });

  describe("on fake timers", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("C3 — the C9 shape (exit, close held past the 90 s limit, then a late close 0): time-out only, never no-answer", async () => {
      reply = { kind: "held" };
      const onNoAnswer = jest.fn();
      const onTimeout = jest.fn();
      let value: unknown = "pending";
      void new DeviceDetectionService()
        .getDeviceStorageInfo(PRODUCER_UDID, {
          onTimeout,
          onNoAnswer,
        })
        .then((v) => {
          value = v;
        });
      await flush();
      const proc = storageSpawns()[0];
      expect(proc).toBeDefined();
      // A grandchild holds stdio open: 'exit' fires, 'close' does not.
      proc.exitCode = 0;
      proc.emit("exit", 0, null);
      jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS + 1000);
      await flush();
      expect(value).toBeNull();
      expect(onTimeout).toHaveBeenCalledTimes(1);
      // The held stdio is released after the time-out: close(0, null), no bytes.
      proc.emit("close", 0, null);
      await flush();
      expect(onNoAnswer).not.toHaveBeenCalled();
    });
  });
});

// BACKLOG-3816 S4-C (B1): this file's userData is a fresh directory under os.tmpdir().
afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./helpers/testUserData").removeTestUserDataDir();
});
