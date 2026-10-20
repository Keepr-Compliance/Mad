/**
 * BACKLOG-4002 — a backup tool whose every thread is suspended (Windows).
 *
 * The REAL BackupService runs; `spawn`, `fs.promises` and the thread-state probe are
 * replaced. The probe is injected on the service (`service.threadStateProbe`), and its
 * answers are the REAL parser's reading of lines TRANSCRIBED from the founder's PC
 * (BACKLOG-4002 pm_comments 45a0d9b5), each with the CRLF powershell.exe writes:
 *
 *   SUSPENDED  "T=6 S=6"   M2, a process under NtSuspendProcess
 *   RUNNING    "T=6 S=0"   M1, the same process running
 *   WAIT_*     "T=5 S=0" / "T=3 S=0" / "T=4 S=0" / "T=2 S=0"   M4, idevicebackup2 during
 *              a real 20-minute device wait: every thread waiting, none suspended
 *
 * A raw byte here is an idle-chatter stderr line (`receive_timeout`): it is output, so
 * the tool is not suspended, but it is not progress, so the watchdog clock does not move.
 *
 *  N1   detection: three suspended samples over 60 s -> one notice, one Sentry event
 *       with exactly the agreed extra keys, the process NOT killed
 *  N2   MOST LIKELY WRONG IMPLEMENTATION: "every thread waiting = suspended". 20 minutes
 *       of the real wait samples -> no notice
 *  N3   unknown is never suspended; 3 unknowns stop the check with one log line
 *  N4   the streak: a running sample or a byte resets it
 *  N5   the notice comes down on a byte or a running sample, and comes back on a second
 *       suspension without a second Sentry event; a late answer after Cancel is ignored;
 *       a probe that never answers is not doubled
 *  N8   gates: before the first byte, with idle chatter, with handling off (the macOS
 *       path), and after close / Cancel / the watchdog -> the probe is never called
 *  N9   a 1,140 s silent wait that then delivers is not stopped and gets no notice
 *  R7   the watchdog result says whether the notice was showing WHEN it fired
 *  N10  no pid -> no probe
 */
import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";
import type { ThreadStateProbe, ThreadStateSample } from "../toolSuspendProbe";

const UDID = "a1b2c3d4e5f6789012345678901234567890abcd";
const mockSpawn = jest.fn();

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/mock/userData"),
    getVersion: jest.fn(() => "2.43.0"),
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
  debug: (...a: unknown[]) => push(...a),
}));

const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  addBreadcrumb: jest.fn(),
}));

jest.mock("fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    access: jest.fn().mockRejectedValue(new Error("Not found")),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest.fn().mockRejectedValue(Object.assign(new Error("no"), { code: "ENOENT" })),
    rm: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../atRest/fileCrypto", () => ({
  ...jest.requireActual("../atRest/fileCrypto"),
  writeFileAtomic: jest.fn().mockResolvedValue(undefined),
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

import { BackupService } from "../backupService";

// The real parser (the module is stubbed globally by tests/toolSuspendProbe-guard.js).
const { parseThreadStateOutput } = jest.requireActual("../toolSuspendProbe") as typeof import("../toolSuspendProbe");
const CRLF = "\r\n";
const SUSPENDED = parseThreadStateOutput("T=6 S=6" + CRLF);
const RUNNING = parseThreadStateOutput("T=6 S=0" + CRLF);
const WAIT_SAMPLES = ["T=5 S=0", "T=3 S=0", "T=4 S=0", "T=2 S=0"].map((l) => parseThreadStateOutput(l + CRLF));
const UNKNOWN = parseThreadStateOutput("Get-Process : Access is denied" + CRLF);

const IDLE_LINE = "idevice_connection_receive_timeout(): ret -7\n";
const PROGRESS_BAR = "[=====                ] 25% (1.0 MB/4.0 MB)\n";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
}

interface Run {
  service: BackupService;
  proc: FakeProcess;
  result: Promise<BackupResult>;
  suspended: Array<{ at: number; code: string }>;
  resumed: number[];
  probe: jest.Mock;
}

/** A probe that answers each call with the next sample (the last one repeats). */
function sequence(...samples: ThreadStateSample[]): jest.Mock {
  let i = 0;
  return jest.fn(async () => samples[Math.min(i++, samples.length - 1)]);
}

