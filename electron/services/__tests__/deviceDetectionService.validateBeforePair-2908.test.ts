/**
 * BACKLOG-2908 — check the existing pairing before pairing again.
 *
 * ## The defect
 *
 * `pairDevice()` ran `idevicepair pair`, which always makes a NEW pairing (a new host
 * identity). The auto-pair branch in `pollDevices` called it for every device whose
 * `ideviceinfo` probe failed, whatever the reason — so a phone that was only locked, or
 * already showing "Trust This Computer?", was paired again, and the person was asked to
 * Trust a computer the phone already trusted.
 *
 * ## What this pins
 *
 * - `validate` runs first. Exit 0 → done, `pair` never runs.                    (a)
 * - `validate` says "not paired with this host" (the phone forgot this computer,
 *   Apple's 30-day expiry) → `pair` runs exactly once.                          (b)
 * - `locked` / `trust_pending` from the probe → neither validate nor pair runs. (c)
 * - The Windows build's output escalates exactly like 1.4.0's.                  (d)
 * - The most likely WRONG implementation — escalate on ANY non-zero validate exit —
 *   is caught: a locked phone, a pending or denied dialog, a lockdownd connection
 *   failure and a vanished device all exit 1 too, and none of them may pair.     (e)
 *
 * ## Fixtures are transcribed, not written from memory
 *
 * idevicepair (libimobiledevice 1.4.0, `tools/idevicepair.c`, fetched with
 * `gh api repos/libimobiledevice/libimobiledevice/contents/tools/idevicepair.c?ref=1.4.0`).
 * Every result line is `printf`, so it is on STDOUT; handled errors exit EXIT_FAILURE (1):
 *   :454  SUCCESS: Validated pairing with device %s          (exit 0, :413)
 *   :442  SUCCESS: Paired with device %s                     (exit 0)
 *   :118  ERROR: Could not validate with device %s because a passcode is set. Please enter the passcode on the device and retry.
 *   :122  ERROR: Device %s is not paired with this host       (-2 / -21)
 *   :125  ERROR: Please accept the trust dialog on the screen of device %s, then attempt to pair again.
 *   :128  ERROR: Device %s said that the user denied the trust dialog.
 *   :408  ERROR: Could not connect to lockdownd, error code %d
 *   :374  No device found with udid %s.
 *   :456  result = EXIT_FAILURE; print_error_message(lerr);   (validate failure)
 *
 * Windows: `strings -a resources/win/libimobiledevice/idevicepair.exe` shows the same
 * format strings, byte for byte (its message set matches 1.3.0's `print_error_message`,
 * `tools/idevicepair.c:43-55`). What differs is the line terminator: the exe prints
 * through the MSVC UCRT (`api-ms-win-crt-stdio-l1-1-0.dll`, `__stdio_common_vfprintf`)
 * and imports no `_setmode`, so stdout is in text mode and `\n` goes out as `\r\n`.
 * The CRLF is INFERRED from that, not measured on a Windows machine.
 *
 * ideviceinfo (1.4.0): `tools/ideviceinfo.c:225`
 *   fprintf(stderr, "ERROR: Could not connect to lockdownd: %s (%d)\n", lockdownd_strerror(ldret), ldret);
 *   then `return -1` (:227) → exit 255. Error names from `src/lockdown.c:69/71/73`
 *   ("Password protected", "Pairing dialog response pending", "Invalid HostID"), codes
 *   from `include/libimobiledevice/lockdown.h:56/58/60` (-17 / -19 / -21).
 *
 * No real device is involved. The UDID is a syntactically valid 40-hex string, not a
 * real device's.
 */

import { EventEmitter } from "events";

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: jest.fn(),
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// getCommand returns the bare name, as it does on macOS — so the spawn mock can
// dispatch on it.
jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn((name: string) => name),
  canUseLibimobiledevice: jest.fn(() => true),
  isMockMode: jest.fn(() => false),
}));

import { DeviceDetectionService } from "../deviceDetectionService";

/** A syntactically valid 40-hex UDID. Not a real device's. */
const UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

/** One scripted child process: what it prints and how it exits. */
interface Scripted {
  code: number;
  stdout?: string;
  stderr?: string;
}

