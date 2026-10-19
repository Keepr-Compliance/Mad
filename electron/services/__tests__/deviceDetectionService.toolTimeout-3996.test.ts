/**
 * BACKLOG-3996: the iPhone queries in DeviceDetectionService have a time limit, are
 * killed when it runs out, and the storage query stops on Cancel.
 *
 * The real DeviceDetectionService; `spawn` replaced. Every fake child carries pid,
 * exitCode and signalCode (null while alive) and, like a real STOPPED process
 * (plan probe P1a), ignores SIGTERM and only exits on SIGKILL. The suite runs as
 * darwin, so the kill is POSIX SIGKILL; what Windows issues is pinned in
 * iphoneToolProcess-3996.test.ts.
 */
import { EventEmitter } from "events";

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: jest.fn(),
}));
jest.mock("electron", () => ({ app: { isPackaged: false } }));
const logLines: string[] = [];
jest.mock("electron-log", () => ({
  info: (...a: unknown[]) => logLines.push(`info|${a.map(String).join(" ")}`),
  warn: (...a: unknown[]) => logLines.push(`warn|${a.map(String).join(" ")}`),
  error: (...a: unknown[]) => logLines.push(`error|${a.map(String).join(" ")}`),
  debug: jest.fn(),
}));
jest.mock("@sentry/electron/main", () => ({ captureMessage: jest.fn(), addBreadcrumb: jest.fn() }));
jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn((name: string) => name),
  canUseLibimobiledevice: jest.fn(() => true),
  isMockMode: jest.fn(() => false),
}));

import { DeviceDetectionService } from "../deviceDetectionService";
import {
  IPHONE_QUERY_TIMEOUT_MS,
  __liveIphoneToolCountForTests,
  __resetIphoneToolProcessForTests,
  killAllIphoneTools,
} from "../iphoneToolProcess";

const UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  args: string[];
  kill = jest.fn((signal?: string) => {
    this.killed = true;
    if (signal === "SIGKILL") {
      this.signalCode = "SIGKILL";
      this.emit("exit", null, "SIGKILL");
      this.emit("close", null, "SIGKILL");
    }
    return true;
  });
  constructor(pid: number, args: string[]) {
    super();
    this.pid = pid;
    this.args = args;
  }
  /** A normal exit with output. */
  answer(code: number, stdout = "") {
    if (stdout) this.stdout.emit("data", Buffer.from(stdout));
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

let children: FakeChild[] = [];
/** `held`: tool names whose spawn never answers. Everything else answers per `answers`. */
let held = new Set<string>();
let answers: Record<string, { code: number; stdout?: string }> = {};
let nextPid = 100;

function child(tool: string): FakeChild | undefined {
  return children.find((c) => c.args[0] === tool);
}

const flush = () => new Promise<void>((r) => jest.requireActual<typeof import("timers")>("timers").setImmediate(r));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  __resetIphoneToolProcessForTests();
  logLines.length = 0;
  children = [];
  held = new Set();
  answers = { "--version": { code: 0, stdout: "idevice_id 1.4.0\n" } };
  mockSpawn.mockReset().mockImplementation((cmd: string, args: string[]) => {
    const proc = new FakeChild(nextPid++, [cmd, ...args]);
    children.push(proc);
    const key = args.includes("--version") ? "--version" : cmd;
    if (!held.has(key)) {
      const a = answers[key] ?? { code: 0 };
      void Promise.resolve().then(() => proc.answer(a.code, a.stdout));
    }
    return proc;
  });
});
afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
});

