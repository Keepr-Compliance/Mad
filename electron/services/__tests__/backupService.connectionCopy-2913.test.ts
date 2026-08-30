/**
 * BACKLOG-2913, copy defect — "try a different cable" for a cable that was fine.
 *
 * The classifier shipped in PR #2420 is correct and the founder verified it on real
 * hardware on 2026-08-28. Its ADVICE was not. He started an incremental sync, waited
 * out the passcode, let one 616 MB file complete, then unplugged the cable on
 * purpose — and the app told him to try a different cable.
 *
 * **A drop eleven minutes in, after a successful handshake, a passcode and 616 MB,
 * is almost never a faulty cable.** A bad cable fails at enumeration or within
 * seconds. What actually causes a MID-TRANSFER drop is the Mac sleeping, the phone
 * sleeping or locking, USB power management suspending the port, a hub
 * renegotiating, or somebody pulling the plug. Leading with hardware sends a user
 * hunting a problem they do not have.
 *
 * So the message splits on whether transfer had begun, and the after-bytes variant
 * leads with the action that works.
 *
 * ## Provenance — the run these tests are written against
 *
 * TRANSCRIBED first-hand from the founder's dev log
 * (`keepr-dev/logs/main.log`, mtime 2026-08-28 12:19; the dev app is live and
 * writing, so line numbers are as observed and can shift):
 *
 * - **line 10729** — `[BackupService] File transfer started after 684.6s - passcode
 *   entered`, at 12:07:59.607. That sentence is emitted from exactly one place in
 *   backupService.ts: inside `if (progress.phase === "transferring" &&
 *   !this.hasReceivedFileProgress)`, the block that sets the flag. **Its presence in
 *   the log is proof that `hasReceivedFileProgress` was true for this run** — which
 *   is what makes it the right discriminator rather than a plausible one.
 * - **line 11542** — `[BackupService] Backup failed with code 255`, at 12:08:53.323.
 * - **lines 11551-11558** — the teardown block below, verbatim, including
 *   `usbmuxd_send returned -32 (Broken pipe)` at 12:08:53.319.
 * - **line 11607** — the renderer printing the defect itself: `Sync failed: The
 *   connection to your iPhone dropped during the backup. Try a different cable...`
 *   (HISTORICAL. BACKLOG-2915 replaced that sentence — see the copy tests below.)
 *
 * The progress-bar lines are the ONE fixture here that is not a capture, and it is
 * not one because it cannot be: backupService filters progress bars out of the log
 * on purpose (`isProgressBar`), so no run of any date has them. The shape below is
 * taken from `parseProgress`'s own documented example — the parser's vocabulary,
 * stated as such rather than passed off as transcription — and the wiring tests
 * prove by execution that the real parser accepts it, because the flag they assert
 * on is only set when it does.
 *
 * PII: no UDID, device name, contact name, phone or email appears below. The
 * transcribed block is nine `idevice.c`/`afc.c`/`service.c` lines carrying byte
 * counts and errno strings.
 *
 * ## What each control kills
 *
 * - Reordering the clauses of the mid-transfer message -> `does not open with a
 *   hardware instruction` and `puts trying again ahead of the hardware step`.
 * - Collapsing the branch to one constant -> `the two cases produce different
 *   messages`.
 * - Hardcoding `transferStarted` to false at the call site -> the three wiring
 *   tests. That mutation is the reason the wiring tests exist: without them,
 *   "the signal is reachable where the message is built" is a claim, not a result.
 */

import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";

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
  BACKUP_CONNECTION_LOST_MESSAGE,
  BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE,
} from "../backupService";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * TRANSCRIBED verbatim from main.log lines 11551-11558, the founder's 2026-08-28
 * unplug at 12:08:53.319. This is the whole evidence the classifier gets: the device
 * never answers once the link is gone, so there is no plist and no `ErrorCode` line.
 *
 * BACKLOG-2915 — **PRODUCTION CAN NO LONGER PRODUCE THIS INPUT.** Every line here is
 * `debug_info()` output, gated on `debug_level`, which only `-d` sets, and
 * `buildBackupArgs` no longer passes `-d`. It is kept as a historical fixture because
 * the file's real subject — WHICH SENTENCE a link drop gets, and that the split turns
 * on `transferStarted` rather than on a byte count — is unchanged and still worth
 * pinning. But the classification these tests exercise is now reached by the D1
 * INFERENCE RUNG (non-zero exit, no device code, no version-exchange), not by matching
 * the broken-pipe line: measured, replacing `CONNECTION_DROPPED_PATTERN` with a
 * never-matching regex leaves this whole suite green.
 *
 * Do not read this fixture as evidence that the stderr path is live. It is not.
 */