// ---- idevicepair, libimobiledevice 1.4.0 (LF) ------------------------------------
const VALIDATED = `SUCCESS: Validated pairing with device ${UDID}\n`; // :454
const PAIRED = `SUCCESS: Paired with device ${UDID}\n`; // :442
const NOT_PAIRED = `ERROR: Device ${UDID} is not paired with this host\n`; // :122
const PASSCODE_SET = `ERROR: Could not validate with device ${UDID} because a passcode is set. Please enter the passcode on the device and retry.\n`; // :118
const TRUST_PENDING = `ERROR: Please accept the trust dialog on the screen of device ${UDID}, then attempt to pair again.\n`; // :125
const USER_DENIED = `ERROR: Device ${UDID} said that the user denied the trust dialog.\n`; // :128
const LOCKDOWND_MUX_ERROR = `ERROR: Could not connect to lockdownd, error code -8\n`; // :408, LOCKDOWN_E_MUX_ERROR = -8 (lockdown.h:46)
const NO_DEVICE = `No device found with udid ${UDID}.\n`; // :374

// ---- idevicepair.exe, bundled Windows build: same format strings, CRLF -------------
const crlf = (line: string) => line.replace(/\n$/, "\r\n");
const WIN_NOT_PAIRED = crlf(NOT_PAIRED);
const WIN_PAIRED = crlf(PAIRED);
const WIN_VALIDATED = crlf(VALIDATED);
const WIN_PASSCODE_SET = crlf(PASSCODE_SET);
const WIN_TRUST_PENDING = crlf(TRUST_PENDING);

// ---- ideviceinfo stderr, 1.4.0 ideviceinfo.c:225, exit 255 -------------------------
const INFO_LOCKED = "ERROR: Could not connect to lockdownd: Password protected (-17)\n";
const INFO_TRUST_PENDING = "ERROR: Could not connect to lockdownd: Pairing dialog response pending (-19)\n";
const INFO_INVALID_HOST_ID = "ERROR: Could not connect to lockdownd: Invalid HostID (-21)\n";

/**
 * Scripts `spawn` by `<command> <first arg>`. A queue of more than one entry is consumed
 * in order; the last entry repeats. An unscripted spawn exits 127 and is still recorded in
 * mockSpawn.mock.calls, so a harness gap shows up as a failed assertion instead of a hang.
 */
function scriptSpawn(script: Record<string, Scripted | Scripted[]>) {
  const queues = new Map<string, Scripted[]>(
    Object.entries(script).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );
  mockSpawn.mockReset().mockImplementation((cmd: string, args: string[]) => {
    const key = `${cmd} ${args[0]}`;
    const queue = queues.get(key);
    const step: Scripted =
      queue && queue.length > 0
        ? queue.length > 1
          ? (queue.shift() as Scripted)
          : queue[0]
        : { code: 127, stderr: `unscripted spawn: ${key}` };

    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // setTimeout, not setImmediate: this suite runs under jsdom, which has no setImmediate.
    setTimeout(() => {
      if (step.stdout) proc.stdout.emit("data", Buffer.from(step.stdout));
      if (step.stderr) proc.stderr.emit("data", Buffer.from(step.stderr));
      proc.emit("close", step.code);
    }, 0);
    return proc;
  });
}

/** The idevicepair operations spawned, in order — e.g. ["validate", "pair"]. */
function idevicepairOps(): string[] {
  return mockSpawn.mock.calls
    .filter(([cmd]) => cmd === "idevicepair")
    .map(([, args]) => (args as string[])[0]);
}

/** Every idevicepair spawn targets the device it was asked about, via -u. */
function expectAllIdevicepairCallsTargetUdid() {
  for (const [cmd, args] of mockSpawn.mock.calls) {
    if (cmd === "idevicepair") expect((args as string[]).slice(1)).toEqual(["-u", UDID]);
  }
}

/** The commands spawned, in order — e.g. ["idevice_id", "ideviceinfo", "idevicepair"]. */
function spawnedCommands(): string[] {
  return mockSpawn.mock.calls.map(([cmd]) => cmd as string);
}

