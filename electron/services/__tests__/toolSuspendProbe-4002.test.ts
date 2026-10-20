/**
 * BACKLOG-4002 — the thread-state probe: script, parser, spawn.
 *
 * The module is stubbed for every suite by tests/toolSuspendProbe-guard.js (SR R10), so
 * this file takes the real one with jest.requireActual.
 *
 * FIXTURES ARE TRANSCRIBED from the founder's PC run (BACKLOG-4002 pm_comments 45a0d9b5),
 * never invented. That row records the text of each line; the line ending is not visible
 * in it. powershell.exe writes CRLF after each output line, so every fixture is tested
 * both as pasted and with "\r\n" appended (SR R1) — the parser must read both the same.
 */
const mockExecFile = jest.fn();
jest.mock("child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const real = jest.requireActual("../toolSuspendProbe") as typeof import("../toolSuspendProbe");
const {
  buildThreadStateScript,
  parseThreadStateOutput,
  isAllSuspended,
  probeToolThreadState,
  THREAD_STATE_PROBE_TIMEOUT_MS,
} = real;

/** M1: a running `ping -t` (6 threads, none suspended). Verbatim. */
const PC_RUNNING = "T=6 S=0";
/** M2: the same process under NtSuspendProcess. Verbatim. */
const PC_SUSPENDED = "T=6 S=6";
/** M3: after Stop-Process. Verbatim. */
const PC_GONE = "GONE";
/** M4: idevicebackup2 during a real 20-minute device wait. Verbatim T/S parts. */
const PC_WAIT_SAMPLES = ["T=5 S=0", "T=3 S=0", "T=4 S=0", "T=2 S=0"];

const CRLF = "\r\n";

describe("parser — the PC's own lines, with and without the CRLF powershell.exe writes", () => {
  it.each([
    [PC_RUNNING, { kind: "sampled", threads: 6, suspended: 0 }],
    [PC_SUSPENDED, { kind: "sampled", threads: 6, suspended: 6 }],
    [PC_GONE, { kind: "gone" }],
    ["T=5 S=0", { kind: "sampled", threads: 5, suspended: 0 }],
    ["T=3 S=0", { kind: "sampled", threads: 3, suspended: 0 }],
    ["T=2 S=0", { kind: "sampled", threads: 2, suspended: 0 }],
  ])("%j", (line, expected) => {
    expect(parseThreadStateOutput(line)).toEqual(expected);
    expect(parseThreadStateOutput(line + CRLF)).toEqual(expected);
  });

  it.each(["", "garbage", "T=6", "T= S=", "Get-Process : Cannot find a process", "T=6 S=6 extra"])(
    "anything else is unknown, never suspended: %j",
    (text) => {
      const s = parseThreadStateOutput(text + CRLF);
      expect(s.kind).toBe("unknown");
      expect(isAllSuspended(s)).toBe(false);
    },
  );
});

describe("predicate — suspended only when every thread is suspended", () => {
  it("the suspended PC sample is suspended (with CRLF)", () => {
    expect(isAllSuspended(parseThreadStateOutput(PC_SUSPENDED + CRLF))).toBe(true);
  });

  it("MOST LIKELY WRONG IMPLEMENTATION: every real-wait sample (all threads waiting) is NOT suspended", () => {
    for (const line of [PC_RUNNING, ...PC_WAIT_SAMPLES]) {
      expect(isAllSuspended(parseThreadStateOutput(line + CRLF))).toBe(false);
    }
  });

  it("some but not all suspended is not suspended; zero threads is not suspended", () => {
    expect(isAllSuspended({ kind: "sampled", threads: 6, suspended: 5 })).toBe(false);
    expect(isAllSuspended({ kind: "sampled", threads: 0, suspended: 0 })).toBe(false);
    expect(isAllSuspended({ kind: "gone" })).toBe(false);
    expect(isAllSuspended({ kind: "unknown", reason: "x" })).toBe(false);
  });
});

describe("script", () => {
  it("tests the wait REASON, not only the thread state, and in the order that cannot throw", () => {
    const s = buildThreadStateScript(34564)!;
    expect(s).toContain("$_.ThreadState -eq 'Wait' -and $_.WaitReason -eq 'Suspended'");
  });

  it("a reused pid that is not the backup tool reads as GONE (SR R2)", () => {
    expect(buildThreadStateScript(34564)).toContain("if ($p.ProcessName -ne 'idevicebackup2') { 'GONE'; exit 0 }");
  });

  it("carries the integer pid and no double quote", () => {
    const s = buildThreadStateScript(34564)!;
    expect(s).toContain("Get-Process -Id 34564 ");
    expect(s).not.toContain('"');
  });

  it.each([0, -1, 1.5, NaN, Number.POSITIVE_INFINITY])("no script for pid %p", (pid) => {
    expect(buildThreadStateScript(pid)).toBeNull();
  });
});

describe("spawn (N10)", () => {
  beforeEach(() => mockExecFile.mockReset());

  it("runs the full System32 powershell.exe path with -Command, never bare and never -EncodedCommand", async () => {
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) =>
      cb(null, PC_SUSPENDED + CRLF),
    );
    const sample = await probeToolThreadState(34564);
    expect(sample).toEqual({ kind: "sampled", threads: 6, suspended: 6 });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args, opts] = mockExecFile.mock.calls[0];
    expect(file).toMatch(/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    expect(file).not.toBe("powershell");
    expect(file).not.toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args.join(" ")).not.toMatch(/-EncodedCommand|-enc\b|-e\b/i);
    expect(args[3]).toBe(buildThreadStateScript(34564));
    expect(opts).toEqual({ timeout: THREAD_STATE_PROBE_TIMEOUT_MS, windowsHide: true });
  });

  it("a non-integer pid spawns nothing", async () => {
    expect(await probeToolThreadState(1.5)).toEqual({ kind: "unknown", reason: "invalid-pid" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("a timeout (powershell.exe itself held) is unknown", async () => {
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: unknown, out: string) => void) =>
      cb(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), ""),
    );
    expect(await probeToolThreadState(34564)).toEqual({ kind: "unknown", reason: "timeout" });
  });

  it("a non-zero exit is unknown, even if it printed a suspended-looking line", async () => {
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: unknown, out: string) => void) =>
      cb(Object.assign(new Error("exit 1"), { code: 1 }), PC_SUSPENDED + CRLF),
    );
    expect(await probeToolThreadState(34564)).toEqual({ kind: "unknown", reason: "exit:1" });
  });

  it("a spawn that throws (EPERM: blocked at launch) is unknown and does not reject", async () => {
    mockExecFile.mockImplementation(() => {
      throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    });
    expect(await probeToolThreadState(34564)).toEqual({ kind: "unknown", reason: "spawn:EPERM" });
  });
});
