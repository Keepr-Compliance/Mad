/**
 * BACKLOG-3422 — the storage query says how long it took and whether it ever answered.
 *
 * ## What this pins, and what it deliberately does not
 *
 * On 2026-09-17 `ideviceinfo -q com.apple.disk_usage` returned **empty stdout, empty
 * stderr, exit 0** after 60.036s, and again after 60.047s. Nothing in the code recorded
 * any of that: the 60s was recovered by subtracting two unrelated log timestamps by eye,
 * and the success path logged no duration at all, so there was no baseline to compare a
 * stall against. Replicated on demand the same spawn answers in 40-60ms, 16/16 runs.
 *
 * The founder's decision (2026-09-17) is **instrument only** — no timeout, no retry, on
 * the measured ground that the condition persisted at least 4m37s across both attempts,
 * so a bounded retry would have failed too. These tests therefore assert on LOG OUTPUT
 * and on nothing else. None of them claims to know why the query stalls; that is
 * MECHANISM UNTRACED in the item and stays that way.
 *
 * ## The pair that matters
 *
 * `neverAnswered` and `answeredWithNothing` below are the same observable event as far
 * as the pre-3422 log was concerned: exit 0, no usable capacity. They have different
 * causes and different fixes. `firstByteMs` and `elapsedMs` are what separate them, and
 * the test named for that pair fails if either field is dropped.
 */

import { EventEmitter } from "events";

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: jest.fn(),
}));

/**
 * Lines are recorded WITH THEIR LEVEL, and the level is asserted.
 *
 * This matters more than it looks. The most likely wrong implementation of this item is
 * a correct line emitted at `log.debug` — which reads as shipped, passes any assertion
 * on the text, and records nothing at all in the founder's build (BACKLOG-2925
 * established that his build captures nothing below `info`; it is why the keysSeen
 * warning sits at warn). A mock that flattens the levels cannot see that, so this one
 * does not flatten them.
 */
const logLines: string[] = [];
const record = (level: string) => (...args: unknown[]) =>
  logLines.push(`${level}|${args.map(String).join(" ")}`);
jest.mock("electron-log", () => ({
  info: record("info"),
  warn: record("warn"),
  error: record("error"),
  debug: record("debug"),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn(() => "/nonexistent/ideviceinfo"),
  canUseLibimobiledevice: jest.fn(() => true),
  isMockMode: jest.fn(() => false),
}));

import { DeviceDetectionService, deviceLogTag } from "../deviceDetectionService";

/** A syntactically valid 40-hex UDID. Not a real device's. */
const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";
/** A second one, to prove the log tag distinguishes two phones. */
const OTHER_UDID = "ffeeddccbbaa99887766554433221100aabbccdd";

/** The grep tag the founder reads this instrument by. */
const TAG = "[STORAGE-QUERY]";

interface QueryOptions {
  /** stdout chunks, emitted in order. */
  stdout?: string[];
  /** stderr chunks, emitted in order. */
  stderr?: string[];
  /** Wall-clock ms to burn between spawn and close, via fake timers. */
  stallMs?: number;
  /** Ms to burn BEFORE the first stdout chunk. */
  delayBeforeOutputMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  udid?: string;
}

/**
 * Drives the real `getDeviceStorageInfo` against a stubbed child process, on fake
 * timers so the elapsed values it reports are exact rather than whatever the machine
 * happened to take. Verified separately that `jest.advanceTimersByTime(n)` moves
 * `Date.now()` by exactly `n` under this repo's jest config; the 60s test below would
 * fail loudly if it ever stopped doing so.
 */
async function runQuery(opts: QueryOptions = {}) {
  const {
    stdout = [],
    stderr = [],
    stallMs = 0,
    delayBeforeOutputMs = 0,
    exitCode = 0,
    signal = null,
    udid = TEST_UDID,
  } = opts;

  logLines.length = 0;
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  mockSpawn.mockReset().mockReturnValue(proc);

  const service = new DeviceDetectionService();
  const pending = service.getDeviceStorageInfo(udid);

  // Let the promise executor run so the spawn and its listeners exist.
  await Promise.resolve();

  if (delayBeforeOutputMs) jest.advanceTimersByTime(delayBeforeOutputMs);
  for (const chunk of stdout) proc.stdout.emit("data", Buffer.from(chunk));
  for (const chunk of stderr) proc.stderr.emit("data", Buffer.from(chunk));
  if (stallMs) jest.advanceTimersByTime(stallMs);
  proc.emit("close", exitCode, signal);

  const result = await pending;
  service.stop();
  return { result, lines: [...logLines] };
}

