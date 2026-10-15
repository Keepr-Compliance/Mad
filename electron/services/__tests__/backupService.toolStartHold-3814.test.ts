/**
 * BACKLOG-3814 — the backup tool held at start by a security scan (Windows).
 *
 * The REAL BackupService runs; only `spawn` and `fs.promises` are replaced. The held
 * run is the transcribed one in helpers/toolStartHoldFixture.ts: spawn() itself blocked
 * for SPAWN_BLOCK_MS (modelled by moving the clock inside the spawn stand-in, which is
 * what a synchronous block looks like to the code), then the three stderr lines and
 * exit 4294967295.
 */
import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";

const UDID = "a1b2c3d4e5f6789012345678901234567890abcd";
const APP_VERSION = "2.40.0-rc.1";
const mockSpawn = jest.fn();
const files = new Map<string, string>();

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/mock/userData"),
    getVersion: jest.fn(() => "2.40.0-rc.1"),
    isPackaged: false,
  },
}));

const logLines: string[] = [];
const push = (...a: unknown[]) => {
  logLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
};
jest.mock("electron-log", () => ({
  info: (...a: unknown[]) => push(...a),
  warn: (...a: unknown[]) => push(...a),
  error: (...a: unknown[]) => push(...a),
  debug: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("fs", () => {
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    promises: {
      mkdir: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockRejectedValue(new Error("Not found")),
      readdir: jest.fn().mockResolvedValue([]),
      stat: jest.fn().mockRejectedValue(Object.assign(new Error("no"), { code: "ENOENT" })),
      rm: jest.fn().mockResolvedValue(undefined),
      rename: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn(async (p: string) => {
        if (!files.has(p)) throw enoent();
        return files.get(p);
      }),
      writeFile: jest.fn(async (p: string, d: string) => {
        files.set(p, String(d));
      }),
    },
  };
});

// The record is written through the at-rest atomic writer; here it lands in `files`.
jest.mock("../atRest/fileCrypto", () => ({
  ...jest.requireActual("../atRest/fileCrypto"),
  writeFileAtomic: jest.fn(async (p: string, d: string) => {
    files.set(p, String(d));
  }),
}));

jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn((name: string) => `/mock/${name}`),
  isMockMode: jest.fn().mockReturnValue(false),
}));

jest.mock("../backupDecryptionService", () => ({
  backupDecryptionService: {
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  },
}));

import path from "path";
import { BackupService } from "../backupService";
import { IDEVICE_TOOL_RUNS_FILE, TOOL_START_HOLD_STATUS_MESSAGE } from "../toolStartHold";
import {
  HELD_EXIT_CODE,
  HELD_RUN_STDERR,
  SPAWN_BLOCK_MS,
  heldStartFailure,
} from "./helpers/toolStartHoldFixture";

const RUNS_FILE = path.join("/mock/userData", IDEVICE_TOOL_RUNS_FILE);

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
}

interface Run {
  service: BackupService;
  proc: FakeProcess;
  result: Promise<BackupResult>;
  events: string[];
  statuses: string[];
}

async function start(opts: { spawnBlockMs?: number; holdHandling?: boolean } = {}): Promise<Run> {
  const service = new BackupService();
  service.toolHoldHandling = opts.holdHandling ?? true;
  const events: string[] = [];
  const statuses: string[] = [];
  service.on("waiting-for-passcode", () => events.push(`waiting-for-passcode@${Date.now()}`));
  service.on("progress", (p: { message?: string }) => {
    if (p.message) statuses.push(p.message);
  });
  let spawned!: (p: FakeProcess) => void;
  const spawnedP = new Promise<FakeProcess>((r) => (spawned = r));
  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      process.nextTick(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.emit("close", 0);
      });
    } else {
      // A synchronous hold inside spawn(): the clock moves, nothing else runs.
      if (opts.spawnBlockMs) jest.setSystemTime(Date.now() + opts.spawnBlockMs);
      spawned(proc);
    }
    return proc;
  });
  const result = service.startBackup({ udid: UDID });
  const proc = await spawnedP;
  return { service, proc, result, events, statuses };
}

function failHeldWay(proc: FakeProcess): void {
  proc.stderr.emit("data", Buffer.from(HELD_RUN_STDERR));
  proc.emit("close", HELD_EXIT_CODE);
}

