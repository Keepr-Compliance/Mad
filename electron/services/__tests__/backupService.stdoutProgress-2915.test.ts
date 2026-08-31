/**
 * BACKLOG-2915 — THE CONTROL MATRIX FOR "DROP `-d`, PARSE STDOUT".
 *
 * ## Where these fixtures come from
 *
 * Every byte below is TRANSCRIBED from a live capture taken on 2026-08-30 with the
 * founder's explicit go-ahead: a 20-minute `idevicebackup2` run against his real
 * device on iOS 26.6, spawned with `stdio: ["pipe","pipe","pipe"]` exactly as
 * `backupService.ts` spawns it, against an APFS clone of his real backup directory so
 * the incremental path was exercised and his data was never touched. Device
 * identifiers were replaced with `<UDID>` at capture time. The artefacts live outside
 * any git repo at `~/Developer/keepr-captures/2915/`: 6,114,951 bytes of stdout, a
 * 10 MB per-chunk timestamped event log, and 11 bytes of stderr.
 *
 * Nothing here is invented. Where a fixture could NOT be taken from that run it says
 * so on the row, because the project rule is that a fixture standing in for a real
 * producer must come from that producer.
 *
 * Numbers re-derived from the capture by execution, not by eye:
 *
 *   76,024 byte renders + 37 overall renders = 76,061 renders
 *   76,000 stdout chunks, 61 of them carrying more than one render, 0 beginning
 *          mid-render
 *   36 distinct per-batch totals, from 63.5 KB to 10.5 GB
 *   16 renders carrying `Bytes` in the numerator; 0 with `Bytes` as a denominator and
 *          0 with `TB` anywhere — those two are SOURCE-verified only, and row 7 says so
 *   564.219 s of total two-stream silence before the first byte arrived
 *   11 bytes of stderr in the whole run, all of it `Exiting...` caused by our SIGTERM
 *   13.1 s from SIGTERM to the process closing, with the outcome in the final flush
 *
 * ## What each row is for
 *
 * Every `it` names the mutation that must turn it RED, and several run that mutation
 * as their own case rather than describing it. A green check carries no information
 * until it has been made to fail on purpose; the observed red results are recorded on
 * BACKLOG-2915.
 */

import { EventEmitter } from "events";
import type { BackupResult, BackupProgress } from "../../types/backup";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

const mockSpawn = jest.fn();

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
    exec: jest.fn(),
  })),
);

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/mock/userData"), isPackaged: false },
}));

const mockLog = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock("electron-log", () => ({
  default: mockLog,
  info: (...a: unknown[]) => mockLog.info(...a),
  debug: (...a: unknown[]) => mockLog.debug(...a),
  warn: (...a: unknown[]) => mockLog.warn(...a),
  error: (...a: unknown[]) => mockLog.error(...a),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    access: jest.fn().mockRejectedValue(new Error("Not found")),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("no"), { code: "ENOENT" })),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue("<plist></plist>"),
  },
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

import {
  BackupService,
  classifyBackupFailure,
  BACKUP_DEVICE_LOCKED_MESSAGE,
  BACKUP_CONNECTION_LOST_MESSAGE,
  BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE,
  BACKUP_STOPPED_STILL_CONNECTED_MESSAGE,
  BACKUP_SERVICE_UNAVAILABLE_MESSAGE,
  BACKUP_HOST_DISK_FULL_MESSAGE,
} from "../backupService";

// ===========================================================================
// FIXTURES — transcribed from ~/Developer/keepr-captures/2915/
// ===========================================================================

/**
 * The capture's FIRST stdout chunk, byte for byte: 826 bytes delivered in one read at
 * t=564.219 s, carrying eleven lines that `idevicebackup2` had printed across the
 * preceding 9.4 minutes. (The backup directory path is the only thing shortened, and
 * it was the harness's temp directory, not the founder's.)
 *
 * It is the whole argument for the emit policy in one buffer. Read in order it goes
 * `Requesting backup` (preparing) -> mode -> passcode -> four `Sending` -> a
 * `0% Finished` render -> `Receiving files` -> a byte render — so a per-line emitter
 * would drive the UI to `preparing` AFTER it had reached `transferring`, inside a
 * single tick, because these lines did not happen at the times they arrived.
 *
 * The trailing byte render is deliberately unterminated: that is how it came off the
 * pipe. Renders carry no newline; they are terminated by the NEXT render's `\r`.
 */
const FIRST_CHUNK =
  'Backup directory is "/tmp/cap-backups"\n' +
  'Started "com.apple.mobilebackup2" service on port 50794.\n' +
  "Negotiated Protocol Version 2.1\n" +
  "Reading Info.plist from backup.\n" +
  "Starting backup...\n" +
  "Backup will be unencrypted.\n" +
  "Requesting backup from device...\n" +
  "Incremental backup mode.\n" +
  "*** Waiting for passcode to be entered on the device ***\n" +
  "Sending '<UDID>/Status.plist' (189 Bytes)\n" +
  "Sending '<UDID>/Manifest.plist' (530.8 KB)\n" +
  "Sending '<UDID>/Manifest.db' (869.3 MB)\n" +
  "Sending '<UDID>/Status.plist' (189 Bytes)\n" +
  "\r[=                                                 ]   0% Finished\n" +
  "Receiving files\n" +
  "\r[=                                                 ]   1% (262.1 KB/50.8 MB)     ";

/**
 * The capture's final 148-byte flush, arriving 13.1 s after our SIGTERM and carrying
 * the entire outcome of the run. This is the buffer the old 5-second SIGKILL destroyed.
 */
const FINAL_ABORT_FLUSH =
  "\n" +
  "Discarding current data hunk.\n" +
  "\r[===============================================   ]  94% Finished\n" +
  "Received 4604 files from device.\n" +
  "Backup Aborted.\n";

/** 50 cells, `%3.0f` percent, and the five trailing spaces `progress_printf` emits. */
function byteRender(percent: number, current: string, total: string): string {
  const cells = Math.max(1, Math.round((percent / 100) * 50));
  const bar = "=".repeat(cells) + " ".repeat(50 - cells);
  return `\r[${bar}] ${String(percent).padStart(3, " ")}% (${current}/${total})     `;
}

/** The overall render. Newline-terminated, from `printf(" Finished\n")` at :2525. */
function overallRender(percent: number): string {
  const cells = Math.max(1, Math.round((percent / 100) * 50));
  const bar = "=".repeat(cells) + " ".repeat(50 - cells);
  return `\r[${bar}] ${String(percent).padStart(3, " ")}% Finished\n`;
}

/**
 * The 2026-08-27 failure block, transcribed in `backupService.ts` from the founder's
 * dev log. All of it is stdout, all of it is `printf`, none of it depended on `-d`.
 */
function lockedDeviceStdout(withPasscodeLine: boolean): string {
  return (
    "Requesting backup from device...\n" +
    "Incremental backup mode.\n" +
    (withPasscodeLine
      ? "*** Waiting for passcode to be entered on the device ***\n"
      : "") +
    "ErrorCode 208: Device locked (MBErrorDomain/208)\n" +
    "Received 0 files from device.\n" +
    "Backup Failed (Error Code 208).\n"
  );
}

/** ~80 KB of renders — more than the 65,536-byte `stdoutBuffer` cap. */
function renderFlood(minBytes = 80_000): string {
  let filler = "";
  while (filler.length < minBytes) {
    filler += byteRender(50, "25.0 MB", "50.8 MB");
  }
  return filler;
}

// ===========================================================================
// HARNESS
// ===========================================================================

/**
 * A child process the test drives.
 *
 * `exitCode` / `signalCode` are modelled because the kill-path fix reads them, and
 * `killed` is modelled because the guard it replaces read THAT. `kill()` on its own
 * does not end a process — it delivers a signal — and node sets `.killed` to true the
 * moment any signal is delivered successfully, which is why `if (!proc.killed)` could
 * never gate an escalation that runs after a SIGTERM.
 */
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  kill = jest.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });

  /** The process actually exits. */
  close(code: number | null): void {
    this.exitCode = code;
    this.emit("close", code);
  }
}

/** Arms `spawn` with a script for the next backup. Use when you drive the service yourself. */
function spawnScripted(script: (proc: FakeProcess) => void): void {
  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.close(0);
      }, 0);
    } else {
      setTimeout(() => script(proc), 0);
    }
    return proc;
  });
}

/** Runs one backup to completion and returns the result plus every progress event. */
async function runBackup(script: (proc: FakeProcess) => void): Promise<{
  result: BackupResult;
  progress: BackupProgress[];
  service: BackupService;
}> {
  const service = new BackupService();
  const progress: BackupProgress[] = [];
  service.on("progress", (p: BackupProgress) => progress.push(p));
  service.on("error", () => {
    /* asserted through the resolved result, not here */
  });

  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.close(0);
      }, 0);
    } else {
      setTimeout(() => script(proc), 0);
    }
    return proc;
  });

  const result = await service.startBackup({ udid: TEST_UDID });
  return { result, progress, service };
}

/** Starts a run WITHOUT awaiting it, for the kill-path rows. Fake timers required. */
async function startRun(): Promise<{
  service: BackupService;
  proc: FakeProcess;
  result: Promise<BackupResult>;
  progress: BackupProgress[];
  errors: Error[];
}> {
  const service = new BackupService();
  const progress: BackupProgress[] = [];
  const errors: Error[] = [];
  service.on("progress", (p: BackupProgress) => progress.push(p));
  service.on("error", (e: Error) => errors.push(e));

  let backupProc: FakeProcess | null = null;
  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.close(0);
      }, 0);
    } else {
      backupProc = proc;
    }
    return proc;
  });

  const result = service.startBackup({ udid: TEST_UDID });
  await jest.advanceTimersByTimeAsync(10);
  if (!backupProc) throw new Error("idevicebackup2 was never spawned");
  return { service, proc: backupProc, result, progress, errors };
}

