/**
 * BACKLOG-2913 — every backup failure said "iPhone is locked".
 *
 * `getErrorMessage` substring-matched the ENTIRE stderr stream in a fixed order, and
 * libimobiledevice writes `afc_lock(): Locked` and `np_lock(): Locked` as routine
 * mutex logging — hundreds of lines per run. The `locked` rung therefore matched on
 * every failure and every rung below it was unreachable in practice. Four different
 * causes were observed on the founder's machine on 2026-08-27 and all four showed
 * the same sentence, with the phone unlocked in his hand.
 *
 * ## Fixture provenance
 *
 * Every fixture below is TRANSCRIBED, not invented. Sources, stated per piece:
 *
 * - The mutex/polling cycle, the `afc_lock`/`afc_unlock` pairs, the
 *   `property_list_service.c:253 ... printing NNN bytes plist:` header, the
 *   multi-line tab-indented `DLMessageProcessMessage` envelope, the stdout failure
 *   block, and the `usbmuxd_send returned -32 (Broken pipe)` line all come from the
 *   founder's dev log (`keepr-dev/logs/main.log`) for 2026-08-27, the 22:35 and
 *   22:44 runs.
 * - The 105 code and its description come from the field-evidence comment on
 *   BACKLOG-2913, captured from the run earlier that evening whose log has since
 *   rotated away. The ENVELOPE around it is the transcribed 208 envelope with the
 *   code and description substituted — stated here rather than passed off as a
 *   verbatim capture.
 * - The `version exchange failed, error -5` line comes from BACKLOG-2951's runbook.
 *   It appears ZERO times in the 2026-08-27 log — that is a fact about the log,
 *   which does not receive everything the dev console emits, not about the device:
 *   the line was observed directly in the dev console at 20:29 and 21:57 that day.
 *   Treat the message it produces as unverified-in-field until it is captured.
 * - `No space left on device` is the ONE fixture below that is deliberately NOT
 *   transcribed. It appears zero times in that log, and is taken from
 *   IDEVICEBACKUP2_DISK_FULL_PATTERNS — the detector's own vocabulary — then planted
 *   in the debug stream on purpose, as a negative control. Stated at its use site.
 * - MBErrorDomain/4's device-supplied description was never captured. The fixture
 *   for it therefore carries NO description, which is also the harder case: the
 *   classifier must not need one.
 *
 * PII: the repo is public. The real run's UDID and the founder's device nickname are
 * scrubbed — no fixture below contains either, and the `lockdownd_client_new():
 * device udid:` line present in the real log is omitted entirely rather than
 * redacted in place.
 *
 * ## The control that makes these tests worth anything
 *
 * `disk-space failure buried in the real mutex flood` is the load-bearing one. Its
 * stderr is a 105 plist inside ~300 real mutex cycles, and `fixture is adversarial
 * to the old substring ladder` proves the fixture actually contains the words the
 * old ladder keyed on. Restoring the ladder must turn the first test red; a short,
 * clean stderr fixture would pass either way and prove nothing.
 *
 * Two further controls pin the ORDERING, which is what makes the surviving stderr
 * reads safe. `a broken-pipe teardown line does not outrank the device's own code`
 * pairs a device code with a broken-pipe line, as the real 208 run does, so the
 * anchored exit-255 patterns cannot be reordered above the device-code switch. `a
 * disk-full phrase present only in the debug stream decides nothing` pins the last
 * substring detector to idevicebackup2's own stdout. Both mutations used to leave
 * this suite entirely green.
 */

import {
  classifyBackupFailure,
  parseDeviceBackupError,
  BACKUP_HOST_DISK_FULL_MESSAGE,
  BACKUP_DEVICE_LOCKED_MESSAGE,
  BACKUP_CONNECTION_LOST_MESSAGE,
  BACKUP_STOPPED_STILL_CONNECTED_MESSAGE,
  BACKUP_SERVICE_UNAVAILABLE_MESSAGE,
  BACKUP_FILE_MISSING_MESSAGE,
} from "../backupService";

// ---------------------------------------------------------------------------
// Transcribed fixtures
// ---------------------------------------------------------------------------