/** Lets fire-and-forget work (pollDevices → pairDevice → validate → pair) run out. */
async function flush(turns = 20) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Runs one real poll with one device listed and the given ideviceinfo failure. */
async function pollOnceWithProbeFailure(
  service: DeviceDetectionService,
  infoStderr: string,
  validate: Scripted[] = [{ code: 0, stdout: VALIDATED }],
  pair: Scripted[] = [{ code: 0, stdout: PAIRED }],
) {
  scriptSpawn({
    "idevice_id -l": { code: 0, stdout: `${UDID}\n` },
    "ideviceinfo -u": { code: 255, stderr: infoStderr },
    "idevicepair validate": validate,
    "idevicepair pair": pair,
  });
  await service["pollDevices"]();
  await flush();
}

describe("BACKLOG-2908: pairDevice checks the existing pairing before pairing again", () => {
  let service: DeviceDetectionService;

  beforeEach(() => {
    service = new DeviceDetectionService();
  });

  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
  });

  // (a)
  it("(a) trusted phone: validate exits 0, pair is never spawned", async () => {
    scriptSpawn({
      "idevicepair validate": { code: 0, stdout: VALIDATED },
      "idevicepair pair": { code: 0, stdout: PAIRED },
    });

    const result = await service.pairDevice(UDID);

    expect(idevicepairOps()).toEqual(["validate"]);
    expectAllIdevicepairCallsTargetUdid();
    expect(result).toEqual({ success: true, needsTrust: false });
  });

  // (b)
  it("(b) host forgotten: validate says 'not paired with this host', pair is spawned exactly once", async () => {
    scriptSpawn({
      "idevicepair validate": { code: 1, stdout: NOT_PAIRED },
      "idevicepair pair": { code: 0, stdout: PAIRED },
    });

    const result = await service.pairDevice(UDID);

    expect(idevicepairOps()).toEqual(["validate", "pair"]);
    expectAllIdevicepairCallsTargetUdid();
    expect(result).toEqual({ success: true, needsTrust: false });
  });

  it("(b) host forgotten and the new pairing is waiting on Trust: reports needsTrust, pairs once", async () => {
    scriptSpawn({
      "idevicepair validate": { code: 1, stdout: NOT_PAIRED },
      "idevicepair pair": { code: 1, stdout: TRUST_PENDING },
    });

    const result = await service.pairDevice(UDID);

    expect(idevicepairOps()).toEqual(["validate", "pair"]);
    expect(result).toEqual({ success: false, needsTrust: true });
  });

  // (e) — the most likely wrong implementation: escalate on ANY non-zero validate exit.
  it.each([
    ["passcode set (-17)", PASSCODE_SET],
    ["trust dialog pending (-19)", TRUST_PENDING],
    ["user denied the dialog (-18)", USER_DENIED],
    ["lockdownd connection failed (mux error -8)", LOCKDOWND_MUX_ERROR],
    ["device gone", NO_DEVICE],
    ["Windows: passcode set (-17)", WIN_PASSCODE_SET],
    ["Windows: trust dialog pending (-19)", WIN_TRUST_PENDING],
  ])("(e) validate exits 1 with '%s': pair is NOT spawned", async (_label, stdout) => {
    scriptSpawn({
      "idevicepair validate": { code: 1, stdout },
      "idevicepair pair": { code: 0, stdout: PAIRED },
    });

    const result = await service.pairDevice(UDID);

    expect(idevicepairOps()).toEqual(["validate"]);
    expect(result.success).toBe(false);
  });

  it("(e) a pending or denied dialog still reports needsTrust; a passcode or connection failure reports an error", async () => {
    const outcomes: Array<{ success: boolean; needsTrust: boolean; error?: string }> = [];
    for (const stdout of [TRUST_PENDING, USER_DENIED, PASSCODE_SET, LOCKDOWND_MUX_ERROR]) {
      scriptSpawn({ "idevicepair validate": { code: 1, stdout } });
      outcomes.push(await service.pairDevice(UDID));
    }

    expect(outcomes).toEqual([
      { success: false, needsTrust: true },
      { success: false, needsTrust: true },
      { success: false, needsTrust: false, error: PASSCODE_SET.trim() },
      { success: false, needsTrust: false, error: LOCKDOWND_MUX_ERROR.trim() },
    ]);
  });

  // (d)
  it("(d) Windows build (CRLF): 'not paired with this host' escalates to pair exactly once", async () => {
    scriptSpawn({
      "idevicepair validate": { code: 1, stdout: WIN_NOT_PAIRED },
      "idevicepair pair": { code: 0, stdout: WIN_PAIRED },
    });

    const result = await service.pairDevice(UDID);

    expect(idevicepairOps()).toEqual(["validate", "pair"]);
    expectAllIdevicepairCallsTargetUdid();
    expect(result).toEqual({ success: true, needsTrust: false });
  });

  it("(d) Windows build (CRLF): a trusted phone is not paired again", async () => {
    scriptSpawn({
      "idevicepair validate": { code: 0, stdout: WIN_VALIDATED },
      "idevicepair pair": { code: 0, stdout: WIN_PAIRED },
    });

    const result = await service.pairDevice(UDID);

    expect(idevicepairOps()).toEqual(["validate"]);
    expect(result).toEqual({ success: true, needsTrust: false });
  });

  it("a validate that cannot be spawned does not fall through to pair", async () => {
    mockSpawn.mockReset().mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => proc.emit("error", new Error("spawn idevicepair ENOENT")), 0);
      return proc;
    });

    const result = await service.pairDevice(UDID);

    expect(idevicepairOps()).toEqual(["validate"]);
    expect(result).toEqual({ success: false, needsTrust: false, error: "spawn idevicepair ENOENT" });
  });
});