/** Direct access to the parser, for the rows that are about one line or one chunk. */
function parser(): {
  service: BackupService;
  line: (l: string) => BackupProgress | null;
  chunk: (c: string) => BackupProgress | null;
} {
  const service = new BackupService();
  // `calculateOverallPercent` divides by elapsed time; without a start time the
  // snapshots carry NaN and every assertion about them would be meaningless.
  (service as unknown as { startTime: number }).startTime = Date.now();
  const s = service as unknown as {
    parseStdoutLine: (l: string) => BackupProgress | null;
    consumeStdoutChunk: (c: string) => BackupProgress | null;
  };
  return {
    service,
    line: (l) => s.parseStdoutLine(l),
    chunk: (c) => s.consumeStdoutChunk(c),
  };
}

const sentSignal = (proc: FakeProcess, signal: string): boolean =>
  proc.kill.mock.calls.some((c) => c[0] === signal);

/**
 * BACKLOG-2915: rows that assert a SIGKILL ESCALATION are POSIX-only.
 *
 * `killZombieProcess` installs its escalation timer inside
 * `if (process.platform !== "win32")`, and correctly so: on Windows node's SIGTERM is
 * `TerminateProcess`, which has already hard-killed the process, so there is nothing
 * to escalate to and no timer to observe. CI runs this suite on macOS AND Windows.
 *
 * Only the row that asserts a SIGKILL is SENT is skipped. The rows asserting a SIGKILL
 * is NOT sent, the safety-net timing, and the constant ordering all run everywhere,
 * because none of them depends on that timer existing.
 */
const itPosix = process.platform === "win32" ? it.skip : it;

/** Advances fake time in steps so intervals get a chance to run. */
async function advance(totalMs: number, stepMs = 10_000): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(Math.min(stepMs, totalMs - elapsed));
  }
}

// ===========================================================================
// ROWS 1-2 — the flag, and the mode line
// ===========================================================================

describe("BACKLOG-2915 rows 1-2 — the flag is gone and the mode comes from the device", () => {
  beforeEach(() => jest.clearAllMocks());

  it('ROW 1 — the spawned argv contains no -d (mutation: re-add args.push("-d"))', async () => {
    // Asserted on the ARGV THAT WAS SPAWNED, not on `buildBackupArgs` in isolation:
    // the flag has to be absent from what the tool actually receives.
    await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.close(0);
    });

    const backupCall = mockSpawn.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("idevicebackup2"),
    );
    expect(backupCall).toBeDefined();
    const args = backupCall![1] as string[];
    expect(args).not.toContain("-d");
    expect(args).toEqual(["-u", TEST_UDID, "backup", expect.any(String)]);
  });

  it("ROW 2 — `Full backup mode.` on stdout is read as full (mutation: swap full/incremental)", async () => {
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Full backup mode.\n"));
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.close(0);
    });
    expect(result.deviceReportedBackupMode).toBe("full");
  });
});

// ===========================================================================
// ROWS 3-7, 12-14, 24 — the renders
// ===========================================================================

