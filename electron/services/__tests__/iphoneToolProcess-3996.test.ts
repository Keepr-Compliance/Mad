/**
 * BACKLOG-3996: the one kill for iPhone tools, and the time limit on short queries.
 *
 * Fakes are transcribed from real child_process behaviour measured on macOS
 * (2026-10-18, plan probes P1-P4 and SR probe):
 *  - a STOPPED child sent SIGTERM: `killed` becomes true, nothing is emitted, exitCode
 *    and signalCode stay null. Only SIGKILL produces 'exit' (null, "SIGKILL").
 *  - every fake carries pid, exitCode and signalCode (null while alive), as a real
 *    ChildProcess does (SR R2).
 *
 * Windows behaviour (TerminateProcess, taskkill's tree walk) cannot run here. These
 * tests pin what Keepr ISSUES on win32 (which command, in which order), not what
 * Windows does with it.
 */
import { EventEmitter } from "events";

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));
const logLines: string[] = [];
jest.mock("electron-log", () => ({
  info: (...a: unknown[]) => logLines.push(`info|${a.map(String).join(" ")}`),
  warn: (...a: unknown[]) => logLines.push(`warn|${a.map(String).join(" ")}`),
  error: (...a: unknown[]) => logLines.push(`error|${a.map(String).join(" ")}`),
  debug: jest.fn(),
}));
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
}));

import type { ChildProcess } from "child_process";
import {
  IPHONE_QUERY_TIMEOUT_MS,
  KILL_EXIT_BACKSTOP_MS,
  TASKKILL_FALLBACK_MS,
  killIphoneToolTree,
  killAllIphoneTools,
  superviseIphoneTool,
  taskkillPath,
  __liveIphoneToolCountForTests,
  __resetIphoneToolProcessForTests,
} from "../iphoneToolProcess";

const TASKKILL = "C:\\Windows\\System32\\taskkill.exe";

type FakeChild = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  kill: jest.Mock;
};

/**
 * `suspended`: P1a — SIGTERM (or a bare kill) is recorded and ignored; SIGKILL ends it.
 * `obeys`: any signal ends it.
 */
function fakeChild(mode: "suspended" | "obeys" | "never", pid = 1234): FakeChild {
  const p = new EventEmitter() as FakeChild;
  p.pid = pid;
  p.exitCode = null;
  p.signalCode = null;
  p.killed = false;
  p.kill = jest.fn((signal?: string) => {
    p.killed = true;
    const sig = signal ?? "SIGTERM";
    if (mode === "obeys" || (mode === "suspended" && sig === "SIGKILL")) {
      p.signalCode = sig;
      p.emit("exit", null, sig);
      p.emit("close", null, sig);
    }
    return true;
  });
  return p;
}

/** A taskkill stand-in. `onRun` decides what it does to the target. */
function fakeTaskkill(exitCode: number | "hang" | "error", onRun?: () => void) {
  const tk = new EventEmitter();
  mockSpawn.mockImplementationOnce(() => {
    void Promise.resolve().then(() => {
      onRun?.();
      if (exitCode === "error") tk.emit("error", new Error("spawn EPERM"));
      else if (exitCode !== "hang") tk.emit("exit", exitCode);
    });
    return tk;
  });
}

const flush = () => new Promise<void>((r) => jest.requireActual<typeof import("timers")>("timers").setImmediate(r));
const asChild = (p: FakeChild) => p as unknown as ChildProcess;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (v: string) => Object.defineProperty(process, "platform", { value: v, configurable: true });

beforeEach(() => {
  jest.useFakeTimers();
  mockSpawn.mockReset();
  mockCaptureMessage.mockReset();
  logLines.length = 0;
  __resetIphoneToolProcessForTests();
});
afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
});

describe("constants", () => {
  it("the query limit is 90 s and taskkill is the System32 one", () => {
    expect(IPHONE_QUERY_TIMEOUT_MS).toBe(90_000);
    const saved = process.env.SystemRoot;
    delete process.env.SystemRoot;
    expect(taskkillPath()).toBe(TASKKILL);
    process.env.SystemRoot = "D:\\Win";
    expect(taskkillPath()).toBe("D:\\Win\\System32\\taskkill.exe");
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  });
});