async function start(opts: { hold?: boolean; probe?: jest.Mock; pid?: number | undefined } = {}): Promise<Run> {
  const service = new BackupService();
  service.toolHoldHandling = opts.hold ?? true;
  const probe = opts.probe ?? sequence(SUSPENDED);
  service.threadStateProbe = probe as unknown as ThreadStateProbe;
  const suspended: Run["suspended"] = [];
  const resumed: number[] = [];
  service.on("tool-suspended", (p: { userError: { code: string } }) =>
    suspended.push({ at: Date.now() - T0, code: p.userError.code }),
  );
  service.on("tool-resumed", () => resumed.push(Date.now() - T0));
  let spawned!: (p: FakeProcess) => void;
  const spawnedP = new Promise<FakeProcess>((r) => (spawned = r));
  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      process.nextTick(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.emit("close", 0);
      });
    } else if (cmd.includes("idevicebackup2")) {
      if ("pid" in opts) proc.pid = opts.pid;
      spawned(proc);
    }
    return proc;
  });
  const result = service.startBackup({ udid: UDID });
  const proc = await spawnedP;
  return { service, proc, result, suspended, resumed, probe };
}

const byte = (run: Run) => run.proc.stderr.emit("data", Buffer.from(IDLE_LINE));
const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);
const suspendedSentry = () => mockCaptureMessage.mock.calls.filter((c) => c[0] === "iPhone backup tool suspended");
const backupSpawns = () => mockSpawn.mock.calls.filter((c) => String(c[0]).includes("idevicebackup2"));

async function finish(run: Run, code: number | null = 1): Promise<BackupResult> {
  run.proc.emit("close", code);
  return run.result;
}

const T0 = new Date("2026-10-19T19:32:10.000Z").getTime();

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  jest.setSystemTime(T0);
  logLines.length = 0;
  mockSpawn.mockReset();
  mockCaptureMessage.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("N1: detection", () => {
  it("three suspended samples over 60 s: one notice, one Sentry event, the process kept", async () => {
    const run = await start();
    byte(run); // the first byte; then silence
    await advance(125_000);

    expect(run.suspended).toEqual([{ at: 120_000, code: "IPHONE_TOOL_SUSPENDED" }]);
    expect(run.probe).toHaveBeenCalledTimes(3);
    expect(run.probe.mock.calls.every((c) => c[0] === 4242)).toBe(true);

    const sentry = suspendedSentry();
    expect(sentry).toHaveLength(1);
    const [, ctx] = sentry[0];
    expect(ctx.level).toBe("warning");
    expect(ctx.tags).toEqual({ component: "backup_service", platform: process.platform });
    expect(Object.keys(ctx.extra).sort()).toEqual(["samples", "silentMs", "sinceSpawnMs", "threads", "tool"]);
    expect(ctx.extra).toEqual({ tool: "idevicebackup2", threads: 6, samples: 3, silentMs: 120_000, sinceSpawnMs: 120_000 });

    expect(logLines).toContain(
      "[BackupService] idevicebackup2: all 6 threads suspended in 3 samples over 60s; showing the antivirus notice",
    );
    // KEPT: no kill, no tree kill.
    expect(run.proc.kill).not.toHaveBeenCalled();
    expect(mockSpawn.mock.calls.some((c) => String(c[0]).toLowerCase().includes("taskkill"))).toBe(false);
    expect(backupSpawns()).toHaveLength(1);
    await finish(run);
  });
});

describe("N2: the real device wait is not a suspension (most likely wrong implementation)", () => {
  it("20 minutes of the PC's wait samples (every thread waiting, none suspended): no notice", async () => {
    const run = await start({ probe: jest.fn(async () => WAIT_SAMPLES[run.probe.mock.calls.length % 4]) });
    byte(run);
    await advance(20 * 60_000);
    expect(run.probe.mock.calls.length).toBeGreaterThan(10);
    expect(run.suspended).toEqual([]);
    expect(suspendedSentry()).toHaveLength(0);
    expect(run.proc.kill).not.toHaveBeenCalled();
    await finish(run);
  });

  it("back-off: 30 s, then 60 s after 10 running samples, then 120 s after 20, at most 40", async () => {
    const run = await start({ probe: jest.fn(async () => RUNNING) });
    byte(run);
    await advance(330_000); // probes at 60..330 s, every 30 s
    expect(run.probe).toHaveBeenCalledTimes(10);
    await advance(600_000); // 390..930 s, every 60 s
    expect(run.probe).toHaveBeenCalledTimes(20);
    await advance(240_000); // 1050, 1170 s, every 120 s
    expect(run.probe).toHaveBeenCalledTimes(22);
    await finish(run);
  });
});