/**
 * The polling cycle libimobiledevice emits continuously while a backup waits.
 * TRANSCRIBED verbatim from main.log 22:42:44–22:43:20 (only the timestamps vary).
 *
 * Note it contains BOTH `np_lock(): Locked` — the mutex trace that shadowed the
 * whole ladder — and `SSL_read 4, received 0`, which BACKLOG-2951 lists as a
 * USB-flapping signal but which appears here inside a run whose link was healthy.
 */
function pollingCycle(index: number): string {
  const ss = String(index % 60).padStart(2, "0");
  const t = `22:4${Math.floor(index / 600) % 10}:${ss}.273`;
  return [
    `${t} idevice.c:834 idevice_connection_receive_timeout(): SSL_read 4, received 0`,
    `${t} property_list_service.c:196 internal_plist_receive_timeout(): initial read failed!`,
    `${t} notification_proxy.c:275 np_get_notification(): NotificationProxy: no notification received!`,
    `${t} notification_proxy.c:67 np_unlock(): Unlocked`,
    `${t} notification_proxy.c:56 np_lock(): Locked`,
    `${t} idevice.c:979 internal_ssl_read(): pre-read length = 5 bytes`,
  ].join("\n");
}

/**
 * The AFC mutex pair, emitted around every file operation.
 * TRANSCRIBED verbatim from main.log 22:44:38.
 */
function afcLockCycle(index: number): string {
  const ss = String(index % 60).padStart(2, "0");
  const t = `22:44:${ss}.025`;
  return [
    `${t} afc.c:47 afc_lock(): Locked`,
    `${t} afc.c:974 afc_file_lock(): file handle 1`,
    `${t} afc.c:322 afc_receive_data(): got a status response, code=0`,
    `${t} afc.c:58 afc_unlock(): Unlocked`,
  ].join("\n");
}

/** ~300 cycles of each — the real cadence for a run of a few minutes. */
function mutexFlood(cycles = 300): string {
  const lines: string[] = [];
  for (let i = 0; i < cycles; i++) {
    lines.push(pollingCycle(i), afcLockCycle(i));
  }
  return lines.join("\n");
}

/**
 * The `DLMessageProcessMessage` response plist as `property_list_service.c:253`
 * prints it. TRANSCRIBED verbatim from main.log 22:44:38, including the tab
 * indentation and the keys and values sitting on SEPARATE lines — a pattern written
 * against a one-line `<key>ErrorCode</key><integer>N</integer>` matches a fixture
 * and never a real device.
 */
function dlProcessMessagePlist(code: number, description: string | null): string {
  const descriptionLines =
    description === null
      ? ""
      : `\t\t<key>ErrorDescription</key>\n\t\t<string>${description}</string>\n`;
  return `22:44:38.022 property_list_service.c:253 internal_plist_receive_timeout(): printing 433 bytes plist:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
\t<string>DLMessageProcessMessage</string>
\t<dict>
\t\t<key>ErrorCode</key>
\t\t<integer>${code}</integer>
${descriptionLines}\t\t<key>MessageName</key>
\t\t<string>Response</string>
\t</dict>
</array>
</plist>`;
}

/**
 * The unrelated `Shutdown` command plist, which also appears on stderr.
 * TRANSCRIBED from main.log 22:35:44 — present so the scoped parse is exercised
 * against a real neighbour rather than only against the block it wants.
 */
const SHUTDOWN_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>Command</key>
\t<string>Shutdown</string>
</dict>
</plist>`;

/**
 * idevicebackup2's own summary on STDOUT.
 * TRANSCRIBED verbatim from main.log 22:44:38 (`[BackupService] stdout:`).
 */
function stdoutFailureBlock(code: number, description: string): string {
  return `Backup directory is "/Users/tester/Library/Application Support/keepr/Backups"
