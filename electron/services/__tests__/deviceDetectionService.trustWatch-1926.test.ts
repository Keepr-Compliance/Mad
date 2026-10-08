/**
 * BACKLOG-1926: while a plugged-in iPhone is locked or showing the Trust
 * dialog, DeviceDetectionService checks it with `idevicepair validate` once a
 * second and reports each step (locked -> Trust dialog -> trusted) instead of
 * waiting out the 8 s back-off from BACKLOG-1627.
 *
 * FIXTURES ARE TRANSCRIBED, NOT INVENTED:
 * - idevicepair lines: `strings -a resources/win/libimobiledevice/idevicepair.exe`
 *   (the shipped Windows producer; byte-identical to libimobiledevice 1.4.0
 *   tools/idevicepair.c), `%s` replaced by the fake UDID below. All on stdout.
 *   Windows variants end in CRLF (INFERRED: the exe prints in text mode, see
 *   BACKLOG-2908 handoff), macOS/Homebrew in LF.
 * - ideviceinfo lines: `ERROR: Could not connect to lockdownd: %s (%d)`
 *   (ideviceinfo.c) with lockdownd_strerror "Password protected" (-17) /
 *   "Pairing dialog response pending" (-19), literals present in the shipped
 *   imobiledevice.dll (BACKLOG-2908 checkpoint Q2).
 */
import { EventEmitter } from "events";

const mockSpawn = jest.fn();
const mockExec = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: (...args: unknown[]) => mockExec(...args),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: (name: string) => name,
  canUseLibimobiledevice: () => true,
}));

const mockApp: { runningUnderARM64Translation?: boolean } = {};
jest.mock("electron", () => ({ app: mockApp }));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import {
  DeviceDetectionService,
  parsePairState,
  TRUST_WATCH_MAX_ATTEMPTS,
} from "../deviceDetectionService";

const UDID = "00008030-001A2B3C4D5E6F70";

// --- transcribed producer output -------------------------------------------
const PAIR_PASSCODE_SET = `ERROR: Could not validate with device ${UDID} because a passcode is set. Please enter the passcode on the device and retry.\n`;
const PAIR_DIALOG_PENDING = `ERROR: Please accept the trust dialog on the screen of device ${UDID}, then attempt to pair again.\n`;
const PAIR_DENIED = `ERROR: Device ${UDID} said that the user denied the trust dialog.\n`;
const PAIR_NOT_PAIRED = `ERROR: Device ${UDID} is not paired with this host\n`;
const PAIR_NO_DEVICE = `No device found with udid ${UDID}.\n`;
const PAIR_SUCCESS_PAIRED = `SUCCESS: Paired with device ${UDID}\n`;
const PAIR_SUCCESS_VALIDATED = `SUCCESS: Validated pairing with device ${UDID}\n`;
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

const INFO_LOCKED = "ERROR: Could not connect to lockdownd: Password protected (-17)\n";
const INFO_PENDING = "ERROR: Could not connect to lockdownd: Pairing dialog response pending (-19)\n";
const INFO_OK = "DeviceName: Test iPhone\nProductType: iPhone14,2\nProductVersion: 17.0\nSerialNumber: TESTSERIAL01\n";

// --- scripted processes -----------------------------------------------------
type Run = { stdout?: string; stderr?: string; code: number };

let attached: string[] = [];
let infoRuns: Run[] = [];
let pairRuns: Run[] = [];
let openPairProcs = 0;
let maxOpenPairProcs = 0;

function fakeProcess(run: Run, onClose?: () => void) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (run.stdout) proc.stdout.emit("data", Buffer.from(run.stdout));
    if (run.stderr) proc.stderr.emit("data", Buffer.from(run.stderr));
    onClose?.();
    proc.emit("close", run.code);
  }, 50);
  return proc;
}

function spawnImpl(cmd: string, args: string[]) {
  if (cmd === "idevice_id") {
    return fakeProcess({ stdout: attached.map((u) => `${u}\n`).join(""), code: 0 });
  }
  if (cmd === "ideviceinfo") {
    // Unscripted probes repeat the last scripted outcome.
    const run = infoRuns.length > 1 ? infoRuns.shift()! : infoRuns[0];
    return fakeProcess(run);
  }
  if (cmd === "idevicepair") {
    openPairProcs += 1;
    maxOpenPairProcs = Math.max(maxOpenPairProcs, openPairProcs);
    // Only the trust loop and the one-shot auto-pair spawn idevicepair. The
    // one-shot uses "pair"; the loop uses "validate". Script only the loop.
    const run =
      args[0] === "validate"
        ? pairRuns.length > 1
          ? pairRuns.shift()!
          : pairRuns[0]
        : { stdout: PAIR_DIALOG_PENDING, code: 1 };
    return fakeProcess(run, () => {
      openPairProcs -= 1;
    });
  }
  throw new Error(`unexpected spawn ${cmd}`);
}

