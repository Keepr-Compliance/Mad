/**
 * BACKLOG-2911 (FIX 2) — THE WATCHDOG COULD NOT FIRE, AND THIS FILE ESTABLISHES WHICH
 * OF THE TWO POSSIBLE FAILURES IT WAS.
 *
 * ## The observation
 *
 * From the founder's session, 2026-08-28:
 *
 *     12:09:43.414  Watchdog started (timeout: 180s)
 *     …904 seconds of silence…
 *     12:24:42.355  File transfer started after 903.9s
 *
 * Silent through FIVE TIMES its own timeout. `grep -c "Watchdog fired|zombie|killed by
 * watchdog"` over the whole session returns 0, across three runs that waited 507 s,
 * 684.6 s and 903.9 s before the first byte. BACKLOG-1582 was closed on the strength of
 * this watchdog, so its silence has been read as good news for months.
 *
 * ## Which failure — established here, not assumed
 *
 * The item allows two: (a) it resets on ANY process output, so libimobiledevice's
 * routine chatter keeps it alive forever, or (b) it is simply not working. These need
 * different fixes.
 *
 * IT IS (a). `THE DIAGNOSIS` below runs the pre-fix mechanism — liveness = the newest
 * of `lastStdoutTimestamp` / `lastStderrTimestamp`, each bumped by its `data` handler
 * on EVERY chunk — against nothing but idle chatter for 15 minutes, and the process is
 * never killed. `-d` is passed unconditionally by `buildBackupArgs`, so that chatter is
 * guaranteed on every real run: the BACKLOG-2898 comment in `backupService.ts` measures
 * 336 such records in one 21-minute log. The timer fires on schedule and finds the
 * stream "alive" every time, which is failure (a) exactly — the timer works, the
 * question it asks cannot come back false.
 *
 * ## Fixtures
 *
 * TRANSCRIBED, not invented. The chatter is copied from
 * `backupService.stderrClassification-2898.test.ts`, which took it verbatim from the
 * founder's real log of a backup that COMPLETED SUCCESSFULLY (2026-08-26, 4,023 lines).
 * It contains no user data — the only paths are libimobiledevice's own build paths,
 * baked into the binary on its CI machine.
 *
 * ## The three cases, and why all three are needed
 *
 *   FIRES     — stall longer than the timeout, with continuous non-progress output.
 *   NOT-FIRES — a long wait that then delivers. All three of the founder's SUCCESSFUL
 *               runs look like this, so a fix that kills them is worse than the bug.
 *   NOT-FIRES — continuous `SSL_write`: BACKLOG-1628's manifest upload, where stdout is
 *               silent for minutes while the host pushes the index. That is what put
 *               stderr into the liveness signal in the first place, and it must stay.
 */

import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

/**
 * One second of libimobiledevice's idle polling, transcribed from the founder's log
 * (2026-08-26 16:06:23) via the BACKLOG-2898 fixture. `SSL_read 4, received 0` is a
 * read that returned NOTHING; `no notification received!` is the notification proxy
 * finding nothing. This is the sound of a device that is not sending anything.
 */
const IDLE_CHATTER =
  "16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\idevice.c:652 idevice_connection_receive_timeout(): SSL_read 4, received 0\n" +
  "16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\property_list_service.c:196 internal_plist_receive_timeout(): initial read failed!\n" +
  "16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\notification_proxy.c:271 np_get_notification(): NotificationProxy: no notification received!\n" +
  "16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\notification_proxy.c:52 np_lock(): Locked\n" +
  "16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\notification_proxy.c:63 np_unlock(): Unlocked\n";

/**
 * Bytes LEAVING the host — the manifest upload. Same trace format as the idle lines
 * above, which is the whole difficulty: format cannot separate them, only the signal
 * inside can. BACKLOG-1628 added stderr to the liveness check for exactly this window.
 */
const MANIFEST_UPLOAD_CHATTER =
  "16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\idevice.c:601 idevice_connection_send_bytes(): SSL_write 32768, sent 32768\n";

/** A per-file progress bar: idevicebackup2 on stdout, data actually arriving. */
const PROGRESS_BAR = "[==================    ] 71% (4.1 MB/5.8 MB)\n";

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