describe("BACKLOG-2915 rows 3-7, 12-14, 24 — reading the progress renders", () => {
  it("ROW 3 — the byte render is PER-BATCH (mutation: drop `\\r` from the splitter)", () => {
    // Driven through the chunk splitter, because the `\r` is the whole point: the
    // render carries no newline, so a splitter that only knows `\n` never completes one.
    const p = parser();
    p.chunk(byteRender(48, "24.2 MB", "50.8 MB"));
    const progress = p.chunk(byteRender(49, "24.9 MB", "50.8 MB"));

    expect(progress).not.toBeNull();
    expect(progress!.phase).toBe("transferring");
    expect(progress!.batchBytesTransferred).toBeCloseTo(24.2 * 1024 * 1024, 0);
    expect(progress!.batchTotalBytes).toBeCloseTo(50.8 * 1024 * 1024, 0);
    // And the batch total is NOT reported as the whole-run total: 36 batches ran in
    // the capture, with totals from 63.5 KB to 10.5 GB.
    expect(progress!.totalBytes).toBeNull();
  });

  it("ROW 3b — the fold happens on a TOTAL CHANGE (mutation: delete the `openBatch` call)", () => {
    // C1. The device supplies a fresh total on every `DLMessageUploadFiles`, and the
    // capture recorded 36 distinct batch totals in one run — so a changed total IS a
    // batch boundary and the previous batch's bytes belong in the run total.
    //
    // This row exists because `openBatch` and `closeBatch` are MUTUALLY REDUNDANT by
    // design: with two different totals, deleting the `Receiving files` fold still
    // leaves `openBatch` to catch the boundary. That redundancy is what made all four
    // fold mutations survive the old suite, and it is why this row deliberately drives
    // NO `Receiving files` line — it isolates `openBatch`.
    // Every render below needs the NEXT one to terminate it — a render carries no
    // newline of its own — so the parser is always one behind and the sequence runs one
    // render past the state being asserted.
    const p = parser();
    p.chunk(byteRender(48, "24.2 MB", "50.8 MB"));
    p.chunk(byteRender(99, "50.3 MB", "50.8 MB"));
    // A new batch opens: a different total, and the current restarts low.
    p.chunk(byteRender(1, "60.0 MB", "4.3 GB"));
    p.chunk(byteRender(48, "2.1 GB", "4.3 GB"));
    const progress = p.chunk(byteRender(49, "2.2 GB", "4.3 GB"));

    expect(progress).not.toBeNull();
    // The open batch is batch two…
    expect(progress!.batchBytesTransferred).toBeCloseTo(2.1 * 1024 ** 3, 0);
    expect(progress!.batchTotalBytes).toBeCloseTo(4.3 * 1024 ** 3, 0);
    // …and the RUN total is batch one's last reading PLUS it. Asserted by identity, not
    // as a floor: `bytesTransferred = current` alone would give 2.1 GB and pass any
    // `> 0` or `> batchBytesTransferred` check.
    expect(progress!.bytesTransferred).toBeCloseTo(
      50.3 * 1024 * 1024 + 2.1 * 1024 ** 3,
      0,
    );
  });

  it("ROW 3c — the fold also happens on `Receiving files` (mutation: delete that `closeBatch()`)", () => {
    // The paired isolation. Here the two batches share a total and the current RISES
    // across the boundary, so `openBatch` sees nothing to fold — only the
    // `Receiving files` line marks it. Delete that fold and the run total silently
    // becomes the current batch's, which is the exact shape of the bug this PR removes.
    //
    // SYNTHETIC in one respect, and labelled: all 36 batch totals in the capture were
    // distinct, so two consecutive batches sharing a total was not observed. The row
    // exists precisely so the boundary signal does not depend on the totals differing.
    // The trailing `\n` on the first render is `print_progress`'s own end-of-batch
    // flush, exactly as the capture shows it: `...48% (2.1 GB/4.3 GB)     <LF>` and only
    // then the next line. Without it the unterminated render and `Receiving files`
    // concatenate into one line — which is what the splitter is for, and is why the
    // fixture has to carry the real byte.
    const p = parser();
    p.chunk(byteRender(48, "24.2 MB", "50.8 MB") + "\n");
    p.chunk("Receiving files\n");
    p.chunk(byteRender(59, "30.0 MB", "50.8 MB"));
    const progress = p.chunk(byteRender(60, "30.5 MB", "50.8 MB"));

    expect(progress).not.toBeNull();
    expect(progress!.batchBytesTransferred).toBeCloseTo(30.0 * 1024 * 1024, 0);
    expect(progress!.bytesTransferred).toBeCloseTo(
      (24.2 + 30.0) * 1024 * 1024,
      0,
    );
  });

  it("ROW 3d — the run total never regresses across a whole multi-batch run", () => {
    // The invariant behind both rows above, asserted over a sequence rather than at a
    // point: `bytesTransferred` is what the founder will be looking at, and a bar that
    // walks backwards mid-sync is what the old per-file heuristic produced.
    const p = parser();
    const script = [
      byteRender(10, "5.0 MB", "50.8 MB"),
      byteRender(48, "24.2 MB", "50.8 MB") + "\n", // end-of-batch flush
      "Receiving files\n",
      byteRender(1, "262.1 KB", "4.3 GB"),
      byteRender(48, "2.1 GB", "4.3 GB") + "\n", // end-of-batch flush
      "Receiving files\n",
      byteRender(3, "79 Bytes", "64.0 KB"),
      byteRender(99, "63.5 KB", "64.0 KB"),
      byteRender(99, "63.6 KB", "64.0 KB"),
    ];

    const totals: number[] = [];
    for (const chunk of script) {
      const progress = p.chunk(chunk);
      if (progress) totals.push(progress.bytesTransferred);
    }

    expect(totals.length).toBeGreaterThan(3);
    for (let i = 1; i < totals.length; i += 1) {
      expect(totals[i]).toBeGreaterThanOrEqual(totals[i - 1]);
    }
    // And the end state is the sum of what each batch actually reached, by identity.
    expect(totals[totals.length - 1]).toBeCloseTo(
      24.2 * 1024 * 1024 + 2.1 * 1024 ** 3 + 63.5 * 1024,
      0,
    );
  });

  it("ROW 4 — `% Finished` is a DIFFERENT number (mutation: route it to the byte handler)", () => {
    // The capture's own contradiction, in two lines: the byte bar read 48% while the
    // overall bar read 94%, in the same second. Parsing them as one number is the bug.
    const p = parser();
    p.chunk(byteRender(48, "2.1 GB", "4.3 GB"));
    const progress = p.chunk(overallRender(94));

    expect(progress).not.toBeNull();
    expect(progress!.deviceOverallPercent).toBe(94);
    // The byte figures are untouched by an overall render.
    expect(progress!.batchTotalBytes).toBeCloseTo(4.3 * 1024 * 1024 * 1024, 0);
  });

  it("ROW 4b — the overall render is anchored at both ends (mutation: drop the `$`)", () => {
    // Defensive, and cheap. `Content:` (idevicebackup2.c:2508-2513) printfs arbitrary
    // DEVICE-SUPPLIED text on this stream, so neither render pattern may match a line
    // that merely starts the right way. The `^` is pinned by ROW 14/24; this is its
    // other end.
    const p = parser();
    p.chunk("\r[=      ]  42% Finished and then some device text\r");
    p.chunk(byteRender(1, "1.0 MB", "50.8 MB"));
    const after = p.chunk(byteRender(2, "2.0 MB", "50.8 MB"));
    expect(after).not.toBeNull();
    expect(after!.deviceOverallPercent).toBeNull();
  });

  it("ROW 4c — `% Finished` before any bytes move is PREPARING, not transferring", () => {
    // User-reachable. The capture's very first overall render is `0% Finished`, and it
    // arrives BEFORE `Receiving files` and before any byte render — the device is
    // reporting, nothing has been received. Collapsing this to a constant
    // `"transferring"` would report a transfer during the preparing stage, which is the
    // class of lie BACKLOG-2911 FIX 3 already had to correct once.
    const before = parser();
    const early = before.chunk(overallRender(0));
    expect(early).not.toBeNull();
    expect(early!.phase).toBe("preparing");

    // …and once bytes have actually moved, the same line is transferring.
    const after = parser();
    after.chunk(byteRender(1, "262.1 KB", "50.8 MB"));
    after.chunk(byteRender(2, "525.0 KB", "50.8 MB"));
    const later = after.chunk(overallRender(17));
    expect(later).not.toBeNull();
    expect(later!.phase).toBe("transferring");
  });

  it("ROW 5 — a render split across two chunks survives (mutation: remove the partial buffer)", () => {
    // SYNTHETIC, and labelled: 0 of the capture's 76,000 chunks began mid-render. A
    // 64 KB pipe read can produce one, so the splitter has to survive it, but this run
    // did not produce one and the fixture does not claim otherwise.
    const p = parser();
    const render = byteRender(50, "25.0 MB", "50.0 MB");
    const cut = render.indexOf("25.0") + 2;

    expect(p.chunk(render.slice(0, cut))).toBeNull(); // nothing complete yet
    const progress = p.chunk(
      render.slice(cut) + byteRender(51, "25.5 MB", "50.0 MB"),
    );

    expect(progress).not.toBeNull();
    expect(progress!.batchBytesTransferred).toBeCloseTo(25.0 * 1024 * 1024, 0);
  });

  it("ROW 6 — in a multi-render burst the LAST render wins (mutation: assert the first)", () => {
    // LIVE: 61 of the capture's chunks carried more than one render.
    const p = parser();
    let burst = "";
    for (let i = 1; i <= 12; i += 1) {
      burst += byteRender(i, `${i}.0 MB`, "50.8 MB");
    }
    const progress = p.chunk(burst + byteRender(13, "13.0 MB", "50.8 MB"));

    expect(progress).not.toBeNull();
    // 12 complete renders in the chunk; the 13th is the held partial.
    expect(progress!.batchBytesTransferred).toBeCloseTo(12 * 1024 * 1024, 0);
    expect(progress!.batchBytesTransferred).not.toBeCloseTo(1 * 1024 * 1024, 0);
  });

  it("ROW 7 — units sweep Bytes/KB/MB/GB/TB (mutation: restore the `(MB|KB|GB)` regex)", () => {
    // PROVENANCE, per row. `Bytes` in the NUMERATOR and KB/MB/GB in both positions are
    // LIVE — the capture holds 16 renders carrying `Bytes`, including
    // `(373 Bytes/20.1 MB)` and `(79 Bytes/64.0 KB)`. `Bytes` as a DENOMINATOR and `TB`
    // anywhere are SOURCE-ONLY: re-derived by execution, the capture contains 0 of
    // each. Both come from libimobiledevice-glue's `string_format_size()`, which prints
    // `%d Bytes` below 1000 and `%0.1f` KB/MB/GB/TB above it.
    const cases: Array<[string, string, number, number, string]> = [
      ["373 Bytes", "20.1 MB", 373, 20.1 * 1024 * 1024, "LIVE"],
      ["79 Bytes", "64.0 KB", 79, 64 * 1024, "LIVE"],
      ["929 Bytes", "63.6 KB", 929, 63.6 * 1024, "LIVE"],
      ["262.1 KB", "50.8 MB", 262.1 * 1024, 50.8 * 1024 * 1024, "LIVE"],
      ["2.1 GB", "4.3 GB", 2.1 * 1024 ** 3, 4.3 * 1024 ** 3, "LIVE"],
      ["512 Bytes", "900 Bytes", 512, 900, "SOURCE-ONLY"],
      ["1.5 TB", "2.0 TB", 1.5 * 1024 ** 4, 2.0 * 1024 ** 4, "SOURCE-ONLY"],
    ];

    for (const [current, total, expectCurrent, expectTotal] of cases) {
      const p = parser();
      p.chunk(byteRender(1, current, total));
      const progress = p.chunk(byteRender(2, current, total));
      expect(progress).not.toBeNull();
      expect(progress!.batchBytesTransferred).toBeCloseTo(expectCurrent, 0);
      expect(progress!.batchTotalBytes).toBeCloseTo(expectTotal, 0);
    }
  });

  it("ROW 12 — boundary 0%, right-aligned in three columns (mutation: `\\s*` -> one space)", () => {
    // `%3.0f` pads to three columns, so `]   0%` carries THREE spaces and `] 100%` one.
    const p = parser();
    const zero = byteRender(0, "373 Bytes", "20.1 MB");
    expect(zero).toContain("]   0%");
    p.chunk(zero);
    const progress = p.chunk(byteRender(1, "500 Bytes", "20.1 MB"));
    expect(progress).not.toBeNull();
    expect(progress!.batchBytesTransferred).toBe(373);
  });

  it("ROW 13 — boundary 100%, in BOTH variants (mutation: percent group `\\d{1,3}` -> `\\d{1,2}`)", () => {
    // The plan's original mutation for this row — an off-by-one in the 50-cell bar —
    // is a NON-mutation: the cell count is invisible to a `\[[^\]]*\]` regex, so it can
    // never go red. Replaced with one the parser can actually see, and which is
    // specific to the boundary this row is about: capping the percent group at two
    // digits leaves every other row green and takes only 100% down.
    //
    // The two variants are DIFFERENT BYTES and both are checked. The byte variant is
    // terminated by `print_progress`'s own fflush plus `\n`; the overall variant by
    // `printf(" Finished\n")`.
    const p = parser();
    const full = p.chunk("\r[" + "=".repeat(50) + "] 100% (50.8 MB/50.8 MB)     \n");
    expect(full).not.toBeNull();
    expect(full!.batchBytesTransferred).toBeCloseTo(50.8 * 1024 * 1024, 0);

    const p2 = parser();
    const done = p2.chunk("\r[" + "=".repeat(50) + "] 100% Finished\n");
    expect(done).not.toBeNull();
    expect(done!.deviceOverallPercent).toBe(100);
  });

  it("ROW 14 — a truncated render is not read (mutation: make the regex unanchored)", () => {
    const p = parser();
    // No closing `]`, so no render. It must not be half-parsed into a number.
    expect(p.chunk("\r[===\r")).toBeNull();
    // …and device-supplied text can never be mistaken for one. `Content:` at
    // idevicebackup2.c:2508-2513 printfs arbitrary text FROM THE DEVICE onto this exact
    // stream, so the anchor is doing real work rather than being tidy.
    expect(p.line("Content: [====] 50% (25.0 MB/50.0 MB)")).toBeNull();
  });

  it("ROW 24 — an ANSI-cursor render degrades to a no-op (mutation: drop the `^` anchor)", () => {
    // macOS bundles NO libimobiledevice binary: `getLibimobiledevicePath()` throws
    // off-Windows and `getCommand()` returns the bare name for a PATH lookup, so the
    // app runs whatever Homebrew installed. Upstream master replaced this display with
    // a four-line ANSI cursor block, and the 1.4.0 binary on this machine has ZERO ESC
    // bytes. A `brew upgrade` past that release ships a parser-breaking format to a
    // user nobody controls, so the failure has to be silent and safe rather than a
    // wrong number. This discharges the plan's "detect and degrade" without building
    // version-detection machinery.
    const p = parser();
    // `\u001b[1A` (cursor up) and `\u001b[2K` (erase line), written as escapes so no
    // raw control byte ever enters this repo.
    const ansi =
      "\u001b[1A\u001b[2K[====      ]  50% (25.0 MB/50.0 MB)";
    expect(() => p.chunk(ansi + "\r")).not.toThrow();
    expect(p.chunk(ansi + "\r")).toBeNull();
  });
});

// ===========================================================================
// ROWS 21-22 — the emit policy and the close flush
// ===========================================================================