const T0 = new Date("2026-10-10T20:19:47.167Z").getTime();

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  jest.setSystemTime(T0);
  files.clear();
  logLines.length = 0;
  mockSpawn.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-3814: the start is measured from BEFORE spawn()", () => {
  it("the transcribed held run: the producer's result is exactly the fixture the orchestrator suites use", async () => {
    files.set(RUNS_FILE, JSON.stringify({ idevicebackup2: APP_VERSION }));
    const run = await start({ spawnBlockMs: SPAWN_BLOCK_MS });
    failHeldWay(run.proc);
    const r = await run.result;

    const expected = heldStartFailure(UDID);
    expect({
      error: r.error,
      errorCode: r.errorCode,
      failureCause: r.failureCause,
      toolStart: r.toolStart,
    }).toEqual({
      error: expected.error,
      errorCode: expected.errorCode,
      failureCause: expected.failureCause,
      toolStart: expected.toolStart,
    });
    expect(r.errorCode).toBe("SERVICE_UNAVAILABLE");
    expect(logLines.some((l) => l.includes(`[Backup] tool start delayed ${SPAWN_BLOCK_MS}ms (possible antivirus scan)`))).toBe(true);
  });

  it("a normal start: not delayed, no delayed log", async () => {
    files.set(RUNS_FILE, JSON.stringify({ idevicebackup2: APP_VERSION }));
    const run = await start();
    jest.advanceTimersByTime(40);
    failHeldWay(run.proc);
    const r = await run.result;
    expect(r.toolStart).toEqual({ delayMs: 40, delayed: false, firstRunThisVersion: false });
    expect(logLines.some((l) => l.includes("tool start delayed"))).toBe(false);
  });

  it("macOS (handling off): no toolStart on the result", async () => {
    const run = await start({ holdHandling: false, spawnBlockMs: SPAWN_BLOCK_MS });
    failHeldWay(run.proc);
    expect((await run.result).toolStart).toBeUndefined();
  });
});

describe("BACKLOG-3814: first run of the tool under this app version", () => {
  it("no record -> firstRunThisVersion, and the record names this version after the tool ran", async () => {
    const run = await start();
    failHeldWay(run.proc);
    expect((await run.result).toolStart?.firstRunThisVersion).toBe(true);
    await Promise.resolve();
    await new Promise((r) => process.nextTick(r));
    expect(JSON.parse(files.get(RUNS_FILE) ?? "{}")).toEqual({ idevicebackup2: APP_VERSION });
  });

  it("a record for an older version -> first run", async () => {
    files.set(RUNS_FILE, JSON.stringify({ idevicebackup2: "2.39.0" }));
    const run = await start();
    failHeldWay(run.proc);
    expect((await run.result).toolStart?.firstRunThisVersion).toBe(true);
  });

  it("an unreadable record -> NOT a first run (cannot show it is one)", async () => {
    files.set(RUNS_FILE, "<plist></plist>");
    const run = await start();
    failHeldWay(run.proc);
    expect((await run.result).toolStart?.firstRunThisVersion).toBe(false);
  });

  it("a run that printed nothing is not recorded (the hold may still be ahead)", async () => {
    const run = await start();
    run.proc.emit("close", HELD_EXIT_CODE);
    await run.result;
    await new Promise((r) => process.nextTick(r));
    expect(files.has(RUNS_FILE)).toBe(false);
  });
});

describe("BACKLOG-3814: the 5 s device-wait prompt is held only while NO byte has arrived", () => {
  it("a stderr byte before 5 s -> the prompt at 5 s exactly as before, no scan status", async () => {
    const run = await start();
    jest.advanceTimersByTime(1000);
    run.proc.stderr.emit("data", Buffer.from("idevice_connection_receive_timeout\n"));
    jest.advanceTimersByTime(3999);
    expect(run.events).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(run.events).toEqual([`waiting-for-passcode@${T0 + 5000}`]);
    jest.advanceTimersByTime(10_000);
    expect(run.statuses).not.toContain(TOOL_START_HOLD_STATUS_MESSAGE);
    failHeldWay(run.proc);
    await run.result;
  });

  it("no byte: no prompt at 5 s, the scan status at 8 s, the prompt 5 s after the first byte", async () => {
    const run = await start();
    jest.advanceTimersByTime(5000);
    expect(run.events).toEqual([]);
    jest.advanceTimersByTime(2999);
    expect(run.statuses).not.toContain(TOOL_START_HOLD_STATUS_MESSAGE);
    jest.advanceTimersByTime(1);
    expect(run.statuses).toContain(TOOL_START_HOLD_STATUS_MESSAGE);
    jest.advanceTimersByTime(1000); // t = 9 s
    run.proc.stderr.emit("data", Buffer.from("lockdownd_client_new_with_handshake\n"));
    jest.advanceTimersByTime(4999);
    expect(run.events).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(run.events).toEqual([`waiting-for-passcode@${T0 + 14_000}`]);
    failHeldWay(run.proc);
    await run.result;
  });

  it("macOS (handling off): no byte still prompts at 5 s and never shows the scan status", async () => {
    const run = await start({ holdHandling: false });
    jest.advanceTimersByTime(5000);
    expect(run.events).toEqual([`waiting-for-passcode@${T0 + 5000}`]);
    jest.advanceTimersByTime(10_000);
    expect(run.statuses).not.toContain(TOOL_START_HOLD_STATUS_MESSAGE);
    failHeldWay(run.proc);
    await run.result;
  });
});