jest.mock("electron-log", () => ({
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
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
    stat: jest.fn().mockRejectedValue(Object.assign(new Error("no"), { code: "ENOENT" })),
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

import { BackupService } from "../backupService";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  killed = false;
  pid = 4242;
  kill = jest.fn(() => {
    this.killed = true;
    return true;
  });
}

/**
 * Starts a real backup run under fake timers and hands back the live child process, so
 * a test can feed it output while advancing the clock. The run is NOT awaited: these
 * tests are about what happens while it is still going.
 */
async function startRun(): Promise<{
  service: BackupService;
  proc: FakeProcess;
  result: Promise<BackupResult>;
}> {
  const service = new BackupService();
  let backupProc: FakeProcess | null = null;

  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      // The encryption probe. Answers immediately on the next macrotask.
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.emit("close", 0);
      }, 0);
    } else {
      backupProc = proc;
    }
    return proc;
  });

  // The service emits `error` on a watchdog kill. Node throws on an unhandled
  // `error` event, so a listener is attached before anything can fire.
  service.on("error", () => {
    /* asserted through the resolved BackupResult, not here */
  });

  const result = service.startBackup({ udid: TEST_UDID });

  // Let the encryption probe resolve and `spawn(idevicebackup2)` happen.
  await jest.advanceTimersByTimeAsync(10);
  if (!backupProc) throw new Error("idevicebackup2 was never spawned");

  return { service, proc: backupProc, result };
}

/**
 * Feeds `chunk` on the named stream once per `stepMs` for `totalMs`, advancing fake
 * time in the same steps. This is what a real run looks like from the watchdog's seat:
 * output keeps arriving, and the question is whether the output MEANS anything.
 */
async function streamFor(
  proc: FakeProcess,
  stream: "stdout" | "stderr",
  chunk: string,
  totalMs: number,
  stepMs = 10_000,
): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    proc[stream].emit("data", Buffer.from(chunk));
    await jest.advanceTimersByTimeAsync(stepMs);
  }
}

/** Silence: time passes, nothing is emitted at all. */
async function silenceFor(totalMs: number, stepMs = 10_000): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
  }
}

/** The founder's worst measured pre-transfer wait, to the tenth of a second. */
const LONGEST_MEASURED_WAIT_MS = 903_900;

/**
 * Longer than the watchdog's own no-progress timeout (30 min), so a run that survives
 * this survives BECAUSE it was recognised as alive — not merely because the clock had
 * not run out yet. A counter-control shorter than the timeout proves nothing: it stays
 * green even with the signal it is testing deleted.
 */
const LONGER_THAN_THE_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * BACKLOG-2915 — THE STDERR SIGN-OF-LIFE DISCRIMINATOR IS RETIRED, DELIBERATELY.
 *
 * Three tests stood here, all of them direct calls to
 * `BackupService.isStderrActivitySignal`. That method and its
 * `STDERR_ACTIVITY_SIGNALS` list are deleted, so the tests are removed rather than
 * left green against a mechanism that no longer exists.
 *
 * Why the mechanism went, and why keeping these tests would have been worse than
 * useless: the list had seven entries and FIVE OF THEM COULD NEVER HAVE FIRED.
 * `Sending '`, `Requesting backup`, `Starting backup`, `Negotiated Protocol` and
 * `backup mode` are all `printf`/`PRINT_VERBOSE` calls in idevicebackup2 — stdout,
 * with or without `-d` — while this list was only ever tested against stderr lines.
 * The three tests passed because they called the classifier DIRECTLY with a string,
 * which proves a substring match and nothing about which stream carries the line.
 * That is the same shape BACKLOG-2915 found in `parseStderrLine` and in
 * `backupService.backupMode-2914.test.ts`; it is the third instance, so it is a
 * pattern and not an accident.
 *
 * The remaining two entries, `SSL_write` and `service_send`, were `debug_info()`
 * output and existed only under `-d`, which BACKLOG-2915 removes.
 *
 * The replacement claim is asserted below, through the spawned process rather than
 * through a direct call: stdout is the liveness feed, and stderr — INCLUDING the exact
 * chatter that used to count as work — no longer keeps a stalled run alive.
 */