describe("BACKLOG-2915 rows 21-22 — one emit per chunk, and the tail is not lost", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ROW 21 — a mixed-kind chunk does not walk the phase backwards (mutation: emit per line)", () => {
    // THE CAPTURE'S OWN FIRST CHUNK. Eleven lines printed across 9.4 minutes,
    // delivered in one 826-byte read, ending on an unterminated render.
    const p = parser();
    const progress = p.chunk(FIRST_CHUNK);

    expect(progress).not.toBeNull();
    // Not `preparing`, even though `Requesting backup from device...`,
    // `Sending '<UDID>/Manifest.db'` and `Starting backup...` are all in this buffer.
    expect(progress!.phase).not.toBe("preparing");
    expect(progress!.deviceOverallPercent).toBe(0);
    // One event's worth of state, not eleven: the manifest message lost to the later
    // render inside the same chunk, which is correct — by the time that message
    // arrived it was nine minutes stale.
    expect(progress!.message).toBeUndefined();
  });

  it("ROW 21b — every latch in that chunk is still set, even though one event is emitted", () => {
    const p = parser();
    p.chunk(FIRST_CHUNK);
    const state = p.service as unknown as {
      deviceReportedBackupMode: string | null;
      deviceRequestedPasscode: boolean;
      manifestUploadSize: string | null;
    };
    expect(state.deviceReportedBackupMode).toBe("incremental");
    expect(state.deviceRequestedPasscode).toBe(true);
    expect(state.manifestUploadSize).toBe("869.3 MB");
  });

  it("ROW 22 — the whole final flush is parsed, including its unterminated tail", async () => {
    // The capture's real ending, delivered as it arrived: one 148-byte read carrying
    // `Discarding current data hunk.`, a `94% Finished` render, the device's file count
    // and `Backup Aborted.` — after 13.1 seconds of unwinding that the old 5-second
    // SIGKILL never allowed.
    const { result, progress } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(FIRST_CHUNK));
      proc.stdout.emit("data", Buffer.from(FINAL_ABORT_FLUSH));
      proc.close(255);
    });

    expect(result.success).toBe(false);
    // 4,604 files — the number the DEVICE reported. The percent-drop heuristic this
    // replaced would have reported 29 for the same run: a 159x undercount.
    expect(progress.some((p) => p.filesTransferred === 4604)).toBe(true);
    // …and the device's own overall percent came off the same flush.
    expect(progress.some((p) => p.deviceOverallPercent === 94)).toBe(true);
  });

  it("ROW 22b — a line held in the partial buffer at close still classifies (mutation: remove the close-flush)", async () => {
    // SYNTHETIC, AND LABELLED. Node delivers `data` events on PIPE READ boundaries, not
    // on line boundaries, so any line can be cut in half by the last read of a run —
    // and a byte render, which carries no terminator at all, is ALWAYS left held. The
    // capture's final flush happened to arrive whole, so this exact split was not
    // observed; it is mechanically possible and the parser must not lose the tail.
    //
    // Two assertions, on the two things that are lost without it.
    //
    // (a) THE FINAL RENDER. This one is not synthetic at all — it happens on every run,
    // because a byte render carries no terminator and is therefore ALWAYS the held
    // partial when the process exits. `FIRST_CHUNK` is the capture's own first read and
    // ends exactly that way, on `1% (262.1 KB/50.8 MB)`.
    const { progress } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(FIRST_CHUNK));
      proc.close(255);
    });
    expect(
      progress.some(
        (p) =>
          p.batchBytesTransferred !== null &&
          Math.abs(p.batchBytesTransferred - 262.1 * 1024) < 1,
      ),
    ).toBe(true);

    // (b) A LATCH WITH NO BUFFER FALLBACK. `deviceReportedBackupMode` is set only by
    // the line parser — unlike the device error code, nothing re-reads it out of
    // `stdoutBuffer` at the end — so a mode line stranded in the partial buffer is
    // simply lost, and `isIncremental` silently reverts to the directory heuristic
    // whose 61.2 GB failure BACKLOG-2914 documents. THIS half is SYNTHETIC: node
    // delivers `data` on pipe-read boundaries rather than line boundaries, so the split
    // is mechanically possible, but the capture's own final flush arrived whole.
    const held = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Requesting backup from device...\n"));
      proc.stdout.emit("data", Buffer.from("Full backup mode."));
      proc.close(0);
    });
    expect(held.result.deviceReportedBackupMode).toBe("full");
  });
});

// ===========================================================================
// ROW 15 — outcome lines
// ===========================================================================

describe("BACKLOG-2915 row 15 — the three outcome lines are three different things", () => {
  beforeEach(() => jest.clearAllMocks());

  const outcomeOf = (line: string) => {
    const p = parser();
    p.chunk(line + "\n");
    return (p.service as unknown as { deviceOutcomeLine: string | null })
      .deviceOutcomeLine;
  };

  it("ROW 15 — Successful / Aborted / Failed stay distinct (mutation: collapse Aborted into Failed)", () => {
    // `Backup Successful.` was NOT observed live — the run was aborted at 20 minutes —
    // so that fixture is SYNTHETIC and BIN+SRC verified. `Backup Aborted.` IS live,
    // from the final flush; `Backup Failed (Error Code 208).` is transcribed from the
    // founder's 2026-08-27 log.
    expect(outcomeOf("Backup Successful.")).toBe("successful");
    expect(outcomeOf("Backup Aborted.")).toBe("aborted");
    expect(outcomeOf("Backup Failed (Error Code 208).")).toBe("failed");

    const distinct = new Set([
      outcomeOf("Backup Successful."),
      outcomeOf("Backup Aborted."),
      outcomeOf("Backup Failed (Error Code 208)."),
    ]);
    expect(distinct.size).toBe(3);
  });
});

describe("BACKLOG-2915 rows 15b, 25-26 — the summary code and the two numbers that change", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ROW 15b — the closing summary's code is latched when nothing richer was seen", async () => {
    // SR I3. `Backup Failed (Error Code 4).` carries the device's number and it used to
    // be discarded, so a run that printed the summary WITHOUT the per-message
    // `ErrorCode 4: <desc>` line lost its code and dropped to the inference rung — a
    // device-reported file-missing error answered with "try a different cable".
    //
    // STATED AS INFERRED, NOT ESTABLISHED: the founder's 2026-08-27 log shows the two
    // lines together for 208, and idevicebackup2 1.4.0 was not traced far enough to
    // prove they always co-occur. This closes the gap either way.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Backup Failed (Error Code 4).\n"));
      proc.close(252);
    });

    expect(result.errorCode).toBe("BACKUP_FILE_MISSING");
    expect(result.failureCause?.deviceErrorCode).toBe(4);
    expect(result.failureCause?.source).toBe("stdout-summary");
    // No description is available from the summary, and none is invented.
    expect(result.failureCause?.deviceErrorDescription).toBeNull();
  });

  it("ROW 15c — the richer `ErrorCode` line outranks the summary (mutation: latch the summary unconditionally)", async () => {
    // The ordering control. Both lines are present, as they were in the founder's real
    // 2026-08-27 block, and the one carrying the device's own words must win.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(lockedDeviceStdout(true)));
      proc.close(48);
    });

    expect(result.failureCause?.source).toBe("stdout-line");
    expect(result.failureCause?.deviceErrorDescription).toBe(
      "Device locked (MBErrorDomain/208)",
    );
  });

  it("ROW 25 — `filesTransferred` is 0 all run and then the DEVICE'S count", async () => {
    // A USER-VISIBLE CHANGE the founder should expect before he tests, and the direction
    // is DOWN for most of a sync. The old percent-drop heuristic showed a growing count
    // that was wrong — it incremented once per BATCH, so the captured run would have
    // reported 29 against the device's 4,604. There is no per-file signal on this
    // stream, so the honest answer is 0 until the device says, then its number.
    const { progress } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(FIRST_CHUNK));
      proc.stdout.emit("data", Buffer.from(byteRender(48, "24.2 MB", "50.8 MB")));
      proc.stdout.emit("data", Buffer.from(byteRender(49, "24.9 MB", "50.8 MB")));
      proc.stdout.emit("data", Buffer.from(FINAL_ABORT_FLUSH));
      proc.close(255);
    });

    const transferring = progress.filter((p) => p.phase === "transferring");
    expect(transferring.length).toBeGreaterThan(0);
    // Not one of them claims a file count while the transfer is running…
    expect(transferring.every((p) => p.filesTransferred === 0)).toBe(true);
    // …and the device's own number is what finally appears.
    expect(progress.some((p) => p.filesTransferred === 4604)).toBe(true);
  });

  it("ROW 26 — `isIncremental` now comes from the device, against the directory heuristic", async () => {
    // The second user-visible change, and it moves a Sentry tag and the value
    // `deviceService` returns. In this suite `fs.stat` rejects, so no previous backup
    // exists and the OLD derivation (`previousBackupExists && !forceFullBackup`) says
    // FALSE. The device says incremental. Before BACKLOG-2915 the device's answer was
    // read off stderr, where idevicebackup2 never writes it, so the heuristic always
    // won — including on the 61.2 GB run that it got wrong.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Incremental backup mode.\n"));
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.close(0);
    });

    expect(result.deviceReportedBackupMode).toBe("incremental");
    expect(result.isIncremental).toBe(true); // the heuristic would have said false
  });
});

// ===========================================================================
// ROWS 8-11 — 2903 and 2913 after the flag goes
// ===========================================================================

