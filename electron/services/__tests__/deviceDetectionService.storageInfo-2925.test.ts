/**
 * BACKLOG-2925, second pass — the producer half. A device that reports no capacity is
 * unknown, not a device with no storage.
 *
 * ## What this pins
 *
 * `parseStorageInfo` looked up four field names and ended every lookup with `|| "0"`,
 * so output carrying none of them produced
 * `{totalCapacity: 0, availableSpace: 0, usedSpace: 0, estimatedBackupSize: 0}` — an
 * assertion that the iPhone has no storage at all. That object reached the disk guard
 * on the founder's 2026-08-27 run, where `0 x 1.5 = 0` cleared 15 GB of free space and
 * the app announced "Disk space check passed" for a backup that had measured 58.8 GB.
 *
 * ## What the log establishes, and what it does not
 *
 * The raw stdout of that run was never captured — the raw-fields line is `log.debug`
 * and his build records nothing below `info`. What IS established, and forced by the
 * code path rather than inferred: `parseStorageInfo` runs ONLY when the process exits
 * 0, and the run logged its parsed result, so **the query exited 0 and its output did
 * not carry the required keys**. These fixtures encode exactly that property and
 * nothing more — the minimal instances of it. WHY the keys were absent is not
 * established (see the item; the leading unproven candidate is that the device was
 * locked, since the backup asked for a passcode five seconds later), and the `keysSeen`
 * warning added alongside this change is what will settle it on the next occurrence.
 */

import { EventEmitter } from "events";

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: jest.fn(),
}));

const logLines: string[] = [];
jest.mock("electron-log", () => ({
  info: (...args: unknown[]) => logLines.push(args.map(String).join(" ")),
  warn: (...args: unknown[]) => logLines.push(args.map(String).join(" ")),
  error: (...args: unknown[]) => logLines.push(args.map(String).join(" ")),
  debug: jest.fn(),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn(() => "/nonexistent/ideviceinfo"),
  canUseLibimobiledevice: jest.fn(() => true),
  isMockMode: jest.fn(() => false),
}));

import { DeviceDetectionService } from "../deviceDetectionService";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

/**
 * Drives `getDeviceStorageInfo` against a stubbed `ideviceinfo` that exits `code` after
 * emitting `stdout`.
 */
async function queryStorage(stdout: string, code = 0, stderr = "") {
  logLines.length = 0;
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  mockSpawn.mockReset().mockReturnValue(proc);

  const service = new DeviceDetectionService();
  const pending = service.getDeviceStorageInfo(TEST_UDID);

  await Promise.resolve();
  if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
  if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
  proc.emit("close", code);

  const result = await pending;
  service.stop();
  return { result, lines: [...logLines] };
}

/**
 * A real `ideviceinfo -q com.apple.disk_usage` reply, transcribed in shape from the
 * domain's documented fields. Sizes are round numbers, not a real device's.
 */
const HEALTHY_OUTPUT = [
  "AmountDataAvailable: 96636764160",
  "AmountDataReserved: 209715200",
  "TotalDataAvailable: 96636764160",
  "TotalDataCapacity: 128849018880",
  "TotalDiskCapacity: 137438953472",
  "TotalSystemAvailable: 1073741824",
  "TotalSystemCapacity: 5368709120",
  "",
].join("\n");

describe("BACKLOG-2925: an unreadable device is unknown, not empty", () => {
  it("CONTROL — exit 0 with none of the capacity fields yields UNKNOWN, not zeros", async () => {
    // The founder's case, reduced to the property the log establishes: the process
    // succeeded and the keys were not there.
    const { result } = await queryStorage("", 0);

    expect(result).toBeNull();
  });

  it("does not report a device with 0 bytes of capacity under any parse", async () => {
    // The pre-fix return value, stated as the thing that must never come back again.
    const forbidden = {
      totalCapacity: 0,
      availableSpace: 0,
      usedSpace: 0,
      estimatedBackupSize: 0,
    };
    for (const output of ["", "\n", "ERROR: Could not connect to lockdownd\n", "Unrelated: 5\n"]) {
      const { result } = await queryStorage(output, 0);
      expect(result).not.toEqual(forbidden);
      expect(result).toBeNull();
    }
  });

  it("refuses a HALF-answer: capacity present, available absent", async () => {
    // Validity is a predicate on the FIELDS, not on the final number. Checking only
    // `estimatedBackupSize > 0` would accept this as `used = total`, i.e. a phone
    // reported 100% full — wrong, and wrong in the direction that reads as a LARGER
    // backup, which no guard would ever question.
    const { result } = await queryStorage("TotalDataCapacity: 128849018880\n", 0);

    expect(result).toBeNull();
  });

  it("refuses an impossible answer: more available than capacity", async () => {
    const { result } = await queryStorage(
      ["TotalDataCapacity: 1000", "TotalDataAvailable: 2000", ""].join("\n"),
      0,
    );

    expect(result).toBeNull();
  });

  it("refuses a non-numeric answer instead of parsing it to NaN", async () => {
    // `parseInt("(null)")` is NaN, and `NaN > 0` is false — indistinguishable from a
    // genuine zero at every later `> 0` test.
    const { result } = await queryStorage(
      ["TotalDataCapacity: (null)", "TotalDataAvailable: (null)", ""].join("\n"),
      0,
    );

    expect(result).toBeNull();
  });

  it("COUNTER-CONTROL — a healthy reply is still parsed and still estimates", async () => {
    // Without this, "return null always" would pass every test above.
    const { result } = await queryStorage(HEALTHY_OUTPUT, 0);

    expect(result).not.toBeNull();
    expect(result?.totalCapacity).toBe(128849018880);
    expect(result?.availableSpace).toBe(96636764160);
    expect(result?.usedSpace).toBe(128849018880 - 96636764160);
    // 0.25 x used space — the UNVALIDATED ratio (BACKLOG-2896), unchanged by this item.
    expect(result?.estimatedBackupSize).toBe(Math.round((128849018880 - 96636764160) * 0.25));
  });

  it("logs the key names it DID see, at a level the founder's build records", async () => {
    // The half-2 instrumentation. `log.debug` recorded nothing on the one run that
    // mattered, so the diagnostic that would name the cause is emitted at warn.
    const { lines } = await queryStorage("SomeOtherKey: 1\n", 0, "lockdownd said no\n");

    const warn = lines.find((l) => l.includes("carried no usable capacity"));
    expect(warn).toBeDefined();
    expect(warn).toContain("SomeOtherKey");
    // stderr is surfaced because the exit code already told us nothing: the failing
    // run exited 0, so this is the only place a lockdownd complaint can be seen.
    const stderrLine = lines.find((l) => l.includes("Storage query exited 0"));
    expect(stderrLine).toContain("lockdownd said no");
  });

  it("a NON-zero exit is still its own path and still yields null", async () => {
    const { result, lines } = await queryStorage("", 1, "No device found\n");

    expect(result).toBeNull();
    expect(lines.some((l) => l.includes("Failed to get storage info"))).toBe(true);
    expect(lines.some((l) => l.includes("Storage query exited 0"))).toBe(false);
  });
});