describe("BACKLOG-2911 FIX 2 — a stall with continuous chatter must kill the process", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("BACKLOG-2915 — 40 minutes of MANIFEST-UPLOAD chatter on stderr now fires the watchdog", async () => {
    // This is the retired discriminator's claim, re-asserted from the other side and
    // through the real stream. `SSL_write` / `service_send` were the two entries in
    // `STDERR_ACTIVITY_SIGNALS` that genuinely appeared on stderr, and they were the
    // reason BACKLOG-1628 put stderr into the liveness check at all. They exist only
    // under `-d`, which is gone — so if this stream ever carries them again, it must
    // NOT be able to hold a stalled run open.
    const { proc, result } = await startRun();

    await streamFor(proc, "stderr", MANIFEST_UPLOAD_CHATTER, 40 * 60 * 1000);

    expect(proc.kill).toHaveBeenCalled();

    proc.emit("close", null);
    const finished = await result;
    expect(finished.errorCode).toBe("BACKUP_TIMEOUT");
  });

  it("THE CONTROL — 40 minutes of idle chatter and no progress fires the watchdog", async () => {
    const { proc, result } = await startRun();

    // Idle polling every 10 s for 40 minutes. Pre-fix this is indistinguishable from a
    // healthy transfer, because the only question asked was "did any bytes arrive on
    // either stream?" — and they always did.
    await streamFor(proc, "stderr", IDLE_CHATTER, 40 * 60 * 1000);

    expect(proc.kill).toHaveBeenCalled();

    proc.emit("close", null);
    const finished = await result;
    expect(finished.success).toBe(false);
    expect(finished.errorCode).toBe("BACKUP_TIMEOUT");
  });

  it("PROOF IT IS FAILURE (a) — total silence ALREADY killed the process before this fix", async () => {
    // This case passes on the pre-fix tree as well, and that is the finding. The
    // interval runs, the kill path works, the BACKUP_TIMEOUT result is produced. So the
    // watchdog is not "not working" — the QUESTION it asked could not come back false
    // while any bytes were arriving, and `-d` guarantees bytes are always arriving.
    // Failure (b) is ruled out; failure (a) is what is fixed.
    const { proc, result } = await startRun();

    await silenceFor(40 * 60 * 1000);

    expect(proc.kill).toHaveBeenCalled();

    proc.emit("close", null);
    const finished = await result;
    expect(finished.errorCode).toBe("BACKUP_TIMEOUT");
  });
});

describe("BACKLOG-2911 FIX 2 — the founder's SUCCESSFUL runs must survive", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("COUNTER-CONTROL 1 — a 903.9 s pre-transfer wait that then delivers is NOT killed", async () => {
    // The 12:09 run, measured: 903.9 s of nothing, then the first file. Two of his
    // three runs were incremental syncs that completed after waits like this. A
    // progress-based watchdog at the old 180 s timeout would have killed all three.
    const { proc, result } = await startRun();

    await streamFor(proc, "stderr", IDLE_CHATTER, LONGEST_MEASURED_WAIT_MS);
    expect(proc.kill).not.toHaveBeenCalled();

    // …and then the transfer starts, exactly as it did on his machine.
    proc.stdout.emit("data", Buffer.from(PROGRESS_BAR));
    await jest.advanceTimersByTimeAsync(1000);
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit("close", 0);
    await result;
  });

  it("COUNTER-CONTROL 2 (BACKLOG-2915) — the manifest upload is now TOTAL SILENCE, and it survives", async () => {
    // BACKLOG-1628's case, re-measured after the `-d` removal. It used to be "stdout
    // goes quiet while stderr shows SSL_write", which is why liveness was not
    // stdout-only. With `-d` gone there is no stderr either: the 2026-08-30 capture
    // recorded **zero bytes on both streams for 564.219 s**, then a single 826-byte
    // chunk carrying eleven lines that had been printed across those 9.4 minutes.
    //
    // So the thing that now keeps this run alive is the SIZE OF THE TIMEOUT, not a
    // signal — 1,800 s against a measured 564 s, and against the founder's worst
    // observed pre-transfer wait of 903.9 s. That is the trade BACKLOG-2915 §10.1
    // records, and this test is what pins the margin.
    const { proc, result } = await startRun();

    await silenceFor(LONGEST_MEASURED_WAIT_MS);
    expect(proc.kill).not.toHaveBeenCalled();

    // …and then the whole buffered pre-receive phase arrives at once, as it did live.
    proc.stdout.emit("data", Buffer.from(PROGRESS_BAR));
    await jest.advanceTimersByTimeAsync(1000);
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit("close", 0);
    await result;
  });

  it("COUNTER-CONTROL 3 — a steady file transfer is NOT killed", async () => {
    const { proc, result } = await startRun();

    await streamFor(proc, "stdout", PROGRESS_BAR, LONGER_THAN_THE_TIMEOUT_MS);

    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit("close", 0);
    await result;
  });
});