describe("BACKLOG-2915 rows 8-11 — 2903 and 2913 after the flag goes", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ROW 8 — a healthy run produces no `error pattern` warning (mutation: the same bytes on stderr)", async () => {
    // BACKLOG-2903's root cause was that `-d` put libimobiledevice's chatter on the
    // stream `classifyStderrLine` reads, where its trigger-word list fired on every
    // run — 336 records in one 21-minute log, all of them from a pthread mutex trace,
    // in a backup that SUCCEEDED. With `-d` gone that stream is empty: 11 bytes in 20
    // minutes.
    //
    // THE MUTATION IS THE STREAM, NOT THE CONTENT — and row 8b runs it.
    await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(FIRST_CHUNK));
      proc.stdout.emit("data", Buffer.from("\nBackup Successful.\n"));
      proc.close(0);
    });

    const errorPatternWarnings = mockLog.warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("error pattern"),
    );
    expect(errorPatternWarnings).toHaveLength(0);
  });

  it("ROW 8b — THE MUTATION, RUN: the identical bytes on stderr DO raise the warning", async () => {
    // Not a hypothetical. This healthy transcript contains
    // `*** Waiting for passcode ... ***`, and "passcode" is in STDERR_ERROR_WORDS — so
    // routing it to the stream `-d` used to fill makes the warning fire. Same bytes,
    // wrong stream, red. That is what proves row 8 can discriminate at all.
    await runBackup((proc) => {
      proc.stderr.emit("data", Buffer.from(FIRST_CHUNK + "\n"));
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.close(0);
    });

    const errorPatternWarnings = mockLog.warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("error pattern"),
    );
    expect(errorPatternWarnings.length).toBeGreaterThan(0);
  });

  it("ROW 9 — the transcribed 208 block still says LOCKED (mutation: anchor the message to a substring)", async () => {
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(lockedDeviceStdout(true)));
      proc.close(48);
    });
    expect(result.errorCode).toBe("DEVICE_LOCKED");
    expect(result.error).toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
    expect(result.failureCause?.deviceErrorCode).toBe(208);
    expect(result.failureCause?.source).toBe("stdout-line");
  });

  it("ROW 10 — a NON-lock failure whose output mentions the passcode is NOT locked", async () => {
    // The paired direction, and the pair is what makes either half worth running. This
    // fixture deliberately carries the passcode line — it is printed on a healthy
    // negotiation too — while the DEVICE reported code 4. Row 9's mutation (anchor the
    // lock message to a /passcode|locked/i substring over stdout instead of to the
    // code) leaves row 9 green and turns THIS red.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit(
        "data",
        Buffer.from(
          "*** Waiting for passcode to be entered on the device ***\n" +
            "ErrorCode 4: Could not find file (MBErrorDomain/4)\n" +
            "Backup Failed (Error Code 4).\n",
        ),
      );
      proc.close(252);
    });
    expect(result.errorCode).toBe("BACKUP_FILE_MISSING");
    expect(result.error).not.toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
  });

  it("ROW 11 — a locked iOS 15 device with NO passcode line is still locked (mutation: make 208 need it)", async () => {
    // SYNTHETIC and labelled. The passcode line is gated on
    // `device_version >= IDEVICE_DEVICE_VERSION(16,1,0)` AND on the device raising the
    // request inside a 20 x 100 ms race window (idevicebackup2.c:2055-2063), so a
    // locked iPhone on iOS 15 — or one that asks three seconds late — never prints it.
    // The primary anchor is and stays MBErrorDomain 208.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(lockedDeviceStdout(false)));
      proc.close(48);
    });
    expect(result.errorCode).toBe("DEVICE_LOCKED");
    expect(result.error).toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
  });
});

// ===========================================================================
// ROWS 16-20 — the classes that change when `-d` goes
// ===========================================================================

describe("BACKLOG-2915 rows 16-20 — the classes that change when `-d` goes", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ROW 16 — a link-drop shape gets the connection message (mutation: remove the inference rung)", async () => {
    // The shape a real link drop presents AFTER round 4: idevicebackup2 says its channel
    // died, nothing is on stderr because `-d` is gone, and no bytes had moved. Four of
    // the five real failures of 2026-08-27 captured ZERO stdout, and four of those five
    // carried the broken-pipe line that no longer exists — this is what replaced it.
    //
    // Round 4 note: the bare `close(255)` with NO evidence at all is no longer this
    // case. It is the inference rung, and it has its own sentence — see ROW 51.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit(
        "data",
        Buffer.from("ERROR: Could not receive from mobilebackup2 (-256)\n"),
      );
      proc.close(255);
    });
    expect(result.errorCode).toBe("CONNECTION_LOST");
    expect(result.error).toBe(BACKUP_CONNECTION_LOST_MESSAGE);
  });

  it("ROW 16b — the `transferStarted` split survives, so the mid-transfer copy still fires", async () => {
    // `hasReceivedFileProgress` is stdout-derived, so the founder's own correction of
    // 2026-08-28 — a drop after 616 MB is not a cable fault — is untouched by the flag
    // removal. Mutation: pass `false` for transferStarted and the cable sentence
    // returns, which row 16 already pins from the other side.
    // Round 4: the split lives on the OBSERVED rung now, so the fixture carries the
    // observation. Without it this is the inference rung, which has one sentence for
    // both — see ROW 51.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(byteRender(40, "246.4 MB", "616.0 MB")));
      proc.stdout.emit(
        "data",
        Buffer.from(byteRender(41, "252.5 MB", "616.0 MB") + "\n"),
      );
      proc.stdout.emit(
        "data",
        Buffer.from("ERROR: Could not receive from mobilebackup2 (-256)\n"),
      );
      proc.close(255);
    });
    expect(result.errorCode).toBe("CONNECTION_LOST");
    expect(result.error).toBe(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE);
  });

  it("ROW 16c — the broken-pipe rung is pinned, though production can no longer reach it", () => {
    // SR I1 gave a choice: pin this rung or delete it. Pinned, because deleting it
    // would also delete the only place the link-drop class is decided from EVIDENCE
    // rather than inferred — and `-d` could return for debugging.
    //
    // It is unreachable under the shipped argv: `usbmuxd_send returned -N (Broken pipe)`
    // is `debug_info()` output (src/idevice.c:643) gated on `debug_level`, which only
    // `-d` sets, and it is never printed on stdout. Measured, and the measurement is why
    // this row is written the way it is: replacing the pattern with a never-matching
    // regex leaves every OTHER test in the backup suite green, because each one now
    // reaches CONNECTION_LOST through the D1 inference rung instead.
    //
    // EXIT CODE 0 IS WHAT SEPARATES THEM. The inference rung is gated on a non-zero
    // exit, so this is the one shape where the two rungs disagree — and therefore the
    // only shape that can pin the pattern at all.
    const evidenced = classifyBackupFailure(
      0,
      "",
      "usbmuxd_send returned -32 (Broken pipe)",
    );
    expect(evidenced.errorCode).toBe("CONNECTION_LOST");
    expect(evidenced.message).toBe(BACKUP_CONNECTION_LOST_MESSAGE);

    // The discriminator: the same exit 0 with nothing to read is unexplained, not a
    // link drop. If this pair ever stopped disagreeing the row above would be measuring
    // the inference rung by accident.
    const nothing = classifyBackupFailure(0, "", "");
    expect(nothing.errorCode).toBe("UNKNOWN_ERROR");
  });

  it("ROW 17 — the inference rung is NOT lock and NOT disk-full (mutation: route it above the device switch)", () => {
    // The ordering is the whole safety property. `usbmuxd_send returned -32 (Broken
    // pipe)` was teardown chatter present in four of five real failures INCLUDING the
    // one that was genuinely a locked phone, so a connection rung above the device-code
    // switch would have told that user to change his cable.
    const locked = classifyBackupFailure(48, lockedDeviceStdout(true), "");
    expect(locked.errorCode).toBe("DEVICE_LOCKED");

    const diskFull = classifyBackupFailure(
      151,
      "ErrorCode 105: Insufficient free disk space on drive to back up (MBErrorDomain/105)\n",
      "",
    );
    expect(diskFull.errorCode).toBe("INSUFFICIENT_SPACE");
    expect(diskFull.message).toBe(BACKUP_HOST_DISK_FULL_MESSAGE);

    // And the host-side write failure that carries no device code still outranks the
    // inference rung, because it reads real evidence while the rung reads only an exit.
    const hostDisk = classifyBackupFailure(
      255,
      "Error opening '/backup/x' for writing: No space left on device\n",
      "",
    );
    expect(hostDisk.errorCode).toBe("INSUFFICIENT_SPACE");
  });

  it("ROW 17b — a CANCEL is not a link drop (mutation: drop the cancelRequested gate)", () => {
    // NOT IN THE ORIGINAL PLAN, AND IT HAS TO BE. A cancel is SIGTERM -> `clean_exit`
    // -> a normal return -> exit 255, with no device code and no version-exchange line:
    // character for character the shape the inference rung matches. Without this gate
    // every user who pressed Cancel would be told their cable had failed. Windows is no
    // better — `TerminateProcess` also exits non-zero.
    const cancelled = classifyBackupFailure(255, "", "", false, {
      cancelRequested: true,
    });
    expect(cancelled.errorCode).toBe("BACKUP_CANCELLED");
    expect(cancelled.message).not.toBe(BACKUP_CONNECTION_LOST_MESSAGE);

    // Identical inputs WITHOUT the flag are the link-drop inference. The gate is the
    // only thing separating them, which is what makes this a control and not a smoke
    // test.
    const notCancelled = classifyBackupFailure(255, "", "", false);
    expect(notCancelled.errorCode).toBe("CONNECTION_LOST");
  });

  it("ROW 18 — a version-exchange failure on STDOUT alone still classifies (mutation: delete the stdout arm)", async () => {
    // `printf("Could not perform backup protocol version exchange, error code %d\n")`
    // at idevicebackup2.c:1917 is unconditional and on stdout. Under `-d` the same
    // event ALSO appeared on stderr; that copy is gone, so the stdout arm is now the
    // only one — and it must be reached BEFORE the inference rung claims the exit.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit(
        "data",
        Buffer.from(
          "Could not perform backup protocol version exchange, error code -5\n",
        ),
      );
      proc.close(255);
    });
    expect(result.errorCode).toBe("SERVICE_UNAVAILABLE");
    expect(result.error).toBe(BACKUP_SERVICE_UNAVAILABLE_MESSAGE);
    expect(result.error).not.toBe(BACKUP_CONNECTION_LOST_MESSAGE);
  });

  it("ROW 19 — the mode line counts on stdout and NOT on stderr (stream provenance)", async () => {
    // The stdout half here; the fuller stderr-has-no-effect control is in
    // `backupService.backupMode-2914.test.ts`, whose seventeen tests were green against
    // `proc.stderr` for an input idevicebackup2 cannot emit there.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Incremental backup mode.\n"));
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.close(0);
    });
    expect(result.deviceReportedBackupMode).toBe("incremental");

    const stderrOnly = await runBackup((proc) => {
      proc.stderr.emit("data", Buffer.from("Incremental backup mode.\n"));
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.close(0);
    });
    expect(stderrOnly.result.deviceReportedBackupMode).toBeNull();
  });

  it("ROW 20 — an ErrorCode buried under 80 KB of renders still classifies (mutation: drop the latch)", async () => {
    // `stdoutBuffer` is capped at 65,536 bytes, and stdout now carries ~80 bytes per
    // render at ~76,000 renders per 20 minutes — about SEVEN SECONDS of output. A code
    // printed a minute before the exit is not in the tail. Latching per line makes the
    // cap question disappear rather than be answered with "the device's message
    // ordering probably saves us".
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(lockedDeviceStdout(true)));
      proc.stdout.emit("data", Buffer.from(renderFlood()));
      proc.close(48);
    });

    expect(result.errorCode).toBe("DEVICE_LOCKED");
    expect(result.failureCause?.deviceErrorCode).toBe(208);
  });

  it("ROW 20b — THE MUTATION, RUN: with no code on the stream at all the run is unclassified", async () => {
    // Proves the fixture can discriminate: the same 80 KB of renders with no ErrorCode
    // line to latch produces a different answer, so row 20 is measuring the latch and
    // not the flood.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(renderFlood()));
      proc.close(48);
    });
    expect(result.errorCode).not.toBe("DEVICE_LOCKED");
    expect(result.errorCode).toBe("CONNECTION_LOST");
  });
});