const validateCalls = () =>
  mockSpawn.mock.calls.filter(
    (c) => c[0] === "idevicepair" && (c[1] as string[])[0] === "validate",
  ).length;

describe("parsePairState (BACKLOG-1926) — transcribed idevicepair output", () => {
  it.each([
    ["passcode set (LF)", PAIR_PASSCODE_SET, 1, "locked"],
    ["passcode set (CRLF)", crlf(PAIR_PASSCODE_SET), 1, "locked"],
    ["trust dialog pending (LF)", PAIR_DIALOG_PENDING, 1, "trust_pending"],
    ["trust dialog pending (CRLF)", crlf(PAIR_DIALOG_PENDING), 1, "trust_pending"],
    ["denied", PAIR_DENIED, 1, "denied"],
    ["no device", PAIR_NO_DEVICE, 1, "gone"],
    ["paired (LF)", PAIR_SUCCESS_PAIRED, 0, "trusted"],
    ["paired (CRLF)", crlf(PAIR_SUCCESS_PAIRED), 0, "trusted"],
    ["validated", PAIR_SUCCESS_VALIDATED, 0, "trusted"],
    ["not paired with this host", PAIR_NOT_PAIRED, 1, "other"],
    ["SUCCESS text with a failing exit code", PAIR_SUCCESS_PAIRED, 1, "other"],
    ["empty", "", 1, "other"],
  ] as const)("%s", (_label, output, code, expected) => {
    expect(parsePairState(output, code)).toBe(expected);
  });
});