describe("N3: unknown is never suspended", () => {
  it.each([
    ["an unparseable answer", () => jest.fn(async () => UNKNOWN)],
    ["a probe that throws", () => jest.fn(() => { throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" }); })],
    ["a probe that rejects", () => jest.fn(async () => { throw new Error("boom"); })],
  ])("%s x10: no notice; after 3 no more probes; one log line", async (_name, make) => {
    const run = await start({ probe: make() });
    byte(run);
    await advance(10 * 60_000);
    expect(run.suspended).toEqual([]);
    expect(run.probe).toHaveBeenCalledTimes(3);
    expect(logLines.filter((l) => l.includes("thread-state probe unavailable") && l.includes("not checking again this run"))).toHaveLength(1);
    await finish(run);
  });

  it("unknowns between suspended samples break the streak", async () => {
    const run = await start({ probe: sequence(SUSPENDED, SUSPENDED, UNKNOWN, SUSPENDED, SUSPENDED, RUNNING) });
    byte(run);
    await advance(10 * 60_000);
    expect(run.suspended).toEqual([]);
    await finish(run);
  });
});

describe("N4: the streak", () => {
  it("suspended, suspended, running, suspended, suspended -> no notice; one more suspended -> notice", async () => {
    const run = await start({ probe: sequence(SUSPENDED, SUSPENDED, RUNNING, SUSPENDED, SUSPENDED, SUSPENDED) });
    byte(run);
    await advance(185_000); // probes at 60, 90, 120, 150, 180 s
    expect(run.probe).toHaveBeenCalledTimes(5);
    expect(run.suspended).toEqual([]);
    await advance(30_000); // 210 s: 150, 180, 210 are three in a row over 60 s
    expect(run.suspended.map((s) => s.at)).toEqual([210_000]);
    await finish(run);
  });

  it("SR N4(a): suspended, suspended, a byte, suspended -> no notice", async () => {
    const run = await start();
    byte(run);
    await advance(95_000); // probes at 60, 90 s
    expect(run.probe).toHaveBeenCalledTimes(2);
    byte(run); // at 95 s: output, so not suspended
    await advance(65_000); // 120, 150 s: silence under a minute, no probe; none at all yet
    expect(run.probe).toHaveBeenCalledTimes(2);
    await advance(30_000); // 180 s: the first sample of a NEW streak
    expect(run.probe).toHaveBeenCalledTimes(3);
    expect(run.suspended).toEqual([]);
    await advance(60_000); // 210, 240 s: three in a row again
    expect(run.suspended.map((s) => s.at)).toEqual([240_000]);
    await finish(run);
  });
});

describe("N5: the notice comes down, and comes back", () => {
  it("a byte takes it down; a second suspension shows it again with no second Sentry event", async () => {
    const run = await start();
    byte(run);
    await advance(125_000);
    expect(run.suspended).toHaveLength(1);
    byte(run); // 125 s
    expect(run.resumed).toEqual([125_000]);
    expect(logLines.some((l) => l.includes("idevicebackup2 is running again") && l.includes("notice cleared"))).toBe(true);
    await advance(180_000); // probes at 210, 240, 270 s
    expect(run.suspended.map((s) => s.at)).toEqual([120_000, 270_000]);
    expect(suspendedSentry()).toHaveLength(1);
    await finish(run);
  });

  it("a running sample takes it down", async () => {
    const run = await start({ probe: sequence(SUSPENDED, SUSPENDED, SUSPENDED, RUNNING) });
    byte(run);
    await advance(155_000);
    expect(run.suspended).toHaveLength(1);
    expect(run.resumed).toEqual([150_000]);
    await finish(run);
  });

  it("SR N5: an answer that arrives after Cancel shows nothing", async () => {
    let answer!: (s: ThreadStateSample) => void;
    let calls = 0;
    const probe = jest.fn(() => {
      calls++;
      if (calls < 3) return Promise.resolve(SUSPENDED);
      return new Promise<ThreadStateSample>((r) => (answer = r));
    });
    const run = await start({ probe });
    byte(run);
    await advance(125_000); // the third probe (120 s) is in flight
    expect(probe).toHaveBeenCalledTimes(3);
    run.service.cancelBackup();
    answer(SUSPENDED);
    await advance(1_000);
    expect(run.suspended).toEqual([]);
    expect(suspendedSentry()).toHaveLength(0);
    run.proc.emit("close", null);
    await run.result;
  });

  it("SR N5: a probe that never answers is not doubled", async () => {
    const run = await start({ probe: jest.fn(() => new Promise<ThreadStateSample>(() => undefined)) });
    byte(run);
    await advance(5 * 60_000);
    expect(run.probe).toHaveBeenCalledTimes(1);
    await finish(run);
  });
});

describe("N8: when the probe must never run", () => {
  it("before the first byte (a held start is BACKLOG-3814's): 10 minutes of total silence", async () => {
    const run = await start();
    await advance(10 * 60_000);
    expect(run.probe).not.toHaveBeenCalled();
    await finish(run);
  });

  it("idle chatter every 10 s for 20 minutes (output, so not suspended)", async () => {
    const run = await start();
    for (let t = 0; t < 20 * 60_000; t += 10_000) {
      byte(run);
      await advance(10_000);
    }
    expect(run.probe).not.toHaveBeenCalled();
    await finish(run);
  });

  it("handling off (the macOS path), probe present: never called", async () => {
    const run = await start({ hold: false });
    byte(run);
    await advance(10 * 60_000);
    expect(run.probe).not.toHaveBeenCalled();
    await finish(run);
  });

  it("after the tool closed", async () => {
    const run = await start();
    byte(run);
    await finish(run);
    await advance(10 * 60_000);
    expect(run.probe).not.toHaveBeenCalled();
  });

  it("after Cancel", async () => {
    const run = await start();
    byte(run);
    await advance(30_000);
    run.service.cancelBackup();
    await advance(10 * 60_000);
    expect(run.probe).not.toHaveBeenCalled();
    run.proc.emit("close", null);
    await run.result;
  });

  it("after the watchdog fired", async () => {
    const run = await start({ probe: jest.fn(async () => RUNNING) });
    byte(run);
    await advance(30 * 60_000 + 1_000); // the watchdog fires at 30 min
    expect(run.proc.kill).toHaveBeenCalled();
    const before = run.probe.mock.calls.length;
    await advance(5_000); // inside the kill's 10 s grace, the tool not yet closed
    expect(run.probe.mock.calls.length).toBe(before);
    run.proc.emit("close", null);
    expect((await run.result).errorCode).toBe("BACKUP_TIMEOUT");
    await advance(5 * 60_000);
    expect(run.probe.mock.calls.length).toBe(before);
  });

  it("N10: no pid, no probe", async () => {
    const run = await start({ pid: undefined });
    byte(run);
    await advance(5 * 60_000);
    expect(run.probe).not.toHaveBeenCalled();
    await finish(run);
  });
});

describe("N9: a real 1,140 s wait survives", () => {
  it("1,140 s of silence after the first byte, the PC's wait samples, then the transfer: not stopped, no notice", async () => {
    const run = await start({ probe: jest.fn(async () => WAIT_SAMPLES[1]) });
    byte(run);
    await advance(1_140_000);
    run.proc.stdout.emit("data", Buffer.from(PROGRESS_BAR));
    await advance(1_000);
    expect(run.proc.kill).not.toHaveBeenCalled();
    expect(logLines.some((l) => l.includes("Watchdog: no progress"))).toBe(false);
    expect(run.suspended).toEqual([]);
    const r = await finish(run, 1);
    expect(r.errorCode).not.toBe("BACKUP_TIMEOUT");
  });
});

describe("R7: the watchdog result says whether the notice was showing WHEN it fired", () => {
  it("suspended to the end: toolSuspendedAtTimeout true, and on the watchdog's Sentry event", async () => {
    const run = await start();
    byte(run);
    await advance(30 * 60_000 + 1_000);
    expect(run.suspended).toHaveLength(1);
    run.proc.emit("close", null);
    const r = await run.result;
    expect(r.errorCode).toBe("BACKUP_TIMEOUT");
    expect(r.toolSuspendedAtTimeout).toBe(true);
    const wd = mockCaptureMessage.mock.calls.find((c) => String(c[0]).includes("killed by watchdog"));
    expect(wd?.[1].extra.toolSuspendedAtTimeout).toBe(true);
  });

  it("SR N4(b): suspended at minute 2, resumed, then a device that never sends: toolSuspendedAtTimeout false", async () => {
    let calls = 0;
    const probe = jest.fn(async () => (++calls <= 3 ? SUSPENDED : WAIT_SAMPLES[calls % 4]));
    const run = await start({ probe });
    byte(run);
    await advance(125_000);
    expect(run.suspended).toHaveLength(1);
    byte(run); // resumed
    expect(run.resumed).toHaveLength(1);
    await advance(30 * 60_000 - 125_000 + 1_000); // to the watchdog at 30 min
    run.proc.emit("close", null);
    const r = await run.result;
    expect(r.errorCode).toBe("BACKUP_TIMEOUT");
    expect(r.toolSuspendedAtTimeout).toBe(false);
    expect(run.suspended).toHaveLength(1);
  });
});

describe("R4: the run's probe count is logged", () => {
  it("one line at the end of the run", async () => {
    const run = await start({ probe: jest.fn(async () => RUNNING) });
    byte(run);
    await advance(125_000);
    await finish(run);
    expect(logLines).toContain("[BackupService] thread-state probe: 3 probe(s) this run; stopped (closed)");
    expect(logLines.filter((l) => /thread-state probe \d: T=6 S=0 in \d+ ms/.test(l))).toHaveLength(3);
  });
});