// ===========================================================================
// ROWS 30-34 — the link drop, OBSERVED instead of inferred (round 4)
// ===========================================================================

describe("BACKLOG-2915 rows 30-34 — a cable pull is a fact, not a guess", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ROW 30 — idevicebackup2's own receive failure makes the link drop OBSERVED", async () => {
    // TRANSCRIBED from the founder's real cable pull, 2026-08-31 00:27:01.651:
    // `ERROR: Could not receive from mobilebackup2 (-256)`, printed ONE MILLISECOND
    // before the process exited. `PRINT_VERBOSE(0, ...)`, so it survived the `-d`
    // removal — and this PR parsed it, logged it and threw it away until now.
    //
    // Mutation: stop latching it. The run falls to the D1 inference rung, and
    // `linkDropEvidence` reads `inferred` instead of the observation.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Requesting backup from device...\n"));
      proc.stdout.emit(
        "data",
        Buffer.from("ERROR: Could not receive from mobilebackup2 (-256)\n"),
      );
      proc.stdout.emit("data", Buffer.from("Backup Aborted.\n"));
      proc.close(255);
    });

    expect(result.errorCode).toBe("CONNECTION_LOST");
    expect(result.failureCause?.linkDropEvidence).toBe(
      "mobilebackup2-receive-failure",
    );
    expect(result.failureCause?.linkDropEvidence).not.toBe("inferred");
  });

  it("ROW 31 — the OS's disconnect event outranks it, and is recorded as the evidence", async () => {
    // The founder's insight: the signal was already on the wire. `deviceDetectionService`
    // has polled `idevice_id -l` and emitted `device-disconnected` all along.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    spawnScripted((proc) => {
      proc.stdout.emit("data", Buffer.from("Requesting backup from device...\n"));
      // The OS notices while the run is still alive — a mid-transfer unplug, where
      // idevicebackup2 can take seconds to give up.
      service.noteDeviceDisconnected(TEST_UDID);
      proc.stdout.emit(
        "data",
        Buffer.from("ERROR: Could not receive from mobilebackup2 (-256)\n"),
      );
      proc.close(255);
    });
    const result = await service.startBackup({ udid: TEST_UDID });

    expect(result.errorCode).toBe("CONNECTION_LOST");
    // Both signals fired; the OS's answer is the stronger one and wins.
    expect(result.failureCause?.linkDropEvidence).toBe("device-disconnected");
  });

  it("ROW 32 — THE OTHER DIRECTION: phone still attached ⇒ the class is INFERRED, not observed", async () => {
    // The rung the founder is protecting the user from. Nothing observed a link drop,
    // so this is a guess — and the D1 shape is also produced by an untrusted phone, a
    // service that will not start, a device refusing the backup, and an invalid backup
    // directory. None of those is a cable problem.
    //
    // The founder settled the wording on 2026-08-31 and it is asserted here: this
    // branch gets its own sentence, which DENIES the cable rather than suggesting one.
    const { result } = await runBackup((proc) => {
      proc.close(255);
    });

    expect(result.errorCode).toBe("CONNECTION_LOST");
    expect(result.failureCause?.linkDropEvidence).toBe("inferred");
    expect(result.failureCause?.linkDropEvidence).not.toBe("device-disconnected");
    expect(result.error).toBe(BACKUP_STOPPED_STILL_CONNECTED_MESSAGE);
  });

  it("ROW 33 — a disconnect followed by a RECONNECT before the run ends is still a disconnect", async () => {
    // Explicitly required, and it is why this is an EVENT latch and not a point-in-time
    // check. Observed in the founder's log: disconnect 00:27:02.121, reconnect
    // 00:27:18.234, disconnect again 00:27:30.149. Asking "is the phone here?" at any
    // one of those moments gives a different answer; asking "did it leave during this
    // run?" gives the same one.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    spawnScripted((proc) => {
      service.noteDeviceDisconnected(TEST_UDID);
      // …and it comes back. The latch does not un-set: it flapped, and that IS the
      // fault.
      proc.close(255);
    });
    const result = await service.startBackup({ udid: TEST_UDID });

    expect(result.failureCause?.linkDropEvidence).toBe("device-disconnected");
  });

  it("ROW 34 — a DIFFERENT device disconnecting says nothing about this run", async () => {
    // Guarded on the UDID of the run in flight. Without this an unrelated iPhone being
    // unplugged would be latched as a stated fact about this backup — an inference
    // dressed as an observation, which is worse than the inference it replaced.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    spawnScripted((proc) => {
      service.noteDeviceDisconnected("ffffffffffffffffffffffffffffffffffffffff");
      proc.close(255);
    });
    const result = await service.startBackup({ udid: TEST_UDID });

    expect(result.failureCause?.linkDropEvidence).toBe("inferred");
    expect(result.failureCause?.linkDropEvidence).not.toBe("device-disconnected");
  });

  it("ROW 35 — A DISCONNECT ARRIVING *AFTER* THE PROCESS EXITS IS STILL COUNTED", async () => {
    // THE ROW THAT MATTERS MOST IN THIS BATCH, because the design as specified —
    // "record whether a disconnect fired between run start and run end" — CANNOT WORK.
    // Measured on the founder's real cable pull, 2026-08-31:
    //
    //     00:27:01.652  Backup failed with code 255
    //     00:27:01.653  Failure classified { errorCode: 'CONNECTION_LOST' }
    //     00:27:02.121  Device disconnected            <- 468 ms AFTER the answer
    //
    // `idevicebackup2` notices the dead channel and exits before the 2-second poller's
    // next tick, so a latch read at close time is FALSE for the very runs it exists to
    // catch. A synthetic fixture that fires the disconnect first passes; production
    // does not. This row fires it LAST, which is the order that actually happens.
    //
    // Mutation: remove the settle wait from the close path. The classification falls
    // back to `inferred` and this goes red.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    let backupProc: FakeProcess | null = null;
    mockSpawn.mockImplementation((cmd: string) => {
      const proc = new FakeProcess();
      if (cmd.includes("ideviceinfo")) {
        setTimeout(() => {
          proc.stdout.emit("data", Buffer.from("false\n"));
          proc.close(0);
        }, 0);
      } else {
        backupProc = proc;
        // No link evidence at all on the streams — the phone simply stopped answering.
        setTimeout(() => proc.close(255), 0);
      }
      return proc;
    });

    const pending = service.startBackup({ udid: TEST_UDID });
    // Let the process close and the close handler reach the settle wait.
    await new Promise((r) => setTimeout(r, 30));
    expect(backupProc).not.toBeNull();

    // …and only NOW does the poller notice, exactly as it did at 00:27:02.121.
    service.noteDeviceDisconnected(TEST_UDID);

    const result = await pending;
    expect(result.errorCode).toBe("CONNECTION_LOST");
    expect(result.failureCause?.linkDropEvidence).toBe("device-disconnected");
    expect(result.failureCause?.linkDropEvidence).not.toBe("inferred");
  });

  it("ROW 35b — the settle wait is skipped when nothing feeds disconnects", async () => {
    // The bound on the cost. Without a feed there is no late event to wait for, so an
    // unexplained failure must classify immediately rather than sit out three seconds.
    // Measured here rather than reasoned: the run has no feed attached and must return
    // well inside the settle window.
    const started = Date.now();
    const { result } = await runBackup((proc) => {
      proc.close(255);
    });
    const elapsed = Date.now() - started;

    expect(result.failureCause?.linkDropEvidence).toBe("inferred");
    expect(elapsed).toBeLessThan(1_000);
  });

  it("ROW 49 — SELECTION: device observed gone, NO bytes moved ⇒ the before-transfer message", async () => {
    // Path 1 of 3. The evidence is an observed link drop and nothing had transferred, so
    // the sentence is the founder's earlier one — the phone really did leave, so
    // "plug it straight into your Mac" is sound advice here and only here.
    //
    // Mutation: swap the two link-drop constants at the observed rung's call site.
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Requesting backup from device...\n"));
      proc.stdout.emit(
        "data",
        Buffer.from("ERROR: Could not receive from mobilebackup2 (-256)\n"),
      );
      proc.close(255);
    });

    expect(result.error).toBe(BACKUP_CONNECTION_LOST_MESSAGE);
    expect(result.error).not.toBe(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE);
    expect(result.error).not.toBe(BACKUP_STOPPED_STILL_CONNECTED_MESSAGE);
    expect(result.failureCause?.linkDropEvidence).toBe(
      "mobilebackup2-receive-failure",
    );
  });

  it("ROW 50 — SELECTION: device observed gone AFTER bytes moved ⇒ the untouched mid-transfer message", async () => {
    // Path 2 of 3, and the one the founder corrected himself on 2026-08-28: a drop
    // eleven minutes and 616 MB in is almost never a faulty cable. `transferStarted` is
    // stdout-derived, so this split survives everything round 4 changed.
    // The trailing `\n` on the last render is `print_progress`'s end-of-batch flush, and
    // it is load-bearing: a render carries no terminator, so without it the ERROR line
    // is CONCATENATED onto the render and swallowed by the render branch, which is
    // checked first. The capture shows production terminating it —
    // `...48% (2.1 GB/4.3 GB)     <LF>Discarding current data hunk.<LF>` — so the
    // fixture carries the real byte rather than a convenient one. (This row failed on
    // its first run for exactly that reason.)
    const { result } = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(byteRender(40, "246.4 MB", "616.0 MB")));
      proc.stdout.emit(
        "data",
        Buffer.from(byteRender(41, "252.5 MB", "616.0 MB") + "\n"),
      );
      proc.stdout.emit(
        "data",
        Buffer.from("ERROR: Could not receive from mobilebackup2 (-256)\n"),
      );
      proc.close(255);
    });

    expect(result.error).toBe(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE);
    expect(result.error).not.toBe(BACKUP_CONNECTION_LOST_MESSAGE);
    expect(result.error).not.toBe(BACKUP_STOPPED_STILL_CONNECTED_MESSAGE);
  });

  it("ROW 51 — SELECTION: device STILL ATTACHED, nobody said why ⇒ the still-connected message", async () => {
    // Path 3 of 3. Nothing observed a link drop, so this is the inference rung — and it
    // must not offer cable advice for a phone that never left. The bytes-moved question
    // is deliberately NOT asked on this path: the sentence answers both.
    const withBytes = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from(byteRender(40, "246.4 MB", "616.0 MB")));
      proc.stdout.emit("data", Buffer.from(byteRender(41, "252.5 MB", "616.0 MB")));
      proc.close(255);
    });
    const withoutBytes = await runBackup((proc) => {
      proc.close(255);
    });

    expect(withBytes.result.error).toBe(BACKUP_STOPPED_STILL_CONNECTED_MESSAGE);
    expect(withoutBytes.result.error).toBe(BACKUP_STOPPED_STILL_CONNECTED_MESSAGE);
    // One sentence for both, unlike the observed rung above it.
    expect(withBytes.result.error).toBe(withoutBytes.result.error);
  });

  it("ROW 52 (F1) — a SECOND run cannot start inside the settle window", async () => {
    // SR MEASURED THIS ONE: `{ insideWindow: true, runningFlag: false,
    // secondStartRejected: false }`. The close handler clears `isRunning` before it
    // awaits the window, so the guard was open for up to three seconds — and a run
    // admitted there clears `deviceDisconnectedDuringRun` and overwrites
    // `runDeviceUdid` while run 1 is still waiting to read them.
    //
    // Mutation: drop `|| this.disconnectSettleResolver !== null` from the guard.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    mockSpawn.mockImplementation((cmd: string) => {
      const proc = new FakeProcess();
      if (cmd.includes("ideviceinfo")) {
        setTimeout(() => {
          proc.stdout.emit("data", Buffer.from("false\n"));
          proc.close(0);
        }, 0);
      } else {
        setTimeout(() => proc.close(255), 0);
      }
      return proc;
    });

    const first = service.startBackup({ udid: TEST_UDID });
    // Let run 1 close and reach the settle wait. It is now inside the window.
    await new Promise((r) => setTimeout(r, 30));

    await expect(service.startBackup({ udid: TEST_UDID })).rejects.toThrow(
      /already in progress/i,
    );

    // …and run 1 is undisturbed: it still reaches its own classification.
    service.noteDeviceDisconnected(TEST_UDID);
    const result = await first;
    expect(result.failureCause?.linkDropEvidence).toBe("device-disconnected");
  });

  it("ROW 53 (F2) — a FOREIGN disconnect during the settle window is ignored", async () => {
    // The half of the UDID guard that mattered and had no control. ROW 34 drives its
    // foreign disconnect while the run is ALIVE — which is when the guard matters least,
    // because `currentDeviceUdid` is still set and the event is in-band. The case the
    // guard exists for is the window: the run has ended, `currentDeviceUdid` is null,
    // and `runDeviceUdid` is the only thing standing between a SECOND iPhone being
    // unplugged and a stated "your connection dropped" on THIS backup.
    //
    // Measured by SR: scoping the guard to `isRunning` only left 372/372 green.
    // Mutation: `if (!this.isRunning) return;` in place of the `runDeviceUdid` check.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    mockSpawn.mockImplementation((cmd: string) => {
      const proc = new FakeProcess();
      if (cmd.includes("ideviceinfo")) {
        setTimeout(() => {
          proc.stdout.emit("data", Buffer.from("false\n"));
          proc.close(0);
        }, 0);
      } else {
        setTimeout(() => proc.close(255), 0);
      }
      return proc;
    });

    const pending = service.startBackup({ udid: TEST_UDID });
    await new Promise((r) => setTimeout(r, 30));

    // A DIFFERENT iPhone leaves, while this run's window is open.
    service.noteDeviceDisconnected("ffffffffffffffffffffffffffffffffffffffff");

    const result = await pending;
    // Not a link drop. The other device says nothing about this backup.
    expect(result.failureCause?.linkDropEvidence).toBe("inferred");
    expect(result.failureCause?.linkDropEvidence).not.toBe("device-disconnected");
    expect(result.error).toBe(BACKUP_STOPPED_STILL_CONNECTED_MESSAGE);
  });

  it("ROW 54 (F3) — the matching disconnect ENDS the window rather than waiting it out", async () => {
    // Latency only — the latch is set either way — but it is a behaviour with no
    // control, and it is the difference between a failed sync reporting in ~30 ms and in
    // three seconds. Measured against the window itself rather than a wall-clock guess:
    // the run must finish well inside DISCONNECT_SETTLE_MS.
    //
    // Mutation: delete `this.disconnectSettleResolver?.()` from noteDeviceDisconnected.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    mockSpawn.mockImplementation((cmd: string) => {
      const proc = new FakeProcess();
      if (cmd.includes("ideviceinfo")) {
        setTimeout(() => {
          proc.stdout.emit("data", Buffer.from("false\n"));
          proc.close(0);
        }, 0);
      } else {
        setTimeout(() => proc.close(255), 0);
      }
      return proc;
    });

    const pending = service.startBackup({ udid: TEST_UDID });
    await new Promise((r) => setTimeout(r, 30));

    const releasedAt = Date.now();
    service.noteDeviceDisconnected(TEST_UDID);
    const result = await pending;
    const waited = Date.now() - releasedAt;

    expect(result.failureCause?.linkDropEvidence).toBe("device-disconnected");
    // The full window is 3,000 ms. Half of it is a wide margin that still cannot pass
    // if the early-resolve is gone.
    expect(waited).toBeLessThan(1_500);
  });

  it("ROW 55 (F4) — a disconnect arriving between runs does not latch onto the next one", async () => {
    // The idle-event guard. Benign today only because the latch is reset per run; it
    // stops being benign the moment that reset moves, and nothing could detect it being
    // removed. Measured by SR: deleting it left 372/372 green.
    //
    // Mutation: delete `if (!this.isRunning && this.disconnectSettleResolver === null)
    // return;`.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    // Nothing is running. The phone is unplugged and plugged back in.
    service.noteDeviceDisconnected(TEST_UDID);

    spawnScripted((proc) => {
      proc.close(255);
    });
    const result = await service.startBackup({ udid: TEST_UDID });

    // The next run must be judged on its OWN evidence, of which there is none.
    expect(result.failureCause?.linkDropEvidence).toBe("inferred");
    expect(result.error).toBe(BACKUP_STOPPED_STILL_CONNECTED_MESSAGE);
  });

  it("ROW 56 (F5) — a cancel does not pay the settle wait", async () => {
    // Answer-preserving by construction: the cancel rung outranks the observed rung, so
    // no event arriving in the window could change the classification. All the wait cost
    // was time — SR measured 3,035 ms — and it stacked on the up-to-30 s SIGKILL grace.
    //
    // Mutation: drop `!this.cancelRequested` from the settle gate.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    spawnScripted((proc) => {
      service.cancelBackup();
      proc.close(255);
    });

    const started = Date.now();
    const result = await service.startBackup({ udid: TEST_UDID });
    const elapsed = Date.now() - started;

    expect(result.errorCode).toBe("BACKUP_CANCELLED");
    expect(elapsed).toBeLessThan(1_500);
  });

  it("ROW 34b — a device-reported failure is never relabelled a link drop, even after a disconnect", async () => {
    // Ordering. The observed rung sits BELOW the device-code switch, so a phone that
    // said 208 and was then unplugged during teardown still reports a locked phone.
    // This is the same ordering property the broken-pipe teardown line needed in
    // BACKLOG-2913, met from the new direction.
    const service = new BackupService();
    service.on("error", () => {});
    service.attachDeviceDisconnectFeed();

    spawnScripted((proc) => {
      proc.stdout.emit("data", Buffer.from(lockedDeviceStdout(true)));
      service.noteDeviceDisconnected(TEST_UDID);
      proc.close(48);
    });
    const result = await service.startBackup({ udid: TEST_UDID });

    expect(result.errorCode).toBe("DEVICE_LOCKED");
    expect(result.failureCause?.linkDropEvidence).toBeUndefined();
  });
});