const UNPLUGGED_MID_TRANSFER_STDERR = [
  "12:08:53.318 notification_proxy.c:278 np_get_notification(): NotificationProxy: error -256 occurred!",
  "12:08:53.318 notification_proxy.c:67 np_unlock(): Unlocked",
  "12:08:53.319 property_list_service.c:132 internal_plist_send(): sending 108 bytes",
  "12:08:53.319 service.c:144 service_send(): sending 4 bytes",
  "12:08:53.319 idevice.c:1017 internal_ssl_write(): pre-send length = 33 bytes",
  "12:08:53.319 idevice.c:643 internal_connection_send(): ERROR: usbmuxd_send returned -32 (Broken pipe)",
  "12:08:53.319 idevice.c:1019 internal_ssl_write(): ERROR: internal_connection_send returned -2",
  "12:08:53.319 idevice.c:696 idevice_connection_send(): SSL_write 4, sent 0",
  "12:08:53.319 service.c:147 service_send(): ERROR: sending to device failed.",
].join("\n");

/** idevicebackup2's stdout for a run that failed without a device error code. */
const STDOUT_NO_ERROR_LINE = [
  "Requesting backup from device...",
  "Incremental backup mode.",
  "Received 0 files from device.",
].join("\n");

/**
 * A per-file progress bar. NOT transcribed — see the header. Shape taken from
 * `parseProgress`'s own documented example,
 * `"[====================                              ]  39% (18.8 MB/48.3 MB)"`.
 * The 616 MB total is the file size from the founder's run.
 */
function progressBar(percent: number, doneMb: number, totalMb = 616.0): string {
  const filled = "=".repeat(Math.max(1, Math.round(percent / 5)));
  const empty = " ".repeat(20 - Math.min(20, Math.round(percent / 5)));
  return `[${filled}${empty}] ${percent}% (${doneMb.toFixed(1)} MB/${totalMb.toFixed(1)} MB)\n`;
}

// ---------------------------------------------------------------------------
// Harness — the real BackupService, driven end to end
// ---------------------------------------------------------------------------

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
}

/** The two private fields this suite reads, to prove which one is load-bearing. */
interface TransferState {
  hasReceivedFileProgress: boolean;
  bytesTransferred: number;
}

/**
 * Drives one backup run. The first spawn is the `ideviceinfo` encryption probe, the
 * second is `idevicebackup2`. Returns the service too, so the test can read the
 * transfer state the classifier was handed.
 */
async function runBackup(
  script: (proc: FakeProcess) => void,
): Promise<{ result: BackupResult; state: TransferState }> {
  const service = new BackupService();

  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.emit("close", 0);
      });
    } else {
      setTimeout(() => script(proc), 0);
    }
    return proc;
  });

  const result = await service.startBackup({ udid: TEST_UDID });
  const state = service as unknown as TransferState;
  return {
    result,
    state: {
      hasReceivedFileProgress: state.hasReceivedFileProgress,
      bytesTransferred: state.bytesTransferred,
    },
  };
}

/** The unplug, after `progress` has been streamed. */
function unplug(proc: FakeProcess, progress: string[]): void {
  proc.stdout.emit("data", Buffer.from("Requesting backup from device...\n"));
  for (const line of progress) {
    proc.stdout.emit("data", Buffer.from(line));
  }
  proc.stderr.emit("data", Buffer.from(UNPLUGGED_MID_TRANSFER_STDERR + "\n"));
  proc.emit("close", 255);
}

// ---------------------------------------------------------------------------