Started "com.apple.mobilebackup2" service on port 49907.
Negotiated Protocol Version 2.1
Reading Info.plist from backup.
Starting backup...
Backup will be unencrypted.
Requesting backup from device...
Incremental backup mode.
*** Waiting for passcode to be entered on the device ***
ErrorCode ${code}: ${description}
Received 0 files from device.
Backup Failed (Error Code ${code}).`;
}

/** Stdout of a run that never got far enough to report anything. */
const STDOUT_NO_ERROR_LINE = `Backup directory is "/Users/tester/Library/Application Support/keepr/Backups"
Started "com.apple.mobilebackup2" service on port 49907.
Negotiated Protocol Version 2.1
Reading Info.plist from backup.
Starting backup...
Requesting backup from device...`;

const DISK_FULL_DESCRIPTION =
  "Insufficient free disk space on drive to back up (MBErrorDomain/105)";
const DEVICE_LOCKED_DESCRIPTION = "Device locked (MBErrorDomain/208)";

/** TRANSCRIBED from main.log 22:35:45 — the link dying mid-run. */
const BROKEN_PIPE_TAIL = `22:35:45.355 idevice.c:1017 internal_ssl_write(): pre-send length = 31 bytes
22:35:45.355 idevice.c:643 internal_connection_send(): ERROR: usbmuxd_send returned -32 (Broken pipe)
22:35:45.355 idevice.c:1019 internal_ssl_write(): ERROR: internal_connection_send returned -2
22:35:45.356 idevice.c:1550 idevice_connection_disable_bypass_ssl(): SSL mode disabled`;

/**
 * The SAME teardown block, from the 22:44:38 run — the one that ended in
 * device-locked/208 with the phone genuinely locked. TRANSCRIBED verbatim from
 * main.log 22:44:38.163, which is 141ms after the 208 plist above it.
 *
 * `usbmuxd_send returned -32 (Broken pipe)` appears at teardown in FOUR of the five
 * failures on 2026-08-27, including this device-locked one. It is emitted as the
 * connection tears down whatever the cause, so on its own it is not a link-drop
 * discriminator — the same shape as `SSL_read 4, received 0`, one rung further down.
 * The classifier survives it only because the device's own code outranks it.
 */
const BROKEN_PIPE_TAIL_DEVICE_LOCKED_RUN = `22:44:38.163 idevice.c:1017 internal_ssl_write(): pre-send length = 31 bytes
22:44:38.163 idevice.c:643 internal_connection_send(): ERROR: usbmuxd_send returned -32 (Broken pipe)
22:44:38.163 idevice.c:1019 internal_ssl_write(): ERROR: internal_connection_send returned -2
22:44:38.163 idevice.c:1550 idevice_connection_disable_bypass_ssl(): SSL mode disabled`;

/** TRANSCRIBED from BACKLOG-2951's runbook — the mobilebackup2 service stuck. */
const VERSION_EXCHANGE_TAIL = `22:54:30.508 mobilebackup2.c:216 mobilebackup2_client_new(): version exchange failed, error -5
Could not perform backup protocol version exchange, error code -1`;

describe("BACKLOG-2913: backup failures report the cause the device gave", () => {
  describe("the load-bearing control", () => {
    it("fixture is adversarial to the old substring ladder", () => {
      // Without this, the control below could pass on a fixture that never
      // exercised the defect. The old ladder tested `locked` BEFORE `disk`/`space`,
      // so a fixture only proves something if it contains both.
      const stderr =
        mutexFlood() +
        "\n" +
        dlProcessMessagePlist(105, DISK_FULL_DESCRIPTION);
      const lower = stderr.toLowerCase();

      expect(lower).toContain("locked");
      expect(lower).toContain("disk");
      expect(lower).toContain("space");
      // And the shadowing is not incidental — it is overwhelming.
      expect(stderr.match(/Locked/g)!.length).toBeGreaterThan(500);
      // The `locked` chatter physically precedes the real answer, which is why
      // a first-match-wins ladder can never reach it.
      expect(lower.indexOf("locked")).toBeLessThan(
        lower.indexOf("insufficient free disk space"),
      );
    });

    it("disk-space failure buried in the real mutex flood reports disk space, not a locked phone", () => {
      // The exact shape of the founder's failure: the device answered 105 in a
      // plist on stderr, drowned in mutex logging, and he was told to unlock a
      // phone that was unlocked in his hand.
      const stderr =
        mutexFlood() +
        "\n" +
        dlProcessMessagePlist(105, DISK_FULL_DESCRIPTION) +
        "\n" +
        afcLockCycle(1);

      const result = classifyBackupFailure(151, STDOUT_NO_ERROR_LINE, stderr);

      expect(result.message).toBe(BACKUP_HOST_DISK_FULL_MESSAGE);
      expect(result.message).not.toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
      expect(result.errorCode).toBe("INSUFFICIENT_SPACE");
      expect(result.cause.deviceErrorCode).toBe(105);
      expect(result.cause.source).toBe("stderr-plist");
    });
  });

  describe("one message per observed cause", () => {
    it("MBErrorDomain/105 (host disk full, exit 151) reports disk space", () => {
      const result = classifyBackupFailure(
        151,
        stdoutFailureBlock(105, DISK_FULL_DESCRIPTION),
        mutexFlood(20),
      );
      expect(result.message).toBe(BACKUP_HOST_DISK_FULL_MESSAGE);
      expect(result.errorCode).toBe("INSUFFICIENT_SPACE");
    });

    it("MBErrorDomain/208 (device locked, exit 48) reports a locked phone", () => {
      // The one time the old code was right, and it must stay right.
      const result = classifyBackupFailure(
        48,
        stdoutFailureBlock(208, DEVICE_LOCKED_DESCRIPTION),
        mutexFlood(20) + "\n" + dlProcessMessagePlist(208, DEVICE_LOCKED_DESCRIPTION),
      );
      expect(result.message).toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
      expect(result.errorCode).toBe("DEVICE_LOCKED");
      expect(result.cause.deviceErrorCode).toBe(208);
    });

    it("MBErrorDomain/4 reports a missing backup file, with no description available", () => {
      const result = classifyBackupFailure(
        252,
        STDOUT_NO_ERROR_LINE,
        mutexFlood(20) + "\n" + dlProcessMessagePlist(4, null),
      );
      expect(result.message).toBe(BACKUP_FILE_MISSING_MESSAGE);
      expect(result.errorCode).toBe("BACKUP_FILE_MISSING");
      expect(result.cause.deviceErrorCode).toBe(4);
      expect(result.cause.deviceErrorDescription).toBeNull();
    });

    it("exit 255 with a broken pipe reports a dropped connection", () => {
      const result = classifyBackupFailure(
        255,
        STDOUT_NO_ERROR_LINE,
        mutexFlood(20) + "\n" + BROKEN_PIPE_TAIL,
      );
      expect(result.message).toBe(BACKUP_CONNECTION_LOST_MESSAGE);
      expect(result.errorCode).toBe("CONNECTION_LOST");
    });

    it("exit 255 with a failed version exchange reports a stuck backup service", () => {
      const result = classifyBackupFailure(
        255,
        STDOUT_NO_ERROR_LINE,
        mutexFlood(20) + "\n" + VERSION_EXCHANGE_TAIL,
      );
      expect(result.message).toBe(BACKUP_SERVICE_UNAVAILABLE_MESSAGE);
      expect(result.errorCode).toBe("SERVICE_UNAVAILABLE");
    });

    it("the four observed causes produce four different messages", () => {
      // Collapsing any pair of these to a shared constant must go red. That
      // collapse — four causes, one sentence — IS the defect.
      const messages = [
        classifyBackupFailure(
          151,
          stdoutFailureBlock(105, DISK_FULL_DESCRIPTION),
          mutexFlood(10),
        ).message,
        classifyBackupFailure(
          48,
          stdoutFailureBlock(208, DEVICE_LOCKED_DESCRIPTION),
          mutexFlood(10),
        ).message,
        classifyBackupFailure(
          255,
          STDOUT_NO_ERROR_LINE,
          mutexFlood(10) + "\n" + BROKEN_PIPE_TAIL,
        ).message,
        classifyBackupFailure(
          255,
          STDOUT_NO_ERROR_LINE,
          mutexFlood(10) + "\n" + VERSION_EXCHANGE_TAIL,
        ).message,
      ];
      expect(new Set(messages).size).toBe(4);
    });
  });

  describe("mutex chatter and polling noise decide nothing", () => {
    it("hundreds of `Locked` mutex traces alone do not make a locked-phone message", () => {
      const result = classifyBackupFailure(255, STDOUT_NO_ERROR_LINE, mutexFlood());
      expect(result.message).not.toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
      expect(result.cause.deviceErrorCode).toBeNull();
    });

    it("`SSL_read 4, received 0` does not make a dropped-connection message", () => {
      // BACKLOG-2951 lists it as a USB-flapping signal, but the 2026-08-27 log has
      // ~30 of them inside the run that ended in device-locked/208 on a healthy
      // link. Reading it as a link drop would rebuild this bug one rung down.
      const stderr = mutexFlood(30);
      expect(stderr).toContain("SSL_read 4, received 0");

      const result = classifyBackupFailure(
        48,
        stdoutFailureBlock(208, DEVICE_LOCKED_DESCRIPTION),
        stderr + "\n" + dlProcessMessagePlist(208, DEVICE_LOCKED_DESCRIPTION),
      );
      expect(result.message).toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
      expect(result.message).not.toBe(BACKUP_CONNECTION_LOST_MESSAGE);
    });

    it("a broken-pipe teardown line does not outrank the device's own code", () => {
      // The 22:44:38 run replayed whole: the device answered 208 on stdout AND in
      // the stderr plist, and the link then tore down with `usbmuxd_send returned
      // -32 (Broken pipe)` 141ms later. That token appears at teardown in four of
      // the five failures on 2026-08-27, including this device-locked one, so it is
      // teardown chatter rather than a link-drop signal.
      //
      // Until this test no fixture paired a device code WITH a broken-pipe line,
      // even though the real 208 stderr contains both. Moving
      // CONNECTION_DROPPED_PATTERN above the device-code switch therefore left the
      // whole suite green — while telling the founder to try a different cable for a
      // phone that was simply locked.
      const stderr =
        mutexFlood(20) +
        "\n" +
        dlProcessMessagePlist(208, DEVICE_LOCKED_DESCRIPTION) +
        "\n" +
        afcLockCycle(1) +
        "\n" +
        BROKEN_PIPE_TAIL_DEVICE_LOCKED_RUN;

      // The fixture is worth nothing unless it really carries both signals, in the
      // order the device emitted them.
      expect(stderr).toContain("usbmuxd_send returned -32 (Broken pipe)");
      expect(stderr).toContain("<integer>208</integer>");
      expect(stderr.indexOf("<integer>208</integer>")).toBeLessThan(
        stderr.indexOf("usbmuxd_send returned -32 (Broken pipe)"),
      );

      const result = classifyBackupFailure(
        48,
        stdoutFailureBlock(208, DEVICE_LOCKED_DESCRIPTION),
        stderr,
      );

      expect(result.message).toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
      expect(result.message).not.toBe(BACKUP_CONNECTION_LOST_MESSAGE);
      expect(result.errorCode).toBe("DEVICE_LOCKED");
      expect(result.cause.deviceErrorCode).toBe(208);
    });

    it("`PasswordProtected` and `TrustedHostAttached` plist keys decide nothing", () => {
      // The other three rungs of the old ladder, shadowed by `locked` and equally
      // poisoned: all three words occur as ordinary plist key names.
      const stderr =
        mutexFlood(10) +
        "\n<key>PasswordProtected</key>\n<false/>\n" +
        "<key>TrustedHostAttached</key>\n<true/>\n" +
        "<key>PairRecordProtectionClass</key>\n<integer>3</integer>\n" +
        dlProcessMessagePlist(105, DISK_FULL_DESCRIPTION);

      const result = classifyBackupFailure(151, STDOUT_NO_ERROR_LINE, stderr);
      expect(result.message).toBe(BACKUP_HOST_DISK_FULL_MESSAGE);
    });

    it("a disk-full phrase present only in the debug stream decides nothing", () => {
      // The last substring detector left standing is BACKLOG-2899's, and it reads
      // idevicebackup2's own stdout. Re-admitting the debug stream to that one call
      // — `isIdevicebackup2DiskFullOutput(stdout) || isIdevicebackup2DiskFullOutput(stderr)`
      // — is the exact defect this change exists to prevent, and until this test it
      // left the whole suite green.
      //
      // Fixture provenance, stated because this one is NOT a transcription: `No
      // space left on device` appears ZERO times in the founder's 2026-08-27 log
      // (his disk-full run predates it and that log has since rotated away). The
      // phrase is taken from IDEVICEBACKUP2_DISK_FULL_PATTERNS — the detector's own
      // vocabulary — and planted in the debug stream deliberately. That is the
      // point: a phrase the detector DOES recognise must still decide nothing when
      // it arrives on the stream that is full of routine chatter.
      const stderr = mutexFlood(5) + "\nNo space left on device";

      const result = classifyBackupFailure(255, STDOUT_NO_ERROR_LINE, stderr);

      expect(result.errorCode).not.toBe("INSUFFICIENT_SPACE");
      expect(result.message).not.toBe(BACKUP_HOST_DISK_FULL_MESSAGE);
      expect(result.cause.source).toBe("none");
    });
  });

  describe("the disk message's clauses, asserted independently", () => {
    // Asserting one full string would let a copy tweak silently drop a clause.
    // Each of these cost the founder real time on 2026-08-27.

    it("names THIS MAC, because the device's own wording names no drive", () => {
      // "Insufficient free disk space on drive to back up" sent him to his
      // iPhone's storage screen, where he saw 80 GB free.
      expect(BACKUP_HOST_DISK_FULL_MESSAGE).toMatch(/this Mac/i);
    });

    it("warns that macOS counts snapshot space the backup cannot use", () => {
      // The Storage pane said 283 GB; df, diskutil, statfs and idevicebackup2 all
      // said 23 GB. Without this clause the message reads as a bug in Keepr.
      expect(BACKUP_HOST_DISK_FULL_MESSAGE).toMatch(
        /snapshot|purgeable|reclaimable/i,
      );
    });

    it("does not tell the user to delete files, which can free nothing", () => {
      // Measured three times: 20 GB deleted freed 4 GB, then 26 GB freed 0,
      // then 25 GB freed 0 — the blocks stay pinned in local snapshots.
      expect(BACKUP_HOST_DISK_FULL_MESSAGE).toMatch(
        /deleting files often frees nothing/i,
      );
    });

    it("still matches the orchestrator's disk-space Sentry tag", () => {
      // deviceSyncOrchestrator.ts:1213 tests backupResult.error with this exact
      // regex to tag `failure_reason: "disk_space"`. Hardcoded here, not imported:
      // that file is out of scope, and this test is what keeps the coupling honest.
      const orchestratorPattern = /disk space|no space|ENOSPC|not enough space/i;
      expect(orchestratorPattern.test(BACKUP_HOST_DISK_FULL_MESSAGE)).toBe(true);
    });
  });

  describe("what we do not know, we say", () => {
    it("an unmapped device code is reported with its number and the device's own words", () => {
      const result = classifyBackupFailure(
        200,
        stdoutFailureBlock(56, "Unable to write to the backup (MBErrorDomain/56)"),
        mutexFlood(10),
      );
      expect(result.message).toContain("56");
      expect(result.message).toContain(
        "Unable to write to the backup (MBErrorDomain/56)",
      );
      expect(result.message).not.toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
      expect(result.errorCode).toBe("UNKNOWN_ERROR");
      expect(result.cause.deviceErrorCode).toBe(56);
    });

    it("BACKLOG-2915 — a non-zero exit with no reported cause is now INFERRED as a link drop", async () => {
      // THIS EXPECTATION IS DELIBERATELY INVERTED, BY FOUNDER DECISION OF 2026-08-30.
      //
      // It used to assert the generic "neither this Mac nor your iPhone reported a
      // reason (exit code 255)". That was the right answer while `usbmuxd_send returned
      // -N (Broken pipe)` existed to carry the real link-drop class — but that line was
      // `debug_info()` output and only ever appeared under `-d`, which BACKLOG-2915
      // removes. Scale, from this file's own transcription: broken-pipe appears in FOUR
      // OF THE FIVE real failures of 2026-08-27, and four of those five captured zero
      // stdout. Leaving them on the generic rung would take three user-facing sentences
      // down with them, including the mid-transfer copy the founder wrote himself.
      //
      // So the class is inferred instead: non-zero exit, no device code, no
      // version-exchange match. It is weaker than reading the line and it will also
      // catch a future unclassified non-zero exit — recorded on BACKLOG-2915 as the
      // accepted cost, which is also why the cancel rung sits above it.
      //
      // ROUND 4 (2026-08-31) CHANGED THE SENTENCE, NOT THE CLASSIFICATION. The link drop
      // is now OBSERVED — from the OS's disconnect event and idevicebackup2's own
      // channel-failure line — so this rung, reached with neither of those, means "the
      // phone is still attached and nobody said why". It keeps `CONNECTION_LOST` (a
      // naming inaccuracy filed separately) and gets its own founder-chosen sentence,
      // which denies the cable instead of suggesting one. See ROW 49/50/51 in
      // `backupService.stdoutProgress-2915` for the three selection paths.
      const result = classifyBackupFailure(255, STDOUT_NO_ERROR_LINE, mutexFlood(50));
      expect(result.errorCode).toBe("CONNECTION_LOST");
      expect(result.message).toBe(BACKUP_STOPPED_STILL_CONNECTED_MESSAGE);
      expect(result.cause.linkDropEvidence).toBe("inferred");
      expect(result.message).not.toBe(BACKUP_DEVICE_LOCKED_MESSAGE);
      // The exit code is still carried, in the structured cause rather than the
      // sentence — BACKLOG-2950 reads it from there.
      expect(result.cause.exitCode).toBe(255);
      expect(result.cause.deviceErrorCode).toBeNull();
    });

    it("THE CONTROL — exit 0 with no reported cause still gets the generic sentence", () => {
      // The generic rung is not dead: the inference rung is gated on a NON-ZERO exit,
      // so a failure that exits 0 (BACKLOG-2899's silent truncation shape) is still
      // reported as unexplained rather than blamed on the cable.
      const result = classifyBackupFailure(0, STDOUT_NO_ERROR_LINE, "");
      expect(result.errorCode).toBe("UNKNOWN_ERROR");
      expect(result.message).toMatch(/did not report|no.*reason|neither/i);
      expect(result.message).not.toBe(BACKUP_CONNECTION_LOST_MESSAGE);
    });

    it("a null exit code does not print `exit code null`", () => {
      const result = classifyBackupFailure(null, "", "");
      expect(result.message).not.toContain("null");
      expect(result.cause.exitCode).toBeNull();
    });
  });

  describe("the structured cause survives, for BACKLOG-2950", () => {
    it("carries code, description, exit code and source together", () => {
      const result = classifyBackupFailure(
        151,
        stdoutFailureBlock(105, DISK_FULL_DESCRIPTION),
        mutexFlood(10),
      );
      expect(result.cause).toEqual({
        deviceErrorCode: 105,
        deviceErrorDescription: DISK_FULL_DESCRIPTION,
        exitCode: 151,
        source: "stdout-line",
      });
    });

    it("records `none` when neither stream reported a code", () => {
      const result = classifyBackupFailure(255, STDOUT_NO_ERROR_LINE, mutexFlood(10));
      expect(result.cause.source).toBe("none");
      expect(result.cause.deviceErrorCode).toBeNull();
    });
  });

  describe("parseDeviceBackupError", () => {
    it("prefers the stdout line, which survives the 64KB tail cap", () => {
      // stdout is low-volume; the debug stream can push the plist out of the
      // buffer entirely. When both are present and disagree, stdout wins.
      const parsed = parseDeviceBackupError(
        stdoutFailureBlock(105, DISK_FULL_DESCRIPTION),
        dlProcessMessagePlist(208, DEVICE_LOCKED_DESCRIPTION),
      );
      expect(parsed.deviceErrorCode).toBe(105);
      expect(parsed.source).toBe("stdout-line");
    });

    it("falls back to the stderr plist when stdout carries no error line", () => {
      const parsed = parseDeviceBackupError(
        STDOUT_NO_ERROR_LINE,
        mutexFlood(10) + "\n" + dlProcessMessagePlist(105, DISK_FULL_DESCRIPTION),
      );
      expect(parsed.deviceErrorCode).toBe(105);
      expect(parsed.deviceErrorDescription).toBe(DISK_FULL_DESCRIPTION);
      expect(parsed.source).toBe("stderr-plist");
    });

    it("ignores plists that are not a DLMessageProcessMessage response", () => {
      const parsed = parseDeviceBackupError(
        STDOUT_NO_ERROR_LINE,
        SHUTDOWN_PLIST + "\n" + mutexFlood(5),
      );
      expect(parsed.deviceErrorCode).toBeNull();
      expect(parsed.source).toBe("none");
    });

    it("takes the LAST response when a run reports several", () => {
      const stderr = [
        dlProcessMessagePlist(208, DEVICE_LOCKED_DESCRIPTION),
        mutexFlood(5),
        dlProcessMessagePlist(105, DISK_FULL_DESCRIPTION),
      ].join("\n");
      const parsed = parseDeviceBackupError(STDOUT_NO_ERROR_LINE, stderr);
      expect(parsed.deviceErrorCode).toBe(105);
    });

    it("decodes XML entities in the device's description", () => {
      const parsed = parseDeviceBackupError(
        "",
        dlProcessMessagePlist(56, "Backup &quot;Snapshot&quot; failed &amp; stopped"),
      );
      expect(parsed.deviceErrorDescription).toBe(
        'Backup "Snapshot" failed & stopped',
      );
    });
  });
});