// ===========================================================================
// ROWS 27-28 — defence 1 of 2: the cancel latch is SYNC-scoped
// ===========================================================================

describe("BACKLOG-2915 rows 27-28 — a cancel outlives the run it was aimed at", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ROW 27 — a SECOND run inside one cancelled sync is classified CANCELLED, not CONNECTION_LOST", async () => {
    // THE FOUNDER'S DEFECT, EXPRESSED. This is the fixture shape that did not exist
    // through three review rounds and 38 mutations, which is why none of them could
    // fail on it: every cancel control drove cancel DURING an active run.
    //
    // His sequence, 2026-08-31: cancel at 00:27:08.701 and again at 00:27:22.737, then
    // a THIRD run spawned at 00:27:56.486 and died 16 ms later with the phone
    // unplugged. It came out `CONNECTION_LOST`. Sync elapsed 37,299 ms, backup elapsed
    // 26 ms — the latch was scoped to the shorter lifetime.
    //
    // ONE service instance across both runs, because that is what the app has:
    // `deviceSyncOrchestrator` constructs a BackupService per orchestrator, not per
    // sync. A test that built a fresh service per run could not see this at all.
    const service = new BackupService();
    service.on("error", () => {});

    // Run 1: the user cancels it.
    spawnScripted((proc) => {
      service.cancelBackup();
      proc.close(255);
    });
    const first = await service.startBackup({ udid: TEST_UDID });
    expect(first.errorCode).toBe("BACKUP_CANCELLED");

    // Run 2, same sync, spawned after the cancel. The phone is gone, so it dies at
    // once with no device code — the exact shape the D1 inference rung claims.
    spawnScripted((proc) => {
      proc.close(255);
    });
    const second = await service.startBackup({ udid: TEST_UDID });

    // The cancel still applies: the user asked for this sync to stop, and nothing
    // since has said otherwise.
    expect(second.errorCode).toBe("BACKUP_CANCELLED");
    expect(second.errorCode).not.toBe("CONNECTION_LOST");
    expect(second.error).not.toBe(BACKUP_CONNECTION_LOST_MESSAGE);
  });

  it("ROW 28 — `beginSyncScope()` clears it, so a NEW sync classifies on its own evidence", async () => {
    // The other direction, and the one that makes the sticky latch safe. Without this
    // the fix would trade a silent misclassification for a permanent one: every backup
    // after any cancel would report "Backup was cancelled" forever.
    const service = new BackupService();
    service.on("error", () => {});

    spawnScripted((proc) => {
      service.cancelBackup();
      proc.close(255);
    });
    expect((await service.startBackup({ udid: TEST_UDID })).errorCode).toBe(
      "BACKUP_CANCELLED",
    );

    // A new sync begins — the orchestrator calls this where it builds a fresh
    // AbortController, which is the sync's own cancel scope.
    service.beginSyncScope();

    spawnScripted((proc) => {
      proc.close(255);
    });
    const fresh = await service.startBackup({ udid: TEST_UDID });

    expect(fresh.errorCode).not.toBe("BACKUP_CANCELLED");
    expect(fresh.errorCode).toBe("CONNECTION_LOST");
  });
});