describe("BACKLOG-2913 — a mid-transfer drop is not a cable fault", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("the mid-transfer message leads with the action that works", () => {
    // Every assertion below names ONE clause. A single full-string equality would
    // let a later copy tweak drop a clause and stay green.

    it("does not lead with a hardware instruction", () => {
      // "Leads with" means the first ADVICE, not the first sentence — both orderings
      // open with the same diagnosis, so a first-sentence check would survive a
      // reorder and prove nothing. Every hardware word in the message must come
      // AFTER the try-again clause.
      const msg = BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE;
      const tryAgain = msg.indexOf("try syncing again");
      expect(tryAgain).toBeGreaterThanOrEqual(0);

      const hardwareWords = /cable|hub|dock|port|plug|unplug|restart|cord|adapter/gi;
      const hardwareAt = [...msg.matchAll(hardwareWords)].map((m) => m.index ?? -1);
      // The fixture is worth nothing if the message has no hardware advice at all.
      expect(hardwareAt.length).toBeGreaterThan(0);
      expect(Math.min(...hardwareAt)).toBeGreaterThan(tryAgain);

      // And it still opens by naming what happened, not by issuing an order.
      expect(msg.split(". ")[0]).toContain("connection to your iPhone dropped");
    });

    it("puts trying again ahead of the hardware step", () => {
      const msg = BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE;
      // Presence first: indexOf returns -1 for an absent token, and -1 < n passes.
      expect(msg).toContain("try syncing again");
      expect(msg).toContain("plug the iPhone straight into this Mac");
      expect(msg.indexOf("try syncing again")).toBeGreaterThanOrEqual(0);
      expect(msg.indexOf("plug the iPhone straight into this Mac")).toBeGreaterThan(
        msg.indexOf("try syncing again"),
      );
    });

    it("never sends the user after a cable", () => {
      // The founder's words: "if the connection dropped after it already went
      // through a few steps this 100% doesn't mean try a new cable".
      expect(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE).not.toMatch(/cable/i);
    });

    it("says the drop is usually temporary, and names sleep", () => {
      const msg = BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE;
      expect(msg).toContain("This is often temporary — try syncing again");
      expect(msg).toContain("without a hub");
      expect(msg).toContain("neither device is going to sleep");
    });
  });

  describe("the two cases are different faults", () => {
    it("BACKLOG-2915 — the before-transfer message is the founder's exact wording", () => {
      // PINNED WHOLE, on purpose. This is founder-chosen copy of 2026-08-30, picked
      // knowingly over a longer variant that kept the cable advice, so the control is
      // the string itself rather than a set of clauses that a later edit could satisfy
      // while drifting the sentence.
      expect(BACKUP_CONNECTION_LOST_MESSAGE).toBe(
        "We couldn't get the backup going, and your iPhone didn't tell us why. " +
          "Start by unlocking it and tapping Trust This Computer if you're asked. " +
          "If that's not it, plug it straight into your Mac and try again.",
      );
    });

    it("BACKLOG-2915 — it no longer asserts a dropped connection, and no longer sends anyone after a cable", () => {
      // THE ASSERTION THIS FILE USED TO MAKE HERE WAS THE OPPOSITE, AND IT WAS RIGHT
      // AT THE TIME. This arm was reached only by reading
      // `usbmuxd_send returned -32 (Broken pipe)` off the `-d` debug stream, so it
      // really was a dropped USB link and hardware-first advice was correct.
      //
      // BACKLOG-2915 removed `-d`, so that line no longer exists and the arm is now
      // reached by INFERENCE — a non-zero exit with no device code. Causes that land
      // in that shape and are NOT link drops, from the binary's own string table:
      // `Could not connect to lockdownd` (not trusted, not paired, or locked — the
      // common one), `Could not start service com.apple.mobilebackup2`, `device
      // refused to start the backup process`, `backup protocol version mismatch`, and
      // an invalid backup directory. All of them happen before a byte moves, so all of
      // them take this arm.
      expect(BACKUP_CONNECTION_LOST_MESSAGE).not.toMatch(/cable/i);
      expect(BACKUP_CONNECTION_LOST_MESSAGE).not.toMatch(/connection .*dropped/i);
      // It says what is actually known, and leads with the two likeliest causes.
      expect(BACKUP_CONNECTION_LOST_MESSAGE).toMatch(/didn't tell us why/i);
      const unlockAt = BACKUP_CONNECTION_LOST_MESSAGE.indexOf("unlocking it");
      const trustAt = BACKUP_CONNECTION_LOST_MESSAGE.indexOf("Trust This Computer");
      const plugAt = BACKUP_CONNECTION_LOST_MESSAGE.indexOf("plug it straight");
      expect(unlockAt).toBeGreaterThan(0);
      expect(trustAt).toBeGreaterThan(unlockAt);
      expect(plugAt).toBeGreaterThan(trustAt);
    });

    it("the mid-transfer message DOES still assert a dropped connection, and is unchanged", () => {
      // The other arm is untouched, and the asymmetry is the point: once bytes have
      // moved the link demonstrably worked, so "the connection dropped" is a true
      // statement there and a claim we cannot support before any byte moves.
      expect(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE).toMatch(
        /connection to your iPhone dropped/i,
      );
    });

    it("the two cases produce different messages", () => {
      const before = classifyBackupFailure(
        255,
        STDOUT_NO_ERROR_LINE,
        UNPLUGGED_MID_TRANSFER_STDERR,
        false,
      );
      const after = classifyBackupFailure(
        255,
        STDOUT_NO_ERROR_LINE,
        UNPLUGGED_MID_TRANSFER_STDERR,
        true,
      );

      expect(before.message).toBe(BACKUP_CONNECTION_LOST_MESSAGE);
      expect(after.message).toBe(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE);
      expect(after.message).not.toBe(before.message);
    });

    it("classifies both as the same fault, with the same recorded cause", () => {
      // The split is copy, not classification. BACKLOG-2950 reads `failureCause`
      // and BACKLOG-2953 owns the error-code union; neither may shift here.
      const before = classifyBackupFailure(
        255,
        STDOUT_NO_ERROR_LINE,
        UNPLUGGED_MID_TRANSFER_STDERR,
        false,
      );
      const after = classifyBackupFailure(
        255,
        STDOUT_NO_ERROR_LINE,
        UNPLUGGED_MID_TRANSFER_STDERR,
        true,
      );

      expect(before.errorCode).toBe("CONNECTION_LOST");
      expect(after.errorCode).toBe("CONNECTION_LOST");
      expect(after.cause).toEqual(before.cause);
      expect(after.cause.deviceErrorCode).toBeNull();
      expect(after.cause.source).toBe("none");
    });

    it("neither message trips the orchestrator's disk-space tag", () => {
      // deviceSyncOrchestrator.ts:1213 is the ONLY place that matches backup error
      // TEXT rather than an error code: it tags Sentry `failure_reason:
      // "disk_space"` from this regex. Connection faults are not tagged by text at
      // all there, so splitting this message could not lose a tag — but a later copy
      // tweak could accidentally GAIN one, and mis-tag a cable pull as a full disk.
      // Hardcoded, not imported: that file is out of scope, and this is what keeps
      // the coupling honest — the same treatment the disk message already gets.
      const orchestratorDiskPattern = /disk space|no space|ENOSPC|not enough space/i;
      expect(orchestratorDiskPattern.test(BACKUP_CONNECTION_LOST_MESSAGE)).toBe(false);
      expect(
        orchestratorDiskPattern.test(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE),
      ).toBe(false);

      // BACKLOG-2915 — THE SHARED-OPENING-SENTENCE CONTROL WAS REMOVED HERE, AND IT
      // MUST NOT BE RESTORED.
      //
      // It asserted that both variants open with the same sentence, so that anything
      // keying on "the connection dropped" would see both. That was sound while the
      // two described the SAME event reached by the SAME evidence — the broken-pipe
      // line — and differed only in advice.
      //
      // They no longer describe the same event. After the `-d` removal the
      // before-transfer arm is reached by inference and says we do not know why; the
      // mid-transfer arm still reads a demonstrably-worked link and says it dropped.
      // Asserting a shared opening would now be asserting something false, and the
      // only way to satisfy it would be to bend the founder's chosen wording back
      // toward a claim the code cannot support.
      //
      // What replaced it: the exact-string pin and the two directional controls above,
      // plus rows 16/16b in `backupService.stdoutProgress-2915` which prove each
      // sentence is routed to the right shape through the real service.
    });

    it("defaults to the before-transfer message when the caller cannot say", () => {
      const unknown = classifyBackupFailure(
        255,
        STDOUT_NO_ERROR_LINE,
        UNPLUGGED_MID_TRANSFER_STDERR,
      );
      expect(unknown.message).toBe(BACKUP_CONNECTION_LOST_MESSAGE);
    });
  });

  describe("wired to the transfer signal, not to a byte count", () => {
    it("replays the founder's unplug: one batch done, then the cable out", async () => {
      // 95% -> 5% on the same total: BACKLOG-2915 reads the regression in `current` as
      // a batch boundary, folds 585.2 MB into the run total and opens a new batch.
      // (Before 2915 the same drop was read as a FILE boundary, which is what made
      // `filesTransferred` disagree with the device's own count by 159x.)
      const { result, state } = await runBackup((proc) =>
        unplug(proc, [
          progressBar(10, 61.6),
          progressBar(95, 585.2),
          progressBar(5, 12.0),
        ]),
      );

      expect(state.hasReceivedFileProgress).toBe(true);
      // BACKLOG-2915 (SR C1): THIS ASSERTION USED TO READ `toBeGreaterThan(0)`, AND IT
      // COULD NOT SEE THE THING THE COMMENT ABOVE PROMISES. The fold produces 597.2 MB
      // (585.2 banked + 12.0 in the newly-opened batch); a `bytesTransferred = current`
      // regression produces 12.0 MB. Both are greater than zero, so four separate
      // mutations to the batch-fold logic left the entire suite green. A test comment
      // that promises a future red is a second claim needing its own control, and the
      // control has to be the VALUE, never a floor.
      expect(state.bytesTransferred).toBeCloseTo(597.2 * 1024 * 1024, 0);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("CONNECTION_LOST");
      expect(result.error).toBe(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE);
    });

    it("a drop before the first progress bar still gets the hardware advice", async () => {
      const { result, state } = await runBackup((proc) => unplug(proc, []));

      expect(state.hasReceivedFileProgress).toBe(false);
      expect(state.bytesTransferred).toBe(0);
      expect(result.errorCode).toBe("CONNECTION_LOST");
      expect(result.error).toBe(BACKUP_CONNECTION_LOST_MESSAGE);
    });

    it("a drop inside the FIRST batch counts as transfer started, and now banks the real bytes", async () => {
      // BACKLOG-2915 CHANGED THIS TEST'S PREMISE, AND THE OLD PREMISE WAS THE BUG.
      //
      // It used to assert `bytesTransferred === 0` here and call the two signals
      // "genuinely disagreeing". They only disagreed because the byte counter was a
      // file-completion HEURISTIC: it advanced when the render's percentage dropped by
      // more than 50 from above 90, on the belief that the render was per-file. The
      // render is per-BATCH — `backup_real_size` / `backup_total_size` are locals of
      // `mb2_handle_receive_files()` — so 40% into a 616 MB batch, 246.4 MB really had
      // moved and the counter reported none of it.
      //
      // The claim this test exists for is unchanged and is still pinned below: the
      // DISCRIMINATOR is `hasReceivedFileProgress`, never a byte count. What is gone is
      // the artefact that made the two look like different signals.
      const { result, state } = await runBackup((proc) =>
        unplug(proc, [progressBar(10, 61.6), progressBar(40, 246.4)]),
      );

      expect(state.hasReceivedFileProgress).toBe(true);
      // 246.4 MB, 1024-based, as `string_format_size` prints it.
      expect(state.bytesTransferred).toBeCloseTo(246.4 * 1024 * 1024, 0);
      expect(result.error).toBe(BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE);
      expect(result.error).not.toBe(BACKUP_CONNECTION_LOST_MESSAGE);
    });
  });
});