describe("C5/C6 Windows: taskkill /T /F first, by full path; child.kill only after", () => {
  it("spawns taskkill before any proc.kill, and proc.kill only once taskkill has finished", async () => {
    setPlatform("win32");
    const saved = process.env.SystemRoot;
    delete process.env.SystemRoot;
    const proc = fakeChild("never");
    const order: string[] = [];
    proc.kill.mockImplementation(() => {
      order.push("proc.kill");
      return true;
    });
    const tk = new EventEmitter();
    mockSpawn.mockImplementationOnce((cmd: string) => {
      order.push(`spawn:${cmd}`);
      return tk;
    });

    killIphoneToolTree(asChild(proc), { tool: "ideviceinfo", reason: "timeout" });
    expect(mockSpawn).toHaveBeenCalledWith(TASKKILL, ["/PID", "1234", "/T", "/F"], expect.objectContaining({ windowsHide: true }));
    expect(order).toEqual([`spawn:${TASKKILL}`]);

    tk.emit("exit", 1);
    expect(order).toEqual([`spawn:${TASKKILL}`, "proc.kill"]);
    if (saved !== undefined) process.env.SystemRoot = saved;
  });

  it("taskkill ended the tree: no proc.kill is sent", async () => {
    setPlatform("win32");
    const proc = fakeChild("never");
    fakeTaskkill(0, () => {
      proc.exitCode = 1;
      proc.emit("exit", 1, null);
    });
    killIphoneToolTree(asChild(proc), { tool: "ideviceinfo", reason: "cancel" });
    await flush();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("taskkill held (never exits): proc.kill after 3 s", () => {
    setPlatform("win32");
    const proc = fakeChild("never");
    fakeTaskkill("hang");
    killIphoneToolTree(asChild(proc), { tool: "ideviceinfo", reason: "timeout" });
    jest.advanceTimersByTime(TASKKILL_FALLBACK_MS - 1);
    expect(proc.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it("taskkill could not start: proc.kill at once", async () => {
    setPlatform("win32");
    const proc = fakeChild("never");
    fakeTaskkill("error");
    killIphoneToolTree(asChild(proc), { tool: "idevice_id", reason: "timeout" });
    await flush();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it("taskkill exit 128 (not found) is 'already gone', not logged as a failure", async () => {
    setPlatform("win32");
    const proc = fakeChild("never");
    fakeTaskkill(128, () => {
      proc.exitCode = 0;
    });
    killIphoneToolTree(asChild(proc), { tool: "ideviceinfo", reason: "timeout" });
    await flush();
    expect(logLines.filter((l) => l.includes("taskkill exited"))).toEqual([]);
  });

  it("no pid (spawn failed): never sends '/PID undefined'", () => {
    setPlatform("win32");
    const proc = fakeChild("never");
    proc.pid = undefined;
    killIphoneToolTree(asChild(proc), { tool: "ideviceinfo", reason: "timeout" });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
});

describe("C7 POSIX: a suspended query is SIGKILLed", () => {
  it("queries get SIGKILL at once; the suspended child exits", () => {
    setPlatform("darwin");
    const proc = fakeChild("suspended");
    killIphoneToolTree(asChild(proc), { tool: "ideviceinfo", reason: "timeout" });
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(proc.signalCode).toBe("SIGKILL");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("with graceMs: SIGTERM, then SIGKILL when the process has not exited — though .killed is already true", () => {
    setPlatform("darwin");
    const proc = fakeChild("suspended");
    killIphoneToolTree(asChild(proc), { tool: "idevicebackup2", reason: "watchdog", graceMs: 5000 });
    expect(proc.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(proc.killed).toBe(true);
    jest.advanceTimersByTime(5000);
    expect(proc.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("an already-exited process gets nothing", () => {
    setPlatform("darwin");
    const proc = fakeChild("obeys");
    proc.exitCode = 0;
    killIphoneToolTree(asChild(proc), { tool: "ideviceinfo", reason: "timeout" });
    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("C10 / R3 backstop: no exit 10 s after the kill", () => {
  it("logs and reports once per tool per stretch, with no path and no UDID", () => {
    setPlatform("darwin");
    const a = fakeChild("never");
    killIphoneToolTree(asChild(a), { tool: "ideviceinfo", reason: "timeout" });
    jest.advanceTimersByTime(KILL_EXIT_BACKSTOP_MS - 1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [msg, ctx] = mockCaptureMessage.mock.calls[0];
    expect(msg).toBe("iPhone tool did not exit after kill");
    expect(Object.keys(ctx.extra).sort()).toEqual(["elapsedMs", "pid", "platform", "reason", "tool"]);
    expect(ctx.extra).toMatchObject({ tool: "ideviceinfo", reason: "timeout", pid: 1234 });
    expect(logLines.some((l) => l.startsWith("error|") && l.includes("ideviceinfo did not exit"))).toBe(true);

    // A second stuck kill of the same tool in the same stretch: logged, not re-sent.
    const b = fakeChild("never", 1235);
    killIphoneToolTree(asChild(b), { tool: "ideviceinfo", reason: "timeout" });
    jest.advanceTimersByTime(KILL_EXIT_BACKSTOP_MS);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    // A different tool is its own stretch.
    const c = fakeChild("never", 1236);
    killIphoneToolTree(asChild(c), { tool: "idevice_id", reason: "timeout" });
    jest.advanceTimersByTime(KILL_EXIT_BACKSTOP_MS);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it("the stretch resets when a supervised tool of that name exits on its own", () => {
    setPlatform("darwin");
    killIphoneToolTree(asChild(fakeChild("never")), { tool: "ideviceinfo", reason: "timeout" });
    jest.advanceTimersByTime(KILL_EXIT_BACKSTOP_MS);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    const healthy = fakeChild("never", 2000);
    superviseIphoneTool(asChild(healthy), { tool: "ideviceinfo", onTimeout: jest.fn() });
    healthy.exitCode = 0;
    healthy.emit("exit", 0, null);

    killIphoneToolTree(asChild(fakeChild("never", 2001)), { tool: "ideviceinfo", reason: "timeout" });
    jest.advanceTimersByTime(KILL_EXIT_BACKSTOP_MS);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it("a kill that worked reports nothing", () => {
    setPlatform("darwin");
    killIphoneToolTree(asChild(fakeChild("suspended")), { tool: "ideviceinfo", reason: "timeout" });
    jest.advanceTimersByTime(KILL_EXIT_BACKSTOP_MS * 2);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("superviseIphoneTool", () => {
  it("C1/C2: at the limit it calls onTimeout (the site settles) and THEN kills the process", () => {
    setPlatform("darwin");
    const proc = fakeChild("suspended");
    const onTimeout = jest.fn(() => expect(proc.kill).not.toHaveBeenCalled());
    superviseIphoneTool(asChild(proc), { tool: "ideviceinfo", onTimeout });
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("abort kills the process and calls onAbort; the timer is then dead", () => {
    setPlatform("darwin");
    const proc = fakeChild("suspended");
    const ac = new AbortController();
    const onTimeout = jest.fn();
    const onAbort = jest.fn();
    superviseIphoneTool(asChild(proc), { tool: "ideviceinfo", signal: ac.signal, onTimeout, onAbort });
    ac.abort();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(onAbort).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("done() before the limit: no kill, no onTimeout", () => {
    const proc = fakeChild("suspended");
    const onTimeout = jest.fn();
    const sup = superviseIphoneTool(asChild(proc), { tool: "idevicepair", onTimeout });
    sup.done();
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("C11: killAllIphoneTools stops every live supervised query, and only those", () => {
    setPlatform("darwin");
    const a = fakeChild("suspended", 1);
    const b = fakeChild("suspended", 2);
    const gone = fakeChild("suspended", 3);
    superviseIphoneTool(asChild(a), { tool: "ideviceinfo", onTimeout: jest.fn() });
    superviseIphoneTool(asChild(b), { tool: "idevice_id", onTimeout: jest.fn() });
    superviseIphoneTool(asChild(gone), { tool: "idevicepair", onTimeout: jest.fn() });
    gone.exitCode = 0;
    gone.emit("close", 0, null);
    expect(__liveIphoneToolCountForTests()).toBe(2);

    expect(killAllIphoneTools("app-quit")).toBe(2);
    expect(a.kill).toHaveBeenCalledWith("SIGKILL");
    expect(b.kill).toHaveBeenCalledWith("SIGKILL");
    expect(gone.kill).not.toHaveBeenCalled();
    expect(__liveIphoneToolCountForTests()).toBe(0);
  });
});