// ===========================================================================
// ROW 23 — the kill path: the grace and the safety net move together
// ===========================================================================

describe("BACKLOG-2915 row 23 — the kill path waits for the flush it depends on", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("ROW 23 — a cancel waits out the 13.1 s shutdown and harvests the outcome (mutation: restore the 5 s SIGKILL)", async () => {
    // MEASURED, 2026-08-30: SIGTERM at t=1200.035 s, `Exiting...` on stderr 3 ms later,
    // the process closed at t=1213.128 s with code 255, and the 148-byte flush that
    // came with that close carried the whole outcome. The old 5-second SIGKILL threw
    // it away on every user cancel.
    const { service, proc, result, progress } = await startRun();
    proc.stdout.emit("data", Buffer.from(FIRST_CHUNK));
    await jest.advanceTimersByTimeAsync(100);

    service.cancelBackup();
    expect(sentSignal(proc, "SIGTERM")).toBe(true);
    // idevicebackup2's `clean_exit` answers immediately and then unwinds.
    proc.stderr.emit("data", Buffer.from("Exiting...\n"));

    // 13.1 s of unwinding. Under the old 5 s grace the process is SIGKILLed in here.
    await advance(13_100, 1_000);
    expect(sentSignal(proc, "SIGKILL")).toBe(false);

    // The flush, and only then the close.
    proc.stdout.emit("data", Buffer.from(FINAL_ABORT_FLUSH));
    proc.close(255);
    const finished = await result;

    // The user is told what actually happened, not that the app was left guessing.
    expect(finished.errorCode).toBe("BACKUP_CANCELLED");
    // …and the harvest survived: the device's own file count reached the outside.
    expect(progress.some((p) => p.filesTransferred === 4604)).toBe(true);
  });

  it("ROW 23b — the state-reset safety net does not fire before that flush (mutation: restore the 10 s net)", async () => {
    // SR BLOCKER B1, AND IT IS THE HALF THAT WAS NEARLY MISSED. Raising the SIGKILL
    // grace on its own is a dead letter: `killZombieProcess` installs a SECOND timer
    // that force-resets the run — `isRunning = false`, `currentProcess = null`, an
    // `error` carrying BACKUP_TIMEOUT — and it was set to 10 seconds against a
    // 13.1-second shutdown. It therefore fired FIRST on every kill, and the real
    // outcome landed three seconds later on a run the service had already torn down.
    //
    // Driven through the WATCHDOG rather than a cancel, because that is the path where
    // the safety net emits something observable.
    const { proc, result, progress, errors } = await startRun();

    await advance(BackupService["WATCHDOG_NO_PROGRESS_TIMEOUT_MS"] + 5_000);
    expect(sentSignal(proc, "SIGTERM")).toBe(true);

    // The 13.1 seconds idevicebackup2 needs to unwind. Under the old 10 s net the
    // BACKUP_TIMEOUT error has already been emitted by this point.
    await advance(13_100, 1_000);
    expect(errors).toHaveLength(0);

    // …and only now does the flush arrive, still into a live run.
    proc.stdout.emit("data", Buffer.from(FINAL_ABORT_FLUSH));
    proc.close(255);
    const finished = await result;

    expect(finished.errorCode).toBe("BACKUP_TIMEOUT");
    // The harvest the whole change exists for: the device's own file count.
    expect(progress.some((p) => p.filesTransferred === 4604)).toBe(true);
  });

  it("ROW 23e — a cancel keeps the run OPEN until the process closes (mutation: reset isRunning in cancelBackup)", async () => {
    // The ordering half of B1. `cancelBackup` used to clear `isRunning` synchronously,
    // so the 13.1-second flush arrived into a run the service considered finished — and
    // a second backup could be started on top of a process that was still writing.
    const { service, proc, result } = await startRun();
    const state = service as unknown as { isRunning: boolean };

    service.cancelBackup();
    await advance(13_000, 1_000);
    expect(state.isRunning).toBe(true);

    proc.stdout.emit("data", Buffer.from(FINAL_ABORT_FLUSH));
    proc.close(255);
    await result;
    expect(state.isRunning).toBe(false);
  });

  itPosix("ROW 23c — the watchdog's SIGKILL escalation actually runs (mutation: restore `!proc.killed`)", async () => {
    // THE DEAD GUARD. `killZombieProcess` sent SIGTERM and then guarded its SIGKILL
    // with `!this.currentProcess.killed` — which node had already set to true on that
    // SIGTERM one line earlier. The escalation was unreachable for as long as it has
    // existed, so the watchdog never escalated at all.
    //
    // Proven empirically outside this test too: the 2026-08-30 capture harness carries
    // the identical `if (!p.killed)` guard, its event log contains ZERO occurrences of
    // SIGKILL, and the process lived to 13.128 s.
    const { proc, result } = await startRun();

    // Just past the 30-minute no-progress timeout, and NOT yet past the SIGKILL grace
    // that follows it — the window in which the old guard was measurable at all.
    await advance(BackupService["WATCHDOG_NO_PROGRESS_TIMEOUT_MS"] + 5_000);
    expect(sentSignal(proc, "SIGTERM")).toBe(true);
    expect(sentSignal(proc, "SIGKILL")).toBe(false);
    expect(proc.killed).toBe(true); // …which is exactly what the old guard read

    // The process ignores SIGTERM. After the grace, it must be killed for real.
    await advance(BackupService["SIGKILL_GRACE_MS"] + 1_000, 1_000);
    expect(sentSignal(proc, "SIGKILL")).toBe(true);

    proc.close(null);
    const finished = await result;
    expect(finished.errorCode).toBe("BACKUP_TIMEOUT");
  });

  it("ROW 23d — the three kill-path constants are ordered against the measurement", () => {
    // Both timers derive from ONE measurement, and the ordering is the invariant that
    // makes either of them useful. Stated as an assertion so a later tweak to one
    // number cannot silently re-create the 5 s / 10 s / 13.1 s inversion.
    const measured = BackupService["MEASURED_GRACEFUL_SHUTDOWN_MS"];
    const grace = BackupService["SIGKILL_GRACE_MS"];
    const reset = BackupService["POST_KILL_STATE_RESET_MS"];

    expect(measured).toBe(13_100);
    expect(grace).toBeGreaterThan(measured);
    expect(reset).toBeGreaterThan(grace);
  });
});