describe("E: storage query (the incident)", () => {
  it("C1/C2: a query that never answers resolves null at 90 s, reports the time-out, and is KILLED", async () => {
    held.add("ideviceinfo");
    const onTimeout = jest.fn();
    let settled = false;
    let value: unknown = "pending";
    void new DeviceDetectionService()
      .getDeviceStorageInfo(UDID, { onTimeout })
      .then((v) => {
        settled = true;
        value = v;
      });
    await flush();
    const proc = child("ideviceinfo")!;
    expect(proc).toBeDefined();

    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS - 1);
    await flush();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    await flush();
    expect(settled).toBe(true);
    expect(value).toBeNull();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // The likely wrong fix is "stop waiting, leave it running". The kill is asserted.
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(proc.signalCode).toBe("SIGKILL");
    // 3422's instrument still records the killed process's close.
    expect(logLines.some((l) => l.includes("[STORAGE-QUERY]") && l.includes("signal=SIGKILL"))).toBe(true);
    expect(__liveIphoneToolCountForTests()).toBe(0);
  });

  it("a normal answer is unchanged and not killed", async () => {
    answers.ideviceinfo = { code: 0, stdout: "TotalDataCapacity: 100\nTotalDataAvailable: 40\n" };
    const onTimeout = jest.fn();
    const v = await new DeviceDetectionService().getDeviceStorageInfo(UDID, { onTimeout });
    expect(v).not.toBeNull();
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(child("ideviceinfo")!.kill).not.toHaveBeenCalled();
  });

  it("C3: Cancel (abort) kills the query at once and resolves null without a time-out", async () => {
    held.add("ideviceinfo");
    const ac = new AbortController();
    const onTimeout = jest.fn();
    const pending = new DeviceDetectionService().getDeviceStorageInfo(UDID, { signal: ac.signal, onTimeout });
    await flush();
    const proc = child("ideviceinfo")!;
    ac.abort();
    await expect(pending).resolves.toBeNull();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("B: device listing", () => {
  it("R6: a timed-out listing is UNKNOWN (ok:false -> probe null), never 'no devices', and it is killed", async () => {
    held.add("idevice_id");
    const svc = new DeviceDetectionService();
    let probe: string[] | null | "pending" = "pending";
    void svc.probeConnectedUdids().then((v) => (probe = v));
    await flush();
    await flush();
    const proc = children.find((c) => c.args[0] === "idevice_id" && c.args[1] === "-l")!;
    expect(proc).toBeDefined();
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS);
    await flush();
    // null is "unknown": the disconnect confirm leaves a running backup alone
    // (deviceSyncOrchestrator.failedSyncCleanup-3598, "idevice_id cannot answer").
    // An empty array would read as "unplugged" and cancel it.
    expect(probe).toBeNull();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("C12: a held listing no longer stops device polling for the session", async () => {
    held.add("idevice_id");
    const svc = new DeviceDetectionService();
    const poll = (svc as unknown as { pollDevices: () => Promise<void> }).pollDevices.bind(svc);
    void poll();
    await flush();
    await flush();
    const listings = () => children.filter((c) => c.args[1] === "-l").length;
    expect(listings()).toBe(1);
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS);
    await flush();
    await flush();
    expect((svc as unknown as { isPolling: boolean }).isPolling).toBe(false);
    void poll();
    await flush();
    await flush();
    expect(listings()).toBe(2);
    // Logged once per session, not per poll.
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS);
    await flush();
    expect(logLines.filter((l) => l.includes("idevice_id -l did not answer")).length).toBe(1);
  });
});

describe("A: the availability check", () => {
  it("spawns idevice_id --version with no shell; a time-out is unavailable for THIS check only", async () => {
    held.add("--version");
    const svc = new DeviceDetectionService();
    let first: boolean | "pending" = "pending";
    void svc.checkLibimobiledeviceAvailable().then((v) => (first = v));
    await flush();
    expect(mockSpawn).toHaveBeenCalledWith("idevice_id", ["--version"], expect.anything());
    const proc = child("idevice_id")!;
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS);
    await flush();
    expect(first).toBe(false);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

    // Not cached: the next check runs the probe again and can succeed.
    held.delete("--version");
    await expect(svc.checkLibimobiledeviceAvailable()).resolves.toBe(true);
    expect(children.filter((c) => c.args.includes("--version")).length).toBe(2);
  });
});

describe("C: device info", () => {
  it("rejects with a time-out message that carries no trust-state string, and kills it", async () => {
    held.add("ideviceinfo");
    const pending = new DeviceDetectionService().getDeviceInfo(UDID);
    const caught = pending.catch((e: Error) => e);
    await flush();
    const proc = child("ideviceinfo")!;
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS);
    const err = (await caught) as Error;
    expect(err.message).toMatch(/timed out/);
    for (const s of ["Password protected", "Pairing dialog response pending", "Could not connect to lockdownd"]) {
      expect(err.message).not.toContain(s);
    }
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("D: pairing", () => {
  it("resolves error 'timeout' and kills it", async () => {
    held.add("idevicepair");
    const pending = new DeviceDetectionService().pairDevice(UDID);
    await flush();
    const proc = child("idevicepair")!;
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ success: false, needsTrust: false, error: "timeout" });
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("C11: quit stops every abandoned query (A, B, C, D, E at once)", () => {
  it("killAllIphoneTools reaches each site's process", async () => {
    held = new Set(["--version", "idevice_id", "ideviceinfo", "idevicepair"]);
    const svc = new DeviceDetectionService();
    void svc.checkLibimobiledeviceAvailable();
    void svc.getDeviceInfo(UDID).catch(() => undefined);
    void svc.pairDevice(UDID);
    void svc.getDeviceStorageInfo(UDID);
    await flush();
    // B needs availability first: let a second service answer --version.
    held.delete("--version");
    const svc2 = new DeviceDetectionService();
    void svc2.probeConnectedUdids();
    await flush();
    await flush();
    await flush();
    held.add("--version");

    const live = children.filter((c) => c.exitCode === null && c.signalCode === null);
    const sites = live.map((c) => c.args.slice(0, 2).join(" ")).sort();
    expect(sites).toEqual([
      "idevice_id --version",
      "idevice_id -l",
      "ideviceinfo -u",
      "ideviceinfo -u",
      "idevicepair pair",
    ]);
    expect(killAllIphoneTools("app-quit")).toBe(5);
    for (const c of live) expect(c.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