describe("DeviceDetectionService trust loop (BACKLOG-1926)", () => {
  let service: DeviceDetectionService;
  let states: string[];
  let connected: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    delete process.env.MOCK_DEVICE;
    attached = [UDID];
    infoRuns = [{ stderr: INFO_LOCKED, code: 1 }];
    pairRuns = [{ stdout: PAIR_PASSCODE_SET, code: 1 }];
    openPairProcs = 0;
    maxOpenPairProcs = 0;
    mockSpawn.mockImplementation(spawnImpl);
    mockExec.mockImplementation((...args: unknown[]) => {
      const cb = (typeof args[1] === "function" ? args[1] : args[2]) as (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void;
      cb(null, { stdout: "1.3.0", stderr: "" });
    });
    service = new DeviceDetectionService();
    states = [];
    connected = [];
    service.on("device-trust-state", (d: { udid: string; state: string }) => states.push(d.state));
    service.on("device-connected", (d: { name: string }) => connected.push(d.name));
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  it("locked -> Trust dialog -> trusted: each step is reported within ~1 s and the phone connects", async () => {
    pairRuns = [
      { stdout: PAIR_PASSCODE_SET, code: 1 },
      { stdout: PAIR_DIALOG_PENDING, code: 1 },
      { stdout: PAIR_SUCCESS_PAIRED, code: 0 },
    ];
    service.start(2000);

    // First poll: idevice_id + ideviceinfo (locked) -> loop starts.
    await jest.advanceTimersByTimeAsync(200);
    expect(states).toEqual(["locked"]);
    // After the probe failed, the device info probe answers OK from now on.
    infoRuns = [{ stdout: INFO_OK, code: 0 }];

    // Tick 1 (~1.05 s): still locked.
    await jest.advanceTimersByTimeAsync(1100);
    expect(states).toEqual(["locked"]);
    // Tick 2: dialog is up.
    await jest.advanceTimersByTimeAsync(1100);
    expect(states).toEqual(["locked", "trust_pending"]);
    // Tick 3: paired -> trusted, then device info -> connected.
    await jest.advanceTimersByTimeAsync(1100);
    await jest.advanceTimersByTimeAsync(200);
    expect(states).toEqual(["locked", "trust_pending", "trusted"]);
    expect(connected).toEqual(["Test iPhone"]);

    // Loop is over: no more validate spawns.
    const after = validateCalls();
    await jest.advanceTimersByTimeAsync(5000);
    expect(validateCalls()).toBe(after);
  });

  it("probe sees the Trust dialog first: the loop starts in trust_pending", async () => {
    infoRuns = [{ stderr: INFO_PENDING, code: 1 }];
    pairRuns = [{ stdout: crlf(PAIR_DIALOG_PENDING), code: 1 }];
    service.start(2000);
    await jest.advanceTimersByTimeAsync(200);
    expect(states).toEqual(["trust_pending"]);
    await jest.advanceTimersByTimeAsync(3 * 1100);
    expect(states).toEqual(["trust_pending"]);
    expect(validateCalls()).toBeGreaterThanOrEqual(3);
  });

  it("PASSCODE_SET is a state to keep watching, not an error to stop on", async () => {
    pairRuns = [{ stdout: crlf(PAIR_PASSCODE_SET), code: 1 }];
    service.start(2000);
    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(5 * 1100);
    // Five more 1 s checks happened while the phone stayed locked.
    expect(validateCalls()).toBeGreaterThanOrEqual(5);
    expect(states).toEqual(["locked"]);
  });

  it("the poll does not probe ideviceinfo for a device the loop owns", async () => {
    service.start(2000);
    await jest.advanceTimersByTimeAsync(200);
    const infoCalls = () => mockSpawn.mock.calls.filter((c) => c[0] === "ideviceinfo").length;
    const before = infoCalls();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(infoCalls()).toBe(before);
  });

  it("one idevicepair process at a time", async () => {
    service.start(2000);
    await jest.advanceTimersByTimeAsync(10_000);
    // The one-shot auto-pair (today's behaviour) may overlap the first poll,
    // but the loop never runs two of its own at once.
    expect(maxOpenPairProcs).toBeLessThanOrEqual(2);
    const validateTimes = mockSpawn.mock.invocationCallOrder.filter(
      (_o, i) => mockSpawn.mock.calls[i][0] === "idevicepair" && (mockSpawn.mock.calls[i][1] as string[])[0] === "validate",
    ).length;
    // ~1 per second over 10 s, never more.
    expect(validateTimes).toBeLessThanOrEqual(10);
    expect(validateTimes).toBeGreaterThanOrEqual(8);
  });

  it("unplugged: the loop stops and the state is cleared", async () => {
    service.start(2000);
    await jest.advanceTimersByTimeAsync(200);
    expect(states).toEqual(["locked"]);

    attached = [];
    pairRuns = [{ stdout: PAIR_NO_DEVICE, code: 1 }];
    await jest.advanceTimersByTimeAsync(2500);
    expect(states).toEqual(["locked", "cleared"]);

    const after = validateCalls();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(validateCalls()).toBe(after);
  });

  it("unplugged between checks (seen only by the idevice_id poll): the loop stops", async () => {
    service.start(2000);
    await jest.advanceTimersByTimeAsync(200);
    attached = [];
    // idevicepair keeps answering "locked" — only the poll can see the unplug.
    await jest.advanceTimersByTimeAsync(2500);
    expect(states).toEqual(["locked", "cleared"]);
    const after = validateCalls();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(validateCalls()).toBe(after);
  });

  it("Don't Trust: the loop stops and reports declined; re-plugging starts over", async () => {
    pairRuns = [{ stdout: PAIR_DENIED, code: 1 }];
    service.start(2000);
    await jest.advanceTimersByTimeAsync(1500);
    expect(states).toEqual(["locked", "denied"]);
    const after = validateCalls();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(validateCalls()).toBe(after);

    // Unplug, plug back in, phone locked again -> watched again.
    attached = [];
    await jest.advanceTimersByTimeAsync(2100);
    expect(states).toEqual(["locked", "denied", "cleared"]);
    attached = [UDID];
    pairRuns = [{ stdout: PAIR_PASSCODE_SET, code: 1 }];
    await jest.advanceTimersByTimeAsync(2100 + 1100);
    expect(states).toEqual(["locked", "denied", "cleared", "locked"]);
    expect(validateCalls()).toBeGreaterThan(after);
  });

  it("stop() (detection turned off, BACKLOG-3418) ends the loop and leaves no timers", async () => {
    service.start(2000);
    await jest.advanceTimersByTimeAsync(1200);
    expect(validateCalls()).toBeGreaterThanOrEqual(1);

    service.stop();
    await jest.advanceTimersByTimeAsync(200); // let an in-flight check finish
    const after = validateCalls();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(validateCalls()).toBe(after);
  });

  it("caps the loop and does not restart it while the phone stays plugged in", async () => {
    service.start(2000);
    await jest.advanceTimersByTimeAsync((TRUST_WATCH_MAX_ATTEMPTS + 30) * 1100);
    expect(validateCalls()).toBe(TRUST_WATCH_MAX_ATTEMPTS);
  });

  it("Windows on ARM (BACKLOG-3363): no loop, no idevicepair", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mockApp.runningUnderARM64Translation = true;
    try {
      service.start(2000);
      await jest.advanceTimersByTimeAsync(5000);
      expect(validateCalls()).toBe(0);
      expect(states).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
      delete mockApp.runningUnderARM64Translation;
    }
  });
});