describe("BACKLOG-2908: the auto-pair branch in pollDevices", () => {
  let service: DeviceDetectionService;
  let needsTrust: Array<{ udid: string; reason?: string }>;

  beforeEach(() => {
    service = new DeviceDetectionService();
    jest.spyOn(service, "checkLibimobiledeviceAvailable").mockResolvedValue(true);
    needsTrust = [];
    service.on("device-needs-trust", (data: { udid: string; reason?: string }) => needsTrust.push(data));
  });

  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
  });

  // (c)
  it.each([
    ["locked", INFO_LOCKED],
    ["trust_pending", INFO_TRUST_PENDING],
  ])("(c) probe reports '%s': neither validate nor pair is spawned; the existing guidance event fires", async (reason, stderr) => {
    await pollOnceWithProbeFailure(service, stderr);

    // The poll really reached the probe — an empty idevicepair list is not vacuous.
    expect(spawnedCommands()).toEqual(["idevice_id", "ideviceinfo"]);
    expect(idevicepairOps()).toEqual([]);
    expect(needsTrust).toEqual([{ udid: UDID, reason }]);
  });

  // (c) positive control: the same harness DOES see a validate-first attempt when the
  // probe fails for the reason that genuinely needs one (the phone forgot this host).
  it("(c) probe reports 'Invalid HostID (-21)' (reason unknown): validate runs, then pair once", async () => {
    await pollOnceWithProbeFailure(service, INFO_INVALID_HOST_ID, [{ code: 1, stdout: NOT_PAIRED }]);

    expect(idevicepairOps()).toEqual(["validate", "pair"]);
    expectAllIdevicepairCallsTargetUdid();
    expect(needsTrust).toEqual([{ udid: UDID, reason: "unknown" }]);
  });

  it("(c) a probe that fails with a trusted pairing validates once and does not pair", async () => {
    await pollOnceWithProbeFailure(service, INFO_INVALID_HOST_ID, [{ code: 0, stdout: VALIDATED }]);

    expect(idevicepairOps()).toEqual(["validate"]);
  });

  it("a phone first seen locked still gets its one validate-first attempt once the probe fails another way", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    await pollOnceWithProbeFailure(service, INFO_LOCKED);
    expect(idevicepairOps()).toEqual([]);

    // Past the 8s trust back-off, the phone now answers "Invalid HostID".
    now.mockReturnValue(1_000_000 + 9_000);
    await pollOnceWithProbeFailure(service, INFO_INVALID_HOST_ID, [{ code: 1, stdout: NOT_PAIRED }]);

    expect(idevicepairOps()).toEqual(["validate", "pair"]);
  });
});