/**
 * The one instrument line for a run. Asserted to exist exactly once AND to have been
 * emitted at `info` — a line the founder's build does not record is not an instrument.
 */
function timingLine(lines: string[]): string {
  const matches = lines.filter((l) => l.includes(TAG) && !l.includes("start device="));
  expect(matches).toHaveLength(1);
  expect(matches[0].split("|")[0]).toBe("info");
  return matches[0];
}

/** Reads `name=value` off the instrument line. */
function field(line: string, name: string): string {
  const match = new RegExp(`\\b${name}=(\\S+)`).exec(line);
  expect(match).not.toBeNull();
  return match![1];
}

/**
 * A real `ideviceinfo -q com.apple.disk_usage` reply, in shape. Sizes are round
 * numbers, not a real device's.
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

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-3422: the storage query reports its own duration and whether it answered", () => {
  it("HEALTHY — reports a short elapsed, a first byte, the byte count and exit 0", async () => {
    const { result, lines } = await runQuery({
      stdout: [HEALTHY_OUTPUT],
      delayBeforeOutputMs: 57,
      stallMs: 3,
    });

    // The instrument must not have disturbed the thing it instruments.
    expect(result).not.toBeNull();
    expect(result?.totalCapacity).toBe(128849018880);

    const line = timingLine(lines);
    expect(field(line, "elapsedMs")).toBe("60");
    expect(field(line, "firstByteMs")).toBe("57");
    expect(field(line, "exitCode")).toBe("0");
    expect(field(line, "signal")).toBe("none");
    expect(field(line, "stdoutBytes")).toBe(String(Buffer.byteLength(HEALTHY_OUTPUT)));
    expect(field(line, "stderrBytes")).toBe("0");
  });

  it("THE FOUNDER'S SIGNATURE — 60s, nothing on either stream, exit 0", async () => {
    // Transcribed from his log rather than invented: 12:53:27.753 -> 12:54:27.789 and
    // 12:57:04.621 -> 12:58:04.668, both `keysSeen=[] lines=1 stderrBytes=0`, exit 0.
    // Before this change the ONLY trace of it was the keysSeen warning, which says
    // nothing about time and cannot distinguish a stall from a prompt empty answer.
    const { result, lines } = await runQuery({ stallMs: 60036 });

    expect(result).toBeNull();

    const line = timingLine(lines);
    expect(field(line, "elapsedMs")).toBe("60036");
    expect(field(line, "firstByteMs")).toBe("none");
    expect(field(line, "exitCode")).toBe("0");
    expect(field(line, "stdoutBytes")).toBe("0");
    expect(field(line, "stderrBytes")).toBe("0");
  });

  it("THE PAIR — a stall and a prompt empty answer are now different lines", async () => {
    // Both are exit 0 and both end at the same keysSeen warning. Their causes are not
    // the same and neither are their fixes, so the log has to separate them.
    const neverAnswered = timingLine((await runQuery({ stallMs: 60036 })).lines);
    const answeredWithNothing = timingLine(
      (await runQuery({ stdout: ["CalculateDiskUsage: OkilyDokily\n"], stallMs: 41 })).lines,
    );

    // Same observable outcome...
    expect(field(neverAnswered, "exitCode")).toBe(field(answeredWithNothing, "exitCode"));

    // ...distinguished on both fields, independently. Either one alone would do it
    // here, and both are asserted so that removing either is red.
    expect(field(neverAnswered, "firstByteMs")).toBe("none");
    expect(field(answeredWithNothing, "firstByteMs")).toBe("0");
    expect(Number(field(neverAnswered, "elapsedMs"))).toBeGreaterThan(
      Number(field(answeredWithNothing, "elapsedMs")) * 100,
    );
    expect(field(neverAnswered, "stdoutBytes")).toBe("0");
    expect(Number(field(answeredWithNothing, "stdoutBytes"))).toBeGreaterThan(0);
  });

  it("a non-zero exit is still recorded, with its stderr size", async () => {
    const { result, lines } = await runQuery({
      stderr: ["ERROR: Could not connect to lockdownd, error code -3\n"],
      exitCode: 1,
      stallMs: 12,
    });

    expect(result).toBeNull();
    const line = timingLine(lines);
    expect(field(line, "exitCode")).toBe("1");
    expect(field(line, "elapsedMs")).toBe("12");
    expect(Number(field(line, "stderrBytes"))).toBeGreaterThan(0);
  });

  it("a SIGNALLED kill is named, not disguised as exit null", async () => {
    // The close handler took only `(code)` before this change, so a signalled child
    // arrived as `code=null`, went down the non-zero branch with an empty stderr, and
    // was indistinguishable from several other things.
    const { lines } = await runQuery({ exitCode: null, signal: "SIGTERM", stallMs: 30000 });

    const line = timingLine(lines);
    expect(field(line, "signal")).toBe("SIGTERM");
    expect(field(line, "exitCode")).toBe("null");
    expect(field(line, "elapsedMs")).toBe("30000");
  });

  it("a start line is emitted at a level the founder's build records", async () => {
    // The one case the close line cannot cover: a `close` that never fires. A start
    // line with no [STORAGE-QUERY] line after it is itself a diagnosis.
    const { lines } = await runQuery({ stdout: [HEALTHY_OUTPUT] });

    const start = lines.find((l) => l.includes(TAG) && l.includes("start device="));
    expect(start).toBeDefined();
    expect(start!.split("|")[0]).toBe("info");
    expect(start).toContain(deviceLogTag(TEST_UDID));
  });

  it("PRIVACY — no line carries the UDID or any recognisable run of it", async () => {
    // This repo is public and these logs get pasted into issues.
    const { lines } = await runQuery({ stdout: [HEALTHY_OUTPUT], stderr: ["noise\n"] });
    const joined = lines.join("\n");

    expect(joined).not.toContain(TEST_UDID);
    // Every 8-character window of the UDID, so a truncated-prefix "fix" is also red.
    for (let i = 0; i + 8 <= TEST_UDID.length; i++) {
      expect(joined).not.toContain(TEST_UDID.slice(i, i + 8));
    }
    // ...and the tag really is on the line, so this is not passing by logging nothing.
    expect(joined).toContain(`device=${deviceLogTag(TEST_UDID)}`);
  });

  it("the device tag is stable per phone and different across phones", async () => {
    const first = timingLine((await runQuery({ stallMs: 5 })).lines);
    const second = timingLine((await runQuery({ stallMs: 9 })).lines);
    const other = timingLine((await runQuery({ udid: OTHER_UDID, stallMs: 5 })).lines);

    expect(field(first, "device")).toBe(field(second, "device"));
    expect(field(first, "device")).not.toBe(field(other, "device"));
    expect(field(first, "device")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("COUNTER-CONTROL — the instrument did not change what the query returns", async () => {
    // Without this, "log everything and return null" would pass every test above.
    const healthy = await runQuery({ stdout: [HEALTHY_OUTPUT] });
    const empty = await runQuery({});
    const failed = await runQuery({ exitCode: 1, stderr: ["No device found\n"] });

    expect(healthy.result).toEqual({
      totalCapacity: 128849018880,
      availableSpace: 96636764160,
      usedSpace: 128849018880 - 96636764160,
      estimatedBackupSize: Math.round((128849018880 - 96636764160) * 0.25),
    });
    expect(empty.result).toBeNull();
    expect(failed.result).toBeNull();
    // The BACKLOG-2925 warning still fires on the empty run — this change adds a line,
    // it does not replace one.
    expect(empty.lines.some((l) => l.includes("carried no usable capacity"))).toBe(true);
  });
});
