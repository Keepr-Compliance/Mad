/**
 * Backup Service
 *
 * Handles iPhone backup operations using idevicebackup2 CLI tool.
 * Extracts messages and contacts from iPhone backups.
 * Supports encrypted backup decryption (TASK-007).
 *
 * IMPORTANT: Domain filtering is NOT supported by idevicebackup2, and neither
 * is excluding app data. The iOS MobileBackup2 protocol offers no way to request
 * a subset of domains, and the `backup` command takes exactly one option, --full.
 * Every backup this service takes is therefore a FULL device backup, app data
 * included, and its size is not something the argv can influence.
 * See docs/BACKUP_RESEARCH.md for the measurements behind both statements.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import { app } from "electron";
import { promises as fs } from "fs";
import * as Sentry from "@sentry/electron/main";
import log from "electron-log";
import { getCommand, isMockMode } from "./libimobiledeviceService";
import { backupDecryptionService } from "./backupDecryptionService";
import {
  BackupProgress,
  BackupResult,
  BackupOptions,
  BackupCapabilities,
  BackupInfo,
  BackupStatus,
  BackupEncryptionInfo,
  BackupErrorCode,
  BackupSizeReading,
  BackupStatusReport,
  BackupFailureCause,
} from "../types/backup";
import { validateDeviceUdid, ValidationError } from "../utils/validation";

/**
 * BACKLOG-2917: a short, log-safe description of a caught value.
 *
 * The three-state values in this file carry a `reason` so that "we do not know" can
 * say WHY when it reaches a log or a Sentry event. Without it the new unknown state
 * would be as mute as the `null` it replaces — distinguishable by the machine but
 * not diagnosable by a human reading a support log.
 */
function describeError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * BACKLOG-2899: how idevicebackup2 reports that the HOST disk is full.
 *
 * TRANSCRIBED, in two steps, because BACKLOG-2870 is the precedent for a
 * detector written against an invented string (SQLite's real
 * "database or disk is full" matched none of the patterns hunting for it).
 *
 * 1. The format string, `strings`-ed out of the binary this app actually ships,
 *    resources/win/libimobiledevice/idevicebackup2.exe:
 *
 *        Error opening '%s' for writing: %s
 *
 *    and from libimobiledevice tools/idevicebackup2.c, mb2_handle_receive_files(),
 *    which is where that line is produced:
 *
 *        errcode = errno_to_device_error(errno);
 *        errdesc = strerror(errno);
 *        progress_printf("Error opening '%s' for writing: %s\n", bname, errdesc);
 *
 * 2. The `%s` tail is `strerror(errno)`, supplied by the C runtime rather than
 *    embedded in the executable — so it is NOT in the binary's strings, and this
 *    step is INFERRED, not transcribed from an observed failure: Windows maps
 *    ERROR_DISK_FULL to ENOSPC via _dosmaperr, and UCRT, glibc and BSD all
 *    render ENOSPC as "No space left on device". The Win32-phrasing and ENOSPC
 *    alternates below are belt-and-braces for a build that formats it
 *    differently.
 *
 * Note what this detector CANNOT see, which is why BACKLOG-2899 does not rely on
 * it: in the same function the host-side write is `fwrite(buf, 1, r, f);` with
 * the return value never checked, and `fclose(f)` unchecked too. A full disk is
 * therefore usually absorbed in silence — truncated files, exit code 0, and
 * "Backup Successful." on stdout. The mid-transfer free-space monitor in
 * deviceSyncOrchestrator is the actual guard; this is the backstop.
 */
export const IDEVICEBACKUP2_DISK_FULL_PATTERNS: readonly RegExp[] = [
  /no space left on device/i,
  /not enough space on the disk/i,
  /there is not enough space on the disk/i,
  /\bENOSPC\b/,
  /disk (?:is )?full/i,
];

/**
 * BACKLOG-2899: true when idevicebackup2 output reports a full host disk.
 *
 * Reads STDOUT, not stderr: progress_printf() is `vprintf()`, so every one of
 * these lines goes to stdout. backupService only ever fed `stderrBuffer` to
 * getErrorMessage(), so before this the message could not reach any detector.
 */
export function isIdevicebackup2DiskFullOutput(output: string): boolean {
  return IDEVICEBACKUP2_DISK_FULL_PATTERNS.some((p) => p.test(output));
}

// ============================================================================
// BACKLOG-2913: what actually went wrong, read from the device instead of guessed
// ============================================================================

/**
 * MBErrorDomain codes this app has a specific answer for.
 *
 * 105 and 208 were both OBSERVED on the founder's machine on 2026-08-27, with the
 * exit codes noted. 4 is the code `idevicebackup2 info` returns for a missing
 * `Status.plist` (BACKLOG-2951 uses it as the "service is healthy" probe result);
 * its device-supplied description has never been captured here, so nothing in this
 * file asserts a wording for it.
 *
 * The exit code appears to be `(-deviceCode) & 0xFF` — 208 exits 48, 105 exits 151,
 * and both satisfy it. It is NOT used to classify anything: two data points is not a
 * rule, and exit 255 (seen twice, for two different connection faults) would invert
 * to a bogus device code 1.
 */
export const MB_ERROR_HOST_DISK_FULL = 105;
export const MB_ERROR_DEVICE_LOCKED = 208;
export const MB_ERROR_FILE_MISSING = 4;

/**
 * BACKLOG-2913: the disk-space message, in one place.
 *
 * Two code paths report a full host disk — this one, and the BACKLOG-2899
 * `diskFullDetected` flag set from stdout during the run. They had different
 * wording, so which sentence the user saw depended on which detector fired first.
 *
 * Three things this sentence has to do, each learned the hard way on 2026-08-27:
 *
 * 1. **Name the Mac.** The device's own `ErrorDescription` is "Insufficient free
 *    disk space on drive to back up" and names no drive. The founder read it, opened
 *    his iPhone's storage screen, saw 80 GB free, and concluded the app was broken.
 * 2. **Warn that macOS disagrees.** The Storage pane said 283 GB free while `df`,
 *    `diskutil`, `statfs` and idevicebackup2 all said 23 GB. The gap is local Time
 *    Machine snapshots. Saying "not enough space" to someone looking at 283 GB reads
 *    as a bug in Keepr, every time, for every user with Time Machine configured.
 * 3. **Not say "delete some files".** Measured three times that evening: deleting
 *    20 GB freed 4 GB, deleting 26 GB freed 0, deleting 25 GB freed 0 — the blocks
 *    stay pinned in snapshots. Telling a user to free space by deleting can
 *    accomplish literally nothing.
 *
 * It deliberately quotes no required size: the estimate is ~3x low and belongs to
 * BACKLOG-2918. A wrong number here would be a fourth thing to disbelieve.
 *
 * Keeps the literal substring "disk space" so that deviceSyncOrchestrator's
 * `/disk space|no space|ENOSPC|not enough space/i` Sentry tag still fires. That
 * coupling is asserted by a test rather than left to be rediscovered.
 */
export const BACKUP_HOST_DISK_FULL_MESSAGE =
  "Not enough free disk space on this Mac to back up your iPhone. " +
  "Your Mac may report far more space than this: macOS counts space held by local " +
  "Time Machine snapshots as free, and a backup cannot use it. Deleting files often " +
  "frees nothing while those snapshots are holding them.";

/** BACKLOG-2913: correct for MBErrorDomain/208, and now shown only for it. */
export const BACKUP_DEVICE_LOCKED_MESSAGE =
  "iPhone is locked. Please unlock your iPhone and try again, and leave it unlocked " +
  "while the sync runs.";

/**
 * The backup stopped BEFORE any file transfer began, and nothing said why.
 *
 * BACKLOG-2915 REWROTE THIS SENTENCE, AND THE REASON IS THAT THE BRANCH BELOW IT
 * CHANGED MEANING. It used to be reached only by reading
 * `usbmuxd_send returned -32 (Broken pipe)` off the `-d` debug stream, so it really
 * was a dropped USB link and hardware-first advice was correct. That line does not
 * exist any more (see {@link CONNECTION_DROPPED_PATTERN}), and this message is now
 * reached by INFERENCE — a non-zero exit with no device code, no version-exchange
 * match, no disk-full and no cancel.
 *
 * Several common causes land in that shape and are NOT link drops. From the string
 * table of the binary this app executes:
 *
 *   - `Could not connect to lockdownd` — the iPhone is not trusted, not paired, or
 *     locked at connect. This is the frequent one.
 *   - `Could not start service com.apple.mobilebackup2`
 *   - `device refused to start the backup process` / `backup protocol version
 *     mismatch` — note neither is matched by SERVICE_VERSION_EXCHANGE_PATTERN.
 *   - `Backup directory "…" is invalid. No Info.plist found` — reachable after a
 *     partial reset.
 *
 * All of those happen before a single byte moves, so all of them take this arm. The
 * old sentence opened by asserting the connection dropped and led with "Try a
 * different cable", which sent a user whose iPhone simply was not trusted hunting for
 * a hardware fault.
 *
 * FOUNDER-CHOSEN WORDING, 2026-08-30, picked knowingly over a longer variant that kept
 * the cable advice. It claims only what is known, and it leads with the two causes
 * that are far more likely than a cable — locked, and not trusted. Do not add hardware
 * advice back; `backupService.connectionCopy-2913` pins the exact string.
 *
 * See {@link BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE} for the other arm, which is
 * unchanged: once bytes have moved the link demonstrably worked, so asserting a
 * dropped connection there is still true.
 */
export const BACKUP_CONNECTION_LOST_MESSAGE =
  "We couldn't get the backup going, and your iPhone didn't tell us why. Start by " +
  "unlocking it and tapping Trust This Computer if you're asked. If that's not it, " +
  "plug it straight into your Mac and try again.";

/**
 * BACKLOG-2913: the USB link dropped AFTER file transfer had begun. Same exit code,
 * same broken-pipe line, different fault — and it needs different advice.
 *
 * The founder tested the classifier on real hardware on 2026-08-28: an incremental
 * sync, `File transfer started after 684.6s` (so: enumerated, paired, passcode
 * entered), one 616 MB file completed, then he unplugged the cable. The classifier
 * named the connection correctly — the old code would have said "iPhone is locked" —
 * but the message told him to try a different cable.
 *
 * His objection, and it is right: **a drop eleven minutes in, after a successful
 * handshake and 616 MB, is almost never a faulty cable.** A bad cable fails at
 * enumeration or within seconds. The realistic causes of a MID-TRANSFER drop are the
 * Mac sleeping, the phone sleeping or locking, USB power management suspending the
 * port, a hub renegotiating, or the user unplugging it. Cable fault is the least
 * likely of them once bytes have moved, and leading with it sends a user hunting for
 * a hardware problem they do not have.
 *
 * So: the action that actually works comes first, and hardware comes last.
 */
export const BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE =
  "The connection to your iPhone dropped during the backup. This is often " +
  "temporary — try syncing again. If it keeps happening, plug the iPhone " +
  "straight into this Mac without a hub, and check that neither device is going " +
  "to sleep.";

/**
 * BACKLOG-2915 (round 4): the backup stopped, nothing said why, AND THE PHONE IS STILL
 * PLUGGED IN.
 *
 * The third sentence in this family, and it exists because the branch that reaches it
 * stopped being a link drop. Until round 4 this case shared
 * {@link BACKUP_CONNECTION_LOST_MESSAGE}, whose closing advice is "plug it straight into
 * your Mac" — advice that is actively wrong for a device that never left.
 *
 * The rung it serves is the D1 inference: a non-zero exit, no device code, no
 * version-exchange match, no disk-full, no cancel, and — new in round 4 — **no observed
 * disconnect from either the OS or idevicebackup2 itself**. What is left is genuinely
 * unexplained, and the honest thing is to say so and ask for one retry.
 *
 * FOUNDER-CHOSEN WORDING, 2026-08-31, picked over a variant that added "restart your
 * iPhone" as a fallback. **Do not add a restart step.** The exact string is pinned in
 * `backupService.connectionCopy-2913`.
 *
 * ## THE `errorCode` FOR THIS BRANCH IS STILL `CONNECTION_LOST`, AND IT CONTRADICTS THIS
 * ## SENTENCE. **FIX THE CODE, NEVER THE SENTENCE.**
 *
 * This paragraph is load-bearing and must not be weakened or deleted. It is the whole
 * safety of a deliberate deferral (SR round 4, 2026-08-31), and the failure it prevents
 * is specific: a future reader notices that a branch labelled `CONNECTION_LOST` tells the
 * user it is *not* a connection problem, concludes the MESSAGE is the bug, and "fixes"
 * it — putting cable advice back in front of a user whose iPhone never left. That is the
 * exact defect this branch spent two rounds removing.
 *
 * The code is what is wrong. It stayed because renaming it is not the one-liner it looks
 * like — `BackupErrorCode` feeds the Sentry tag vocabulary — because nothing outside
 * tests consumes it, and because `cause.linkDropEvidence: "inferred"` already
 * disambiguates in a support log. It is filed as its own item.
 *
 * So: if you are here to resolve the contradiction, change the CODE. The wording is the
 * founder's and is pinned as an exact string.
 */
export const BACKUP_STOPPED_STILL_CONNECTED_MESSAGE =
  "The backup stopped and your iPhone didn't tell us why. It's still connected, " +
  "so it isn't a cable problem — just try syncing again.";

/**
 * BACKLOG-2913: the device's backup service would not negotiate. Exit 255 with
 * `version exchange failed, error -5` and NO disconnect events — repeated fast
 * retries are what produces this state, so the message must not invite another one.
 */
export const BACKUP_SERVICE_UNAVAILABLE_MESSAGE =
  "Your iPhone's backup service did not respond. Unplug the iPhone, wait ten " +
  "seconds, plug it back in and unlock it, then try once. Repeated quick retries " +
  "are what causes this, so give it a moment rather than syncing again straight away.";

/** BACKLOG-2913: MBErrorDomain/4 — the device could not find a file it needed. */
export const BACKUP_FILE_MISSING_MESSAGE =
  "Part of the existing backup on this Mac is missing or unreadable, so your iPhone " +
  "could not continue it. Starting a fresh backup should clear this.";

/**
 * BACKLOG-2913: idevicebackup2's own failure summary, on STDOUT.
 *
 * TRANSCRIBED from the founder's dev log, 2026-08-27 22:44:38 — the block logged by
 * `[BackupService] stdout:` reads, in full:
 *
 *     Requesting backup from device...
 *     Incremental backup mode.
 *     *** Waiting for passcode to be entered on the device ***
 *     ErrorCode 208: Device locked (MBErrorDomain/208)
 *     Received 0 files from device.
 *     Backup Failed (Error Code 208).
 *
 * This is the PREFERRED source. It comes from `progress_printf()`, so it is emitted
 * whether or not `-d` was passed, and stdout carries a tiny fraction of the volume
 * of the debug stream, so it survives the 64KB tail cap that can swallow the plist.
 */
const IDEVICEBACKUP2_STDOUT_ERROR_LINE = /^[ \t]*ErrorCode[ \t]+(\d+):[ \t]*(.*)$/gm;

/**
 * BACKLOG-2913: the `DLMessageProcessMessage` response plist, on STDERR.
 *
 * TRANSCRIBED from the same run — `property_list_service.c:253` prints it in full:
 *
 *     <array>
 *     	<string>DLMessageProcessMessage</string>
 *     	<dict>
 *     		<key>ErrorCode</key>
 *     		<integer>208</integer>
 *     		<key>ErrorDescription</key>
 *     		<string>Device locked (MBErrorDomain/208)</string>
 *     		<key>MessageName</key>
 *     		<string>Response</string>
 *     	</dict>
 *     </array>
 *
 * Note the keys and values are on SEPARATE tab-indented lines; a pattern written
 * against a one-line `<key>ErrorCode</key><integer>105</integer>` would match a
 * fixture and never a real device.
 *
 * Scoped to the DLMessageProcessMessage envelope on purpose: the same stream carries
 * other plists (a `Shutdown` command block, lockdown query responses), and an
 * unscoped `<key>ErrorCode</key>` hunt would eventually read one of those.
 */
const DL_PROCESS_MESSAGE_BLOCK =
  /DLMessageProcessMessage<\/string>([\s\S]{0,4000}?)<\/array>/g;
const DL_ERROR_CODE = /<key>ErrorCode<\/key>\s*<integer>(-?\d+)<\/integer>/;
const DL_ERROR_DESCRIPTION = /<key>ErrorDescription<\/key>\s*<string>([\s\S]*?)<\/string>/;

/**
 * BACKLOG-2913: exit-255 discriminators. Both TRANSCRIBED, and consulted only when
 * the device reported no code of its own.
 *
 * `SSL_read 4, received 0` is deliberately NOT here, though BACKLOG-2951 lists it
 * under "USB link flapping". The 2026-08-27 log has about thirty of those lines
 * (22:42:44 through 22:43:20) inside the run that ended in device-locked/208, on a
 * healthy link — it is routine notification_proxy polling, the same class of chatter
 * as `np_lock(): Locked`. Treating it as a link-drop signal would rebuild this exact
 * bug one rung further down.
 */
/**
 * BACKLOG-2915: this pattern is UNREACHABLE under the shipped argv. See the ordering
 * note in {@link classifyBackupFailure} for why it is kept rather than deleted, and
 * where the link-drop class is decided instead.
 */
const CONNECTION_DROPPED_PATTERN = /usbmuxd_send returned -\d+ \(Broken pipe\)/i;
const SERVICE_VERSION_EXCHANGE_PATTERN =
  /version exchange failed|Could not perform backup protocol version exchange/i;

/** Minimal XML entity decoding for a plist string value. */
function decodePlistString(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * BACKLOG-2913: read the device's own error code out of a failed run.
 *
 * stdout first WHEN IT CARRIES A CODE, then the stderr plist. The LAST occurrence
 * wins in both: a run can log several DLMessage responses, and the one that ended it
 * is the last.
 *
 * stdout is preferred because idevicebackup2 prints the `ErrorCode N: ...` line via
 * `progress_printf` (a `vprintf`), so it is emitted whether or not `-d` was passed,
 * and stdout is low-volume enough to survive the 64KB tail cap that can push the
 * stderr plist out of the buffer entirely. Measured on the founder's five real
 * failures of 2026-08-27: stderr hit the cap in 5 of 5 runs, stdout ran 0–475 bytes.
 *
 * Preferred is NOT the same as always present: four of those five runs captured ZERO
 * stdout, because the run never reached the point of printing a summary. Those runs
 * are carried by the fallback chain below, not by this parse.
 *
 * Returns `deviceErrorCode: null` when neither stream carried a code. That is
 * "the device did not tell us", never "no error".
 */
export function parseDeviceBackupError(
  stdout: string,
  stderr: string,
): Pick<
  BackupFailureCause,
  "deviceErrorCode" | "deviceErrorDescription" | "source"
> {
  let lastStdoutMatch: RegExpExecArray | null = null;
  IDEVICEBACKUP2_STDOUT_ERROR_LINE.lastIndex = 0;
  for (
    let m = IDEVICEBACKUP2_STDOUT_ERROR_LINE.exec(stdout);
    m !== null;
    m = IDEVICEBACKUP2_STDOUT_ERROR_LINE.exec(stdout)
  ) {
    lastStdoutMatch = m;
  }
  if (lastStdoutMatch) {
    const description = lastStdoutMatch[2].trim();
    return {
      deviceErrorCode: Number.parseInt(lastStdoutMatch[1], 10),
      deviceErrorDescription: description.length > 0 ? description : null,
      source: "stdout-line",
    };
  }

  let lastCode: number | null = null;
  let lastDescription: string | null = null;
  DL_PROCESS_MESSAGE_BLOCK.lastIndex = 0;
  for (
    let block = DL_PROCESS_MESSAGE_BLOCK.exec(stderr);
    block !== null;
    block = DL_PROCESS_MESSAGE_BLOCK.exec(stderr)
  ) {
    const codeMatch = DL_ERROR_CODE.exec(block[1]);
    if (!codeMatch) continue;
    lastCode = Number.parseInt(codeMatch[1], 10);
    const descriptionMatch = DL_ERROR_DESCRIPTION.exec(block[1]);
    const decoded = descriptionMatch
      ? decodePlistString(descriptionMatch[1]).trim()
      : "";
    lastDescription = decoded.length > 0 ? decoded : null;
  }
  if (lastCode !== null) {
    return {
      deviceErrorCode: lastCode,
      deviceErrorDescription: lastDescription,
      source: "stderr-plist",
    };
  }

  return {
    deviceErrorCode: null,
    deviceErrorDescription: null,
    source: "none",
  };
}

/**
 * BACKLOG-2915: everything the classifier knows that the two output buffers cannot say.
 *
 * All three exist because dropping `-d` changed what the streams carry, and every one
 * of them is LATCHED LIVE during the run rather than re-derived from a buffer at the
 * end. That is the point: `stdoutBuffer` is capped at 65 KB, and stdout now carries
 * ~80 bytes per progress render at ~76,000 renders per 20 minutes — roughly SEVEN
 * SECONDS of output. A device error code printed a minute before the process exits is
 * long gone from the tail. `diskFullDetected` has always been latched this way
 * (BACKLOG-2899); this extends the same treatment to the rest.
 */
export interface BackupFailureEvidence {
  /**
   * The device error code as latched by `parseStdoutLine` while the run was still
   * going. Takes precedence over re-parsing the buffers when it carries a code.
   */
  latchedDeviceError?: Pick<
    BackupFailureCause,
    "deviceErrorCode" | "deviceErrorDescription" | "source"
  > | null;
  /**
   * BACKLOG-2915: THE USER PRESSED CANCEL. Without this the D1 inference rung below
   * calls every cancelled backup a dropped cable.
   *
   * A cancel is SIGTERM -> idevicebackup2's `clean_exit` -> a normal return -> **exit
   * code 255**, with no device error code and no version-exchange line. That is
   * character-for-character the shape the inference rung matches, so a user who
   * cancelled would be told "The connection to your iPhone dropped during the backup.
   * Try a different cable." Windows is no better: `TerminateProcess` also exits
   * non-zero.
   *
   * `exitCode === -1` cannot stand in for it. That sentinel is never produced by the
   * real close path — `child_process` reports the tool's own status — so it has only
   * ever been reachable from a direct call.
   */
  cancelRequested?: boolean;
  /**
   * BACKLOG-2915: the OS reported the device gone at some point during this run.
   *
   * A FACT, not an inference. See {@link BackupLinkDropEvidence}.
   */
  deviceDisconnected?: boolean;
  /**
   * BACKLOG-2915: idevicebackup2 printed `ERROR: Could not receive from mobilebackup2`.
   *
   * Its own report that the channel died, unconditional and immediate.
   */
  mobilebackup2ReceiveFailure?: boolean;
}

/** BACKLOG-2913: a classified backup failure — the sentence AND the data behind it. */
export interface BackupFailureClassification {
  message: string;
  errorCode: BackupErrorCode;
  cause: BackupFailureCause;
}

/**
 * BACKLOG-2913: an honest message for a device code we have not mapped.
 *
 * It must include the number — that is the one thing that makes an unmapped failure
 * identifiable in a support ticket — and it must not guess. The device's own
 * description is quoted rather than paraphrased, and explicitly attributed to the
 * iPhone, because that text names no drive and would otherwise mislead exactly the
 * way "Insufficient free disk space on drive to back up" already did.
 */
function describeUnmappedDeviceError(
  code: number,
  description: string | null,
): string {
  const quoted = description ? ` Your iPhone reported: "${description}".` : "";
  return (
    `The backup stopped with error ${code}.${quoted} ` +
    "Keepr does not have a specific explanation for this one — please send this " +
    "message to support."
  );
}

/**
 * BACKLOG-2913: decide what actually failed, in order of how much the evidence is
 * worth.
 *
 * 1. The code the DEVICE reported. Machine-readable, unambiguous, and it was
 *    already being logged and thrown away.
 * 2. Anchored signals in idevicebackup2's own output, for the connection faults the
 *    device never gets to report because the link died first.
 * 3. An honest "we do not know", carrying the exit code so a support log can still
 *    identify the run.
 *
 * What it never does is match UNANCHORED routine vocabulary against the raw `-d`
 * debug stream. That stream contains `afc_lock(): Locked` and `np_lock(): Locked`
 * hundreds of times per run, plus `PasswordProtected`, `TrustedHostAttached` and
 * `PairRecordProtectionClass` as ordinary plist keys — so the old ladder's `locked`
 * rung matched on every single failure and the `disk`, `trust` and `password` rungs
 * below it were unreachable.
 *
 * BACKLOG-2915 — READ THIS BEFORE TRUSTING THE STDERR ARMS BELOW. Two anchored
 * patterns still run against stderr, and after the `-d` removal **one of them can no
 * longer fire in production**:
 *
 *   `SERVICE_VERSION_EXCHANGE_PATTERN` — ALIVE, via its STDOUT arm.
 *       `printf("Could not perform backup protocol version exchange, error code %d\n")`
 *       at idevicebackup2.c:1917 is unconditional. Its stderr copy is gone with `-d`.
 *
 *   `CONNECTION_DROPPED_PATTERN` — **UNREACHABLE UNDER THE SHIPPED ARGV.**
 *       `usbmuxd_send returned -N (Broken pipe)` is `debug_info()` output
 *       (src/idevice.c:643), gated on `debug_level`, which only `-d` sets — and it is
 *       never printed on stdout. `buildBackupArgs` no longer passes `-d`, so no run can
 *       produce this line. The rung is KEPT because it is correct and free if `-d` ever
 *       returns, but it decides nothing today: the USB link-drop class is now reached by
 *       the D1 INFERENCE RUNG at the bottom of this function, not by reading this line.
 *       Measured: replacing the pattern with a never-matching regex leaves the whole
 *       backup suite green.
 *
 * Both stderr arms are gated behind `deviceErrorCode === null`: consulted only when the
 * device reported no code at all, never able to override one it did report. That
 * ordering is load-bearing and survives unchanged — `usbmuxd_send returned -32 (Broken
 * pipe)` was teardown chatter present in four of the five real failures of 2026-08-27,
 * INCLUDING the one that was genuinely a locked phone, and the same is true of the
 * inference rung that replaced it. Reordering either above the device-code switch tells
 * that user to try a different cable. `backupService.failureCause-2913` and
 * `stdoutProgress-2915` ROW 17 pin it.
 *
 * `transferStarted` carries the one thing the streams cannot say: whether any file
 * transfer had begun when the link died. It changes NO classification — only which
 * of the two connection-lost sentences is returned. It defaults to false, the
 * conservative reading, so a caller that genuinely does not know gets the message
 * written for "we never got going". See
 * {@link BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE} for why the split exists, and
 * `backupService.connectionCopy-2913` for the tests that pin the wording and the
 * branch.
 */
export function classifyBackupFailure(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  transferStarted: boolean = false,
  evidence: BackupFailureEvidence = {},
): BackupFailureClassification {
  // BACKLOG-2915 (SR B3): prefer the code latched line-by-line during the run over a
  // re-parse of the 65 KB tail, which after the `-d` removal holds about seven
  // seconds of progress renders.
  const latched = evidence.latchedDeviceError;
  const parsed =
    latched && latched.deviceErrorCode !== null
      ? latched
      : parseDeviceBackupError(stdout, stderr);
  const cause: BackupFailureCause = { ...parsed, exitCode };

  switch (parsed.deviceErrorCode) {
    case MB_ERROR_HOST_DISK_FULL:
      return {
        message: BACKUP_HOST_DISK_FULL_MESSAGE,
        errorCode: "INSUFFICIENT_SPACE",
        cause,
      };
    case MB_ERROR_DEVICE_LOCKED:
      return {
        message: BACKUP_DEVICE_LOCKED_MESSAGE,
        errorCode: "DEVICE_LOCKED",
        cause,
      };
    case MB_ERROR_FILE_MISSING:
      return {
        message: BACKUP_FILE_MISSING_MESSAGE,
        errorCode: "BACKUP_FILE_MISSING",
        cause,
      };
  }

  // The device reported something we have no specific answer for. Say so, and hand
  // over its own words and number rather than picking the nearest-looking rung.
  if (parsed.deviceErrorCode !== null) {
    return {
      message: describeUnmappedDeviceError(
        parsed.deviceErrorCode,
        parsed.deviceErrorDescription,
      ),
      errorCode: "UNKNOWN_ERROR",
      cause,
    };
  }

  // No device code: the link or the service failed before the device could answer.
  // Anchored patterns only.
  if (
    SERVICE_VERSION_EXCHANGE_PATTERN.test(stderr) ||
    SERVICE_VERSION_EXCHANGE_PATTERN.test(stdout)
  ) {
    return {
      message: BACKUP_SERVICE_UNAVAILABLE_MESSAGE,
      errorCode: "SERVICE_UNAVAILABLE",
      cause,
    };
  }
  if (
    CONNECTION_DROPPED_PATTERN.test(stderr) ||
    CONNECTION_DROPPED_PATTERN.test(stdout)
  ) {
    // BACKLOG-2913 (copy defect, founder 2026-08-28): a link drop before the first
    // progress bar and a link drop at 616 MB are different faults. Same exit code,
    // same broken-pipe line, opposite advice. `transferStarted` is the only thing
    // that separates them, and the caller is the only place that knows it.
    return {
      message: transferStarted
        ? BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE
        : BACKUP_CONNECTION_LOST_MESSAGE,
      errorCode: "CONNECTION_LOST",
      cause: { ...cause, linkDropEvidence: "broken-pipe-line" },
    };
  }

  // Last resort. This is the only UNANCHORED vocabulary match left, and it is why it
  // reads `stdout` and not `stderr`: idevicebackup2's own human-readable summary
  // (BACKLOG-2899's detector), never the `-d` debug stream. The two anchored
  // exit-255 patterns above DO read stderr — see the docblock — but they match a
  // specific fault string; these patterns match ordinary words like "disk full",
  // which the debug stream is entitled to contain for reasons that are not a
  // failure. Passing `stderr` here re-creates the original bug.
  if (isIdevicebackup2DiskFullOutput(stdout)) {
    return {
      message: BACKUP_HOST_DISK_FULL_MESSAGE,
      errorCode: "INSUFFICIENT_SPACE",
      cause,
    };
  }

  // BACKLOG-2915: the cancel rung sits ABOVE the inference rung and below everything
  // that reads real evidence. A cancelled run that the device also gave a reason for
  // (a 208 arriving as the user hit cancel) keeps the device's reason; a cancelled run
  // with no reason is reported as cancelled rather than guessed at.
  if (exitCode === -1 || evidence.cancelRequested === true) {
    return {
      message: "Backup was cancelled.",
      errorCode: "BACKUP_CANCELLED",
      cause,
    };
  }

  // BACKLOG-2915 (round 4) — THE LINK DROP, OBSERVED RATHER THAN INFERRED.
  //
  // FOUNDER INSIGHT, 2026-08-31: *"for cable unplug we can probably see it from the OS
  // if the phone is connected?"* He was right, and the signal was already on the wire —
  // `deviceDetectionService` has polled `idevice_id -l` and emitted
  // `device-connected` / `device-disconnected` all along. We had built an inference for
  // a fact nobody was reading.
  //
  // This recovers, from a different direction, exactly what dropping `-d` cost: the
  // `usbmuxd_send ... (Broken pipe)` discriminator. That loss was recorded as
  // unavoidable. It was not.
  //
  // TWO signals feed it, and they have very different latencies — which is the whole
  // reason this rung is written the way it is:
  //
  //   `ERROR: Could not receive from mobilebackup2 (%d)`  — stdout, IMMEDIATE.
  //       `PRINT_VERBOSE(0, ...)`, so unconditional. On the founder's real cable pull
  //       it printed at 00:27:01.651, ONE MILLISECOND before the process exited.
  //
  //   `device-disconnected` from the OS                    — LAGS BY UP TO ~2 s.
  //       The poller runs every 2 s. On that same pull the event arrived at
  //       00:27:02.121 — 468 ms AFTER this function had already answered. A latch read
  //       at close time would have been FALSE for the exact run it was designed to
  //       catch, and a synthetic test that drove the disconnect first would have passed.
  //       See `DISCONNECT_SETTLE_MS` for how the close path waits for it.
  if (
    evidence.deviceDisconnected === true ||
    evidence.mobilebackup2ReceiveFailure === true
  ) {
    return {
      message: transferStarted
        ? BACKUP_CONNECTION_LOST_MID_TRANSFER_MESSAGE
        : BACKUP_CONNECTION_LOST_MESSAGE,
      errorCode: "CONNECTION_LOST",
      cause: {
        ...cause,
        // The OS's answer outranks the tool's when both are present.
        linkDropEvidence:
          evidence.deviceDisconnected === true
            ? "device-disconnected"
            : "mobilebackup2-receive-failure",
      },
    };
  }

  // BACKLOG-2915 D1 — THE LINK-DROP INFERENCE RUNG. FOUNDER DECISION, 2026-08-30.
  //
  // ROUND 4: DEMOTED TO A LAST RESORT by the rung above. It now answers only
  // "exited badly, phone still attached, nobody said why" — which is NOT a cable
  // problem, and the founder's approved before-transfer copy ("plug it straight into
  // your Mac") is wrong for it. A second sentence is needed here and is his call; the
  // branch is implemented and tagged `inferred` so the change is a copy edit.
  //
  // `usbmuxd_send returned -N (Broken pipe)` was `debug_info()` output and existed
  // ONLY under `-d`. Removing the flag removes it, and with it the only direct
  // evidence this app has ever had for a dropped USB link. It is not a small class:
  // the broken-pipe line appears in FOUR OF THE FIVE real failures of 2026-08-27, and
  // four of those five captured zero stdout. Without a replacement, every one of those
  // users would drop to the generic "neither this Mac nor your iPhone reported a
  // reason", losing all three connection-fault sentences including the mid-transfer
  // copy the founder wrote himself on 2026-08-28.
  //
  // So it is INFERRED instead of read, from what is left: the process exited non-zero,
  // the device reported no code of its own, and it was not a version-exchange failure.
  // Everything above this rung has already claimed the failures it can evidence.
  //
  // BE HONEST ABOUT WHAT THIS IS. It is weaker than reading the line. It will also
  // catch any FUTURE unclassified non-zero exit that is not really a link drop — that
  // is the accepted cost of the trade, recorded on BACKLOG-2915, and it is why the
  // cancel rung above it exists. `exitCode === null` is deliberately excluded: null is
  // "killed by a signal, no status", which is us, not the cable.
  if (exitCode !== null && exitCode !== 0) {
    return {
      // NO `transferStarted` SPLIT HERE, AND THAT IS THE ROUND-4 CHANGE. The split
      // exists to separate "the cable never worked" from "it died eleven minutes and
      // 616 MB in" — two shapes of the same LINK failure. This rung is no longer a link
      // failure at all: the rung above observes those now, so reaching here means the
      // phone is still attached and nobody said why. One sentence answers both.
      message: BACKUP_STOPPED_STILL_CONNECTED_MESSAGE,
      errorCode: "CONNECTION_LOST",
      cause: { ...cause, linkDropEvidence: "inferred" },
    };
  }

  return {
    message:
      "The backup stopped and neither this Mac nor your iPhone reported a reason" +
      (exitCode === null ? "" : ` (exit code ${exitCode})`) +
      ". Please try again with your iPhone unlocked and plugged in directly. If it " +
      "keeps happening, send this message to support.",
    errorCode: "UNKNOWN_ERROR",
    cause,
  };
}

/**
 * Service for managing iPhone backups via idevicebackup2
 *
 * Emits events:
 * - 'progress': BackupProgress - Progress updates during backup
 * - 'error': Error - Error events
 * - 'complete': BackupResult - When backup completes
 * - 'password-required': { udid: string } - When encrypted backup needs password (TASK-007)
 * - 'waiting-for-passcode': void - The device has not started sending files yet. The
 *   name is historical (BACKLOG-2911 FIX 3): a passcode prompt is ONE possible cause,
 *   alongside device-side indexing and a stalled process, and nothing here can tell
 *   them apart. Do not phrase user-facing copy as though it could.
 * - 'passcode-entered': void - The first file started transferring. Again historical:
 *   it marks the END of the wait, not the entry of a passcode.
 */
export class BackupService extends EventEmitter {
  private currentProcess: ChildProcess | null = null;
  private isRunning: boolean = false;
  private currentDeviceUdid: string | null = null;
  private startTime: number = 0;
  private lastProgress: BackupProgress | null = null;

  // ------------------------------------------------------------------------
  // BACKLOG-2915: progress state, with the per-FILE fiction removed.
  //
  // The five fields this replaces (`filesCompleted`, `totalFilesEstimate`,
  // `currentFileProgress`, `lastFileSize` and a `bytesTransferred` fed by them)
  // implemented a file-completion heuristic: when the render's percentage DROPPED by
  // more than 50 from above 90, a file was assumed to have finished and its size added
  // to the running total. It rested on the comment at the old `parseProgress`, "the
  // percentage shown is per-file, not overall", which is wrong.
  //
  // `backup_real_size` / `backup_total_size` are function-locals of
  // `mb2_handle_receive_files()`, reset per `DLMessageUploadFiles` message — so the
  // render is per-BATCH, and the heuristic was counting batches as files. The
  // 2026-08-30 capture measured 36 batches against the device's own
  // `Received 4604 files from device.`: a 159x undercount, which is why
  // `filesTransferred` has never once agreed with the device.
  // ------------------------------------------------------------------------

  /** Bytes of every batch that has already closed, summed. Never decreases. */
  private completedBatchBytes: number = 0;
  /** Bytes moved so far in the batch currently being received; null before the first render. */
  private batchBytesTransferred: number | null = null;
  /** Total bytes of the batch currently being received; null before the first render. */
  private batchTotalBytes: number | null = null;
  /** The device's own overall percent, from `[====] 62% Finished`. Null until it says. */
  private deviceOverallPercent: number | null = null;
  /** The device's own file count, from `Received N files from device.`. Null until it says. */
  private filesReceivedFromDevice: number | null = null;
  /**
   * BACKLOG-2915: the passcode line was printed. POST-MORTEM ONLY — never a live cue.
   *
   * The founder entered his passcode at roughly t=150 s in the 2026-08-30 capture. The
   * line reporting it reached this process at t=564 s, because stdout is fully
   * buffered on a pipe and nothing flushes it until the first received file. Seven
   * minutes late. Any live "waiting for passcode" UI has to stay a timer heuristic.
   */
  private deviceRequestedPasscode: boolean = false;
  /** BACKLOG-2915: the outcome line idevicebackup2 printed, if it got that far. */
  private deviceOutcomeLine: "successful" | "aborted" | "failed" | null = null;
  /** BACKLOG-2915 (SR B3): the device error code, latched per line, immune to the 65 KB cap. */
  private latchedDeviceError: Pick<
    BackupFailureCause,
    "deviceErrorCode" | "deviceErrorDescription" | "source"
  > | null = null;
  /**
   * BACKLOG-2915: the user asked to stop. See {@link BackupFailureEvidence.cancelRequested}.
   *
   * **SYNC-SCOPED, NOT RUN-SCOPED, AND THAT DISTINCTION IS THE BUG THIS FIELD HAD.**
   * It is deliberately NOT in the per-run reset block; `beginSyncScope()` clears it,
   * and the orchestrator calls that where it starts a sync.
   *
   * Found by the founder on 2026-08-31, in about forty minutes of real use, after three
   * review rounds and 38 mutations. His cancels landed at 00:27:08.701 and 00:27:22.737
   * against one run; a THIRD run then spawned fresh at 00:27:56.486 with this latch
   * reset, died 16 ms later because the phone was unplugged, and was classified
   * `CONNECTION_LOST` — a cancelled sync reported as a cable fault. The measurement that
   * names the defect is in the same log: sync elapsed **37,299 ms** against backup
   * elapsed **26 ms**. A sync outlives its runs, so a latch scoped to a run cannot
   * answer a question about the sync.
   *
   * The user saw nothing wrong only because `deviceSyncOrchestrator` recorded
   * `sync-end outcome=cancelled` one layer up and suppressed the message. Two defences
   * were designed; one was live. Both are now pinned independently —
   * `deviceSyncOrchestrator.cancelScope-2915` for the other one.
   *
   * Contrast the run-scoped latches in the per-run reset block. The two kinds sit in
   * the same class and a reader must not assume they match.
   */
  private cancelRequested: boolean = false;
  /** Cumulative bytes for the whole run: closed batches plus the open one. */
  private bytesTransferred: number = 0;
  /**
   * BACKLOG-2915 (round 4): the OS reported this device gone during this run.
   *
   * **RUN-SCOPED**, unlike {@link cancelRequested} directly above, which is sync-scoped.
   * The question is "did the phone leave during THIS run", so it resets per run.
   */
  private deviceDisconnectedDuringRun: boolean = false;
  /** BACKLOG-2915: idevicebackup2 said the mobilebackup2 channel died. Run-scoped. */
  private mobilebackup2ReceiveFailure: boolean = false;
  /** Set while the close path is waiting out {@link DISCONNECT_SETTLE_MS}. */
  private disconnectSettleResolver: (() => void) | null = null;
  /**
   * BACKLOG-2915 (round 4): the UDID of the run being classified.
   *
   * SEPARATE from `currentDeviceUdid`, which the close handler nulls before it
   * classifies. The whole point of the settle window is to accept an event that arrives
   * AFTER the process exits, so the identity check cannot depend on state the exit has
   * already torn down — that would have rejected exactly the late disconnect this was
   * built for, silently, and the control below is what caught it.
   */
  private runDeviceUdid: string | null = null;
  /**
   * BACKLOG-2915: does anything actually report disconnects to this service?
   *
   * Only `deviceSyncOrchestrator` wires the feed, and only then is it worth waiting for
   * a late event. Without this, every unexplained failure in every unit test would sit
   * out the settle window for nothing.
   */
  private hasDisconnectFeed: boolean = false;

  // Passcode waiting detection
  private passcodeWaitingTimer: NodeJS.Timeout | null = null;
  private hasReceivedFileProgress: boolean = false;
  private hasEmittedPasscodeWaiting: boolean = false;
  private backupCommandStartTime: number = 0;
  /**
   * BACKLOG-2911 (FIX 3): how long with no file progress before the UI is told the
   * device has not started sending yet.
   *
   * THE NAME IS THE BUG. Five seconds without progress was read as "the user is being
   * asked for a passcode", and NOTHING on this path reports that. Indexing, a phone
   * nobody has picked up, and a hung process all produce exactly this. On the founder's
   * 12:09 run on 2026-08-28 he had already entered his passcode and the screen told him
   * to enter it for fifteen more minutes, because the first byte did not arrive for
   * 903.9 s.
   *
   * The threshold and the event are unchanged — five seconds of no transfer really is
   * worth telling the user about, and the renderer needs a signal to say so. What
   * changed is the CLAIM made from it: the copy now reports the wait and offers the
   * passcode as a possibility. See `SyncProgress.tsx`.
   *
   * The event name `waiting-for-passcode` is deliberately NOT renamed. It crosses
   * `deviceSyncOrchestrator` -> `syncHandlers` -> preload -> `useIPhoneSync` ->
   * `SyncProgress`, and renaming an IPC channel on a shared-file branch buys the
   * founder nothing he can see. The lie was in the words on his screen, and that is
   * where it is fixed.
   */
  private static readonly PASSCODE_WAIT_DETECTION_MS = 5000;

  // BACKLOG-1582: Watchdog timer to detect zombie idevicebackup2 processes.
  //
  // BACKLOG-2911 (FIX 2): THE WATCHDOG COULD NOT FIRE, AND THIS PAIR OF FIELDS IS WHY.
  //
  //   12:09:43.414  Watchdog started (timeout: 180s)
  //   …904 seconds of silence…
  //   12:24:42.355  File transfer started after 903.9s
  //
  // It was silent through five times its own timeout, and `grep -c "Watchdog
  // fired|zombie|killed by watchdog"` over the founder's entire 2026-08-28 session
  // returns 0 across three runs. BACKLOG-1582 was CLOSED on the strength of this
  // watchdog, so the silence has been read as good news for months.
  //
  // The two fields it used were `lastStdoutTimestamp` / `lastStderrTimestamp`, each
  // bumped by its `data` handler on EVERY chunk, with liveness taken as the newer of
  // the two. `buildBackupArgs` passes `-d` unconditionally, so libimobiledevice emits
  // continuous debug chatter on stderr — the BACKLOG-2898 note below measures 336 such
  // records in one 21-minute log — and the timestamp therefore never aged. The timer
  // ran, asked "did any bytes arrive on either stream?", and could not get "no" while
  // the process was alive at all.
  //
  // Which of the two possible failures this was is ESTABLISHED, not assumed, in
  // `backupService.watchdogStall-2911.test.ts`: total silence killed the process even
  // BEFORE this fix, so the timer and the kill path work. The question was what could
  // not come back false.
  //
  // The replacement is a single timestamp advanced only by MEANINGFUL activity — see
  // `noteMeaningfulActivity`. Idle polling (`np_get_notification`, `SSL_read 4,
  // received 0`, mutex traces) no longer counts as a sign of life, because it is not
  // one.
  private lastMeaningfulActivityAt: number = 0;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private watchdogFired: boolean = false;
  private static readonly WATCHDOG_CHECK_INTERVAL_MS = 30_000; // Check every 30s

  /**
   * BACKLOG-2911 (FIX 2): how long with NO meaningful activity before the process is
   * judged dead. One value for the whole run, and deliberately generous.
   *
   * THE OLD VALUES CANNOT BE KEPT ONCE LIVENESS MEANS PROGRESS. They were 180 s
   * preparing / 120 s transferring against "any output at all", and all three of the
   * founder's runs on 2026-08-28 waited longer than that before their first byte —
   * 507 s, 684.6 s and 903.9 s — and then COMPLETED. Measuring progress at 180 s would
   * have killed three working syncs. A watchdog that aborts healthy runs is worse than
   * one that never fires.
   *
   * 30 minutes is just under 2x the worst measured wait (903.9 s), which is the only
   * measurement that exists. It is not tuned beyond that, and it deliberately does not
   * split preparing from transferring: nothing has yet measured how long the device may
   * legitimately go quiet AFTER the last file while it finalises, so a tighter
   * transfer-phase value would be a guess, and a wrong guess kills a 52-minute run at
   * minute 51. FIX 4 on this same branch adds the per-phase durations that would make
   * that number measurable rather than guessed; tighten it then, on data.
   *
   * The root cause of the 8-15 minute pre-transfer wait is NOT addressed here and is
   * explicitly out of scope — see BACKLOG-2911. This constant accommodates it; it does
   * not explain it.
   */
  private static readonly WATCHDOG_NO_PROGRESS_TIMEOUT_MS = 1_800_000;

  /**
   * BACKLOG-2915: HOW LONG A GRACEFUL SHUTDOWN ACTUALLY TAKES. Measured, once, on
   * 2026-08-30, against the founder's device: **13.1 seconds**.
   *
   * SIGTERM was sent at t=1200.035 s. idevicebackup2's `clean_exit` (idevicebackup2.c:
   * 1426) answered on stderr in 3 ms — it only does `fprintf(stderr, "Exiting...")`
   * and `quit_flag++`, with no `_exit()` — and then the process unwound normally and
   * closed at t=1213.128 s with code 255. The 148-byte stdout flush that came with
   * that close carried the ENTIRE outcome: `Discarding current data hunk.`, a
   * `94% Finished` render, `Received 4604 files from device.` and `Backup Aborted.`
   *
   * Everything below is derived from this one number, and nothing else is.
   */
  private static readonly MEASURED_GRACEFUL_SHUTDOWN_MS = 13_100;

  /**
   * BACKLOG-2915: how long to wait after SIGTERM before SIGKILL. ~2.3x the measurement
   * above.
   *
   * IT WAS 5 SECONDS, AND THAT DESTROYED THE EVIDENCE. A user who cancelled was hard-
   * killed 8 seconds before the flush that says what happened, so the run reported
   * nothing at all — no device error code, no outcome line, no file count. This is
   * also what makes dropping `-d` safe: the stderr `DLMessageProcessMessage` plist and
   * the stdout `ErrorCode` line are the SAME event (idevicebackup2.c:2480-2503 reads
   * the code out of that message and prints it), so the plist's only unique value was
   * flush-independence — and the window in which that mattered was one this app
   * created for itself with a 5-second SIGKILL.
   */
  private static readonly SIGKILL_GRACE_MS = 30_000;

  /**
   * BACKLOG-2915 (SR B1): how long before the run's state is force-reset after a kill.
   *
   * IT WAS 10 SECONDS, WHICH IS LESS THAN THE 13.1 s SHUTDOWN — so raising the SIGKILL
   * grace on its own would have changed nothing. The safety net fired first, declared
   * the run over, emitted BACKUP_TIMEOUT and nulled `currentProcess`; the real outcome
   * then landed 3 seconds later on a run that had already been torn down. The two
   * timers move together or neither of them works.
   *
   * Sits above SIGKILL_GRACE_MS so that a process which ignores SIGTERM entirely is
   * still given its hard kill, and its close, before the state is discarded.
   */
  private static readonly POST_KILL_STATE_RESET_MS = 45_000;

  /**
   * BACKLOG-2915 (round 4): how long the close path waits for a disconnect event that
   * may still be in flight.
   *
   * MEASURED, on the founder's real cable pull of 2026-08-31:
   *
   *     00:27:01.652  Backup failed with code 255
   *     00:27:01.653  Failure classified { errorCode: 'CONNECTION_LOST' }   <- decided
   *     00:27:02.121  Device disconnected                                  <- 468 ms LATER
   *
   * `idevicebackup2` notices the dead channel and exits before the 2-second poller's
   * next tick. So "was a disconnect observed between run start and run end" is a
   * question that answers FALSE for the very runs it exists to catch. 3 s covers the
   * 2 s poll interval plus the measured 468 ms with margin.
   *
   * It is waited out ONLY when the run failed, the device reported no code of its own,
   * idevicebackup2 did not already say the channel died, and a disconnect feed is
   * attached — i.e. only when a late event could still change the answer. Successful
   * runs and device-coded failures are unaffected.
   */
  private static readonly DISCONNECT_SETTLE_MS = 3_000;

  /**
   * BACKLOG-2915: THE STDERR ACTIVITY-SIGNAL MECHANISM IS GONE, AND FIVE OF ITS SEVEN
   * ENTRIES HAD NEVER FIRED.
   *
   * `STDERR_ACTIVITY_SIGNALS` listed `SSL_write`, `service_send`, `Sending '`,
   * `Requesting backup`, `Starting backup`, `Negotiated Protocol` and `backup mode`.
   * The last five are `printf`/`PRINT_VERBOSE` calls in idevicebackup2 — **stdout**,
   * with or without `-d` — so they could never appear on the stream this list was
   * tested against. The first two were `debug_info()` output and die with `-d`.
   * The whole list is now empty by construction, so the mechanism is deleted rather
   * than left as an always-false test.
   *
   * The watchdog now takes its liveness from stdout alone, which is where every one of
   * those five lines actually is. That is a REAL reduction in margin during the
   * pre-receive phase and it is accepted deliberately: the 2026-08-30 capture measured
   * 564 s of two-stream silence before the first byte, against a 1,800 s no-progress
   * timeout — 3.2x. Mid-run stdout gaps of 32 s, 65 s and >=63 s were also measured, so
   * the silence is not confined to the pre-receive phase. Still nowhere near 30
   * minutes. BACKLOG-2911 FIX 4's phase durations are what should tune this, on data.
   *
   * `Exiting...` is deliberately NOT treated as activity. It is idevicebackup2's
   * `clean_exit` acknowledging OUR OWN signal; feeding it to the watchdog would extend
   * the liveness clock at exactly the moment the process is shutting down. It is
   * handled as a we-signalled-it latch instead.
   */
  private static readonly HOST_SIGNALLED_EXIT_LINE = "Exiting...";

  /**
   * BACKLOG-2914: the backup mode the DEVICE reported, from idevicebackup2's own
   * stderr. `null` until it says, and reset per run in the same block as the watchdog
   * state — inheriting run N's mode into run N+1 would be a wrong answer wearing the
   * clothes of a measured one.
   */
  private deviceReportedBackupMode: "incremental" | "full" | null = null;

  // BACKLOG-1628: Stderr debug parsing state
  private stderrLineBuffer: string = "";

  /**
   * BACKLOG-2915: the trailing PARTIAL stdout line, held across `data` events.
   *
   * idevicebackup2's progress renders are `\r`-delimited and carry no newline —
   * `print_progress_real()` writes `"\r["`, 50 cells, `"] %3.0f%%"` and, for the byte
   * variant, `" (%s/%s)     "` with five trailing spaces. A render is therefore
   * TERMINATED BY THE NEXT ONE'S `\r`, and the last render in a chunk is always
   * incomplete. Without this buffer a chunk boundary in the middle of a render either
   * loses it or, worse, parses two halves as one line.
   *
   * The 2026-08-30 capture produced 76,061 renders across 76,000 chunks and **61
   * chunks carried more than one render**, so the multi-render case is real. No chunk
   * BEGAN mid-render in that run, but a 64 KB pipe read can produce one and the
   * splitter has to survive it either way.
   */
  private stdoutLineBuffer: string = "";

  /** Cap on an unterminated stdout line before it is discarded. A render is ~80 bytes. */
  private static readonly MAX_STDOUT_PARTIAL_LINE = 8192;

  /**
   * BACKLOG-2898: stderr words that indicate a real fault. Unchanged from
   * BACKLOG-1628 — what changed is that they are now tested per LINE, with
   * libimobiledevice's mutex trace removed first.
   */
  private static readonly STDERR_ERROR_WORDS = [
    "trust",
    "pair",
    "password",
    "incorrect",
    "locked",
    "passcode",
    "no device",
    "not found",
    "disk",
    "space",
    "storage",
  ];

  /**
   * `np_lock(): Locked` / `np_unlock(): Unlocked` / `afc_lock(): Locked` — a
   * pthread mutex trace. The `<name>():` shape is what makes this safe: a real
   * message ("Device is locked", "please unlock your iPhone") can never match.
   */
  private static readonly LIBIMOBILEDEVICE_MUTEX_TRACE =
    /\b\w*_(?:un)?lock\(\):\s*(?:Locked|Unlocked)\b/gi;

  /** Cap on distinct unrecognised stderr lines breadcrumbed per backup run. */
  private static readonly MAX_STDERR_BREADCRUMBS = 50;

  /** Fingerprints of stderr lines already sent to Sentry this run. */
  private breadcrumbedStderrLines: Set<string> = new Set();
  private manifestUploadPhase: boolean = false;
  private manifestUploadSize: string | null = null;

  constructor() {
    super();
  }

  /**
   * Check what backup capabilities are available
   * IMPORTANT: Domain filtering is NOT supported - see docs/BACKUP_RESEARCH.md
   */
  async checkCapabilities(): Promise<BackupCapabilities> {
    // Domain filtering is NOT supported by idevicebackup2
    // This is documented in docs/BACKUP_RESEARCH.md
    return {
      supportsDomainFiltering: false,
      supportsIncremental: true,
      supportsEncryption: true,
      availableDomains: [
        "HomeDomain",
        "CameraRollDomain",
        "AppDomain",
        "MediaDomain",
        "SystemPreferencesDomain",
      ],
    };
  }

  /**
   * Check if a device requires encrypted backup (TASK-007)
   * @param udid Device UDID
   * @returns Encryption info
   *
   * SECURITY (TASK-601): UDID is validated before use in spawn() to prevent
   * command injection. The UDID flows from IPC (renderer process) and must be
   * treated as untrusted input.
   */
  async checkEncryptionStatus(udid: string): Promise<BackupEncryptionInfo> {
    try {
      // SECURITY: Validate UDID before spawning process
      // This prevents command injection via malicious UDID values
      const validatedUdid = validateDeviceUdid(udid);
      const ideviceinfo = getCommand("ideviceinfo");

      return new Promise((resolve) => {
        const proc = spawn(ideviceinfo, ["-u", validatedUdid, "-k", "WillEncrypt"]);
        let output = "";
        let errorOutput = "";

        proc.stdout?.on("data", (data) => {
          output += data.toString();
        });

        proc.stderr?.on("data", (data) => {
          errorOutput += data.toString();
        });

        proc.on("close", (code) => {
          if (code === 0) {
            const willEncrypt = output.trim().toLowerCase() === "true";
            log.info("[BackupService] Device encryption status:", {
              willEncrypt,
              rawOutput: output.trim(),
            });
            resolve({
              isEncrypted: willEncrypt,
              needsPassword: willEncrypt,
            });
          } else {
            log.warn(
              "[BackupService] Could not determine encryption status:",
              errorOutput,
            );
            resolve({
              isEncrypted: false,
              needsPassword: false,
            });
          }
        });

        proc.on("error", (error) => {
          log.error("[BackupService] Error checking encryption status:", error);
          resolve({
            isEncrypted: false,
            needsPassword: false,
          });
        });
      });
    } catch (error) {
      log.error("[BackupService] Exception checking encryption status:", error);
      return {
        isEncrypted: false,
        needsPassword: false,
      };
    }
  }

  /**
   * Get current backup status
   */
  getStatus(): BackupStatus {
    return {
      isRunning: this.isRunning,
      currentDeviceUdid: this.currentDeviceUdid,
      progress: this.lastProgress,
    };
  }

  /**
   * Start a backup operation
   *
   * Note: Due to iOS backup protocol limitations, this creates a FULL device
   * backup, app data included. Neither domain-specific backups nor app
   * exclusion are possible with idevicebackup2 (BACKLOG-2910).
   *
   * @param options Backup options
   * @returns Promise resolving to backup result
   *
   * SECURITY (TASK-601): UDID is validated before use in spawn() and path operations.
   * The UDID is used in:
   * - spawn() arguments to idevicebackup2 (via buildBackupArgs)
   * - path.join() for backup directory path
   * Both usages require validation to prevent injection attacks.
   */
  async startBackup(options: BackupOptions): Promise<BackupResult> {
    // BACKLOG-2915 (round 5, SR F1): `isRunning` ALONE LEAVES A 3-SECOND HOLE.
    //
    // The close handler clears `isRunning` before it awaits the disconnect settle
    // window, so for the length of that window a run is finished by this guard's
    // reckoning and still reading its own state. SR measured it:
    // `{ insideWindow: true, runningFlag: false, secondStartRejected: false }`.
    //
    // A second run admitted there does real damage, and it is not a crash — it is a
    // wrong answer. Its synchronous reset block clears `deviceDisconnectedDuringRun`
    // and overwrites `runDeviceUdid` while run 1's close handler is still waiting to
    // read them, so a real disconnect latched for run 1 is erased (run 1 misclassified
    // as "still connected"), and a disconnect matching run 2's UDID passes the guard,
    // sets the shared latch and resolves run 1's window (run 1 classified from run 2's
    // evidence).
    //
    // It is exactly what the founder did on 2026-08-31: cancel, then immediately retry.
    if (this.isRunning || this.disconnectSettleResolver !== null) {
      throw new Error("Backup already in progress");
    }

    // SECURITY: Validate UDID early before any spawn or path operations
    // This prevents command injection and path traversal attacks
    let validatedUdid: string;
    try {
      validatedUdid = validateDeviceUdid(options.udid);
    } catch (error) {
      log.error("[BackupService] Invalid UDID:", error);
      return {
        success: false,
        backupPath: null,
        error: error instanceof ValidationError ? error.message : "Invalid device UDID",
        errorCode: "BACKUP_FAILED" as BackupErrorCode,
        duration: 0,
        deviceUdid: options.udid,
        isIncremental: false,
        backupSize: 0,
        isEncrypted: false,
      };
    }

    // Check encryption status (TASK-007)
    // Note: checkEncryptionStatus also validates UDID, but we already validated above
    const encryptionInfo = await this.checkEncryptionStatus(validatedUdid);

    if (encryptionInfo.isEncrypted && !options.password) {
      // Emit event to signal UI should prompt for password
      this.emit("password-required", { udid: options.udid });

      return {
        success: false,
        backupPath: null,
        error: "Backup password required",
        errorCode: "PASSWORD_REQUIRED" as BackupErrorCode,
        duration: 0,
        deviceUdid: options.udid,
        isIncremental: false,
        backupSize: 0,
        isEncrypted: true,
      };
    }

    // Use mock mode for development
    if (isMockMode()) {
      return this.mockBackup(options);
    }

    const backupPath = options.outputDir || this.getDefaultBackupPath();
    const idevicebackup2 = getCommand("idevicebackup2");

    // Ensure backup directory exists
    await fs.mkdir(backupPath, { recursive: true });

    // Check if previous backup exists (for incremental detection)
    // SECURITY: Use validated UDID in path operations
    // BACKLOG-1086: Use atomic stat instead of check-then-act (TOCTOU fix)
    const deviceBackupPath = path.join(backupPath, validatedUdid);
    let previousBackupExists = false;
    try {
      await fs.stat(deviceBackupPath);
      previousBackupExists = true;
    } catch {
      // Directory doesn't exist — not an incremental backup
    }

    // Build command arguments
    // SECURITY: Pass validatedUdid to buildBackupArgs
    const args = this.buildBackupArgs(options, backupPath, validatedUdid);

    log.info("[BackupService] Starting backup with args:", args);
    log.info("[BackupService] Backup path:", backupPath);

    return new Promise((resolve) => {
      this.isRunning = true;
      this.currentDeviceUdid = options.udid;
      this.startTime = Date.now();

      // Reset progress tracking (BACKLOG-2915: per-batch, not per-file)
      this.completedBatchBytes = 0;
      this.batchBytesTransferred = null;
      this.batchTotalBytes = null;
      this.deviceOverallPercent = null;
      this.filesReceivedFromDevice = null;
      this.deviceRequestedPasscode = false;
      this.deviceOutcomeLine = null;
      this.latchedDeviceError = null;
      // NOTE: `cancelRequested` is deliberately NOT reset here. It is sync-scoped —
      // see its docblock, and `beginSyncScope()`. The two below ARE run-scoped: the
      // question they answer is about this run, not this sync.
      this.deviceDisconnectedDuringRun = false;
      this.mobilebackup2ReceiveFailure = false;
      this.runDeviceUdid = options.udid;
      this.bytesTransferred = 0;
      this.stdoutLineBuffer = "";

      // Reset passcode waiting detection
      this.hasReceivedFileProgress = false;
      this.hasEmittedPasscodeWaiting = false;
      this.backupCommandStartTime = Date.now();
      if (this.passcodeWaitingTimer) {
        clearTimeout(this.passcodeWaitingTimer);
        this.passcodeWaitingTimer = null;
      }

      this.lastProgress = {
        phase: "preparing",
        percentComplete: 0,
        currentFile: null,
        filesTransferred: 0,
        totalFiles: null,
        bytesTransferred: 0,
        totalBytes: null,
        batchBytesTransferred: null,
        batchTotalBytes: null,
        deviceOverallPercent: null,
        estimatedTimeRemaining: null,
      };
      this.emit("progress", this.lastProgress);

      // BACKLOG-1582: Reset watchdog state
      // BACKLOG-2911 (FIX 2): one timestamp, advanced only by meaningful activity.
      this.watchdogFired = false;
      this.lastMeaningfulActivityAt = Date.now();
      this.deviceReportedBackupMode = null;
      this.clearWatchdog();

      // BACKLOG-1628: Reset stderr parsing state
      this.stderrLineBuffer = "";
      // BACKLOG-2898: breadcrumb dedupe is per backup run
      this.breadcrumbedStderrLines.clear();
      this.manifestUploadPhase = false;
      this.manifestUploadSize = null;

      this.currentProcess = spawn(idevicebackup2, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // BACKLOG-2911 (FIX 2): ONE start path, here, covering the whole run.
      //
      // It used to be started from inside the 5-second passcode timer and restarted at
      // the first file, which meant the window before either of those was unwatched and
      // the two call sites carried two different timeouts. There is one timeout now, so
      // there is one place to start it.
      this.lastMeaningfulActivityAt = Date.now();
      this.startWatchdog();

      // Start timer to detect if we're waiting for passcode
      // If no file transfer progress after 5 seconds, assume waiting for user passcode
      this.passcodeWaitingTimer = setTimeout(() => {
        if (!this.hasReceivedFileProgress && !this.hasEmittedPasscodeWaiting) {
          this.hasEmittedPasscodeWaiting = true;
          const waitTime = ((Date.now() - this.backupCommandStartTime) / 1000).toFixed(1);
          // BACKLOG-2911 (FIX 3): the log says what was observed. It used to assert
          // "waiting for user passcode", which is one of at least three causes and is
          // not the one the founder's 12:09 run had.
          log.info(
            `[BackupService] No file transfer ${waitTime}s after requesting the backup; device has not started sending yet (cause unknown: indexing, passcode prompt, or stalled)`,
          );
          this.emit("waiting-for-passcode");
        }
      }, BackupService.PASSCODE_WAIT_DETECTION_MS);

      let stdoutBuffer = "";
      let stderrBuffer = "";
      // BACKLOG-2899: set when idevicebackup2 reports it could not write to the
      // local disk. See isIdevicebackup2DiskFullOutput for the transcription.
      let diskFullDetected = false;

      this.currentProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer += output;
        // BACKLOG-2899: stdoutBuffer accumulated for the whole run and was never
        // read — 24 minutes of progress-bar output held in memory. Capped the
        // way stderrBuffer already is.
        if (stdoutBuffer.length > 65536) {
          stdoutBuffer = stdoutBuffer.slice(-65536);
        }

        // BACKLOG-2899: host-side write failures are printed HERE, on stdout.
        if (!diskFullDetected && isIdevicebackup2DiskFullOutput(output)) {
          diskFullDetected = true;
          log.error(
            "[BackupService] idevicebackup2 reported a full disk:",
            output.trim().substring(0, 300),
          );
        }

        // BACKLOG-2911 (FIX 2): stdout from idevicebackup2 is the tool reporting its own
        // work — progress bars, "Receiving files", "Received N files", "Backup
        // Successful". Unlike stderr under `-d`, none of it is idle polling, so every
        // chunk here counts as life.
        this.noteMeaningfulActivity();

        // Only log non-progress-bar output (progress renders are very spammy: the
        // 2026-08-30 capture produced 76,061 of them in 20 minutes).
        const isProgressBar = /\[[^\]]*\]\s*\d+%/.test(output);
        if (!isProgressBar && output.trim()) {
          log.info("[BackupService] stdout:", output.trim());
        }

        // BACKLOG-2915: ONE emit per chunk, and it carries the furthest-along state
        // that chunk contained.
        //
        // The alternative — emitting per line — regresses the bar inside a single
        // tick, and the very FIRST chunk of a real run proves it. In the 2026-08-30
        // capture that chunk was 826 bytes and held, in this order: `Requesting backup
        // from device...`, `Incremental backup mode.`, the passcode line, three
        // `Sending '...'` lines, a `0% Finished` render, `Receiving files`, and a byte
        // render. Dispatching those in order would emit `preparing` at 0% AFTER
        // `transferring`, because they arrived together after 9.4 minutes of buffered
        // silence, not in real time.
        const progress = this.consumeStdoutChunk(output);
        if (progress) {
          this.lastProgress = progress;
          this.emit("progress", progress);
        }
      });

      this.currentProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrBuffer += output;
        // BACKLOG-1628: Cap stderrBuffer to prevent unbounded memory growth.
        // With -d flag, stderr can exceed 50 MB during a long backup.
        if (stderrBuffer.length > 65536) {
          stderrBuffer = stderrBuffer.slice(-65536);
        }

        // BACKLOG-2911 (FIX 2): stderr is NOT evidence of life on its own. `-d` makes
        // libimobiledevice narrate an idle connection indefinitely, which is what kept
        // the old `lastStderrTimestamp = Date.now()` here from ever ageing. The lines
        // are classified below and only the ones that carry traffic count.

        // BACKLOG-2915: stderr is now a PURE SIGNAL CHANNEL. Measured across the
        // whole 20-minute capture with `-d` off: 11 bytes, and all 11 were the
        // `Exiting...` that idevicebackup2's `clean_exit` prints in response to our
        // own SIGTERM. Compare the 65 KB cap being hit in 5 of 5 runs under `-d`.
        //
        // So there is no parser here any more. `parseStderrLine` was deleted whole:
        // six of its eight patterns matched lines idevicebackup2 prints on STDOUT and
        // could never have fired, and the two that were genuinely stderr
        // (`SSL_write` / `service_send`) existed only under `-d`.
        this.stderrLineBuffer += output;
        const lines = this.stderrLineBuffer.split(/\r?\n/);
        // Keep the last incomplete line in the buffer
        this.stderrLineBuffer = lines.pop() || "";

        // BACKLOG-2898: classify PER LINE, not per chunk.
        //
        // This block used to test the whole stderr CHUNK for a trigger word and,
        // on a hit, dump a 500-char window of that chunk at `warn`. Measured on
        // the founder's real 21-minute log: 336 such records, 123,299 bytes,
        // 17.5% of the whole file — and a trigger histogram over all 336 shows
        // exactly ONE word ever fired, "locked", every single time from
        // libimobiledevice's own MUTEX trace (`notification_proxy.c:52
        // np_lock(): Locked`). Zero records contained a non-mutex trigger. The
        // rest of each record — idevice_connection_receive_timeout,
        // internal_plist_receive_timeout, np_get_notification — carries no
        // trigger word at all and was pure collateral of the 500-char window.
        // 13 of the 336 were truncated so hard that the word that caused them
        // to be logged is not even in the logged text.
        //
        // The backup that produced all of this COMPLETED SUCCESSFULLY. Per-line
        // classification plus demoting the mutex trace removes all 336 without
        // silencing a single line that carries a genuine trigger — a real
        // "Device is locked, enter your passcode" still warns.
        for (const line of lines) {
          if (line.includes(BackupService.HOST_SIGNALLED_EXIT_LINE)) {
            // We signalled it and it heard us. NOT an activity signal — see the
            // constant's docblock. `clean_exit` sets `quit_flag` and returns, so the
            // process still has to unwind, and the buffered stdout tail (the outcome
            // lines, the device's error code) arrives on the NORMAL exit flush after
            // it. That flush was measured at 13.1 s and is what the kill-path grace
            // in `cancelBackup` / `killZombieProcess` exists to wait for.
            log.info(
              "[BackupService] idevicebackup2 acknowledged our signal (Exiting...); waiting for its final stdout flush",
            );
            continue;
          }
          this.classifyStderrLine(line);
        }
      });

      this.currentProcess.on("error", (error: Error) => {
        log.error("[BackupService] Process error:", error);
        this.emit("error", error);
      });

      this.currentProcess.on("close", async (code: number | null) => {
        const duration = Date.now() - this.startTime;
        // BACKLOG-2915 (SR B4): flush the held partial line BEFORE anything reads the
        // latches. A byte render ends in five spaces with no terminator, so the LAST
        // render of a run — and, on an aborted run, whatever followed it in the same
        // final flush — is still sitting in `stdoutLineBuffer` at this point. The
        // capture's final 148-byte post-SIGTERM chunk carried `Discarding current data
        // hunk.`, a `94% Finished` render, `Received 4604 files from device.` and
        // `Backup Aborted.`; without this flush the tail of it is simply dropped.
        this.flushStdoutLineBuffer();
        this.isRunning = false;
        this.currentProcess = null;
        this.currentDeviceUdid = null;

        // Clear passcode waiting timer
        if (this.passcodeWaitingTimer) {
          clearTimeout(this.passcodeWaitingTimer);
          this.passcodeWaitingTimer = null;
        }

        // BACKLOG-1582: Clear watchdog
        this.clearWatchdog();

        // BACKLOG-1582: If watchdog killed this process, emit timeout result
        if (this.watchdogFired) {
          log.warn(`[BackupService] Process exited after watchdog kill (code: ${code}, duration: ${duration}ms)`);
          const result: BackupResult = {
            success: false,
            backupPath: null,
            error: "Backup process became unresponsive and was terminated",
            duration,
            deviceUdid: options.udid,
            isIncremental: this.resolveIsIncremental(previousBackupExists, options),
            deviceReportedBackupMode: this.deviceReportedBackupMode,
            backupSize: 0,
            errorCode: "BACKUP_TIMEOUT",
          };
          this.emit("complete", result);
          resolve(result);
          return;
        }

        // BACKLOG-2899: exit code 0 is not sufficient. idevicebackup2 never
        // checks its own fwrite/fclose, so a run that could not write files can
        // still exit 0 and print "Backup Successful." If it told us the disk was
        // full, the backup on disk is truncated and must not be handed to the
        // parsers as a success.
        const success = code === 0 && !diskFullDetected;
        // BACKLOG-2917: `null` means "not measured", NOT "zero bytes". On every
        // failure path below the walk never ran, and reporting 0 there would claim a
        // torn backup wrote nothing — a claim this code cannot support, since
        // idevicebackup2 leaves whatever it transferred on disk.
        let backupSize: number | null = null;
        let finalBackupPath = deviceBackupPath;

        if (success) {
          const sizeReading = await this.measureBackupSize(deviceBackupPath);
          backupSize = sizeReading.measured ? sizeReading.bytes : null;
          if (sizeReading.measured) {
            log.info(
              `[BackupService] Backup completed successfully in ${duration}ms, size: ${sizeReading.bytes} bytes`,
            );
          } else {
            // Refuse to print a reassuring number we do not have. This is the
            // `checkAvailableDiskSpace` rule: never log a 0 GB "reading".
            log.error(
              `[BackupService] Backup completed successfully in ${duration}ms, but its size could not be measured (${sizeReading.reason})`,
            );
          }

          // Check ACTUAL encryption status from backup on disk (not just device setting)
          // The device's WillEncrypt flag may not reflect existing backup encryption
          const actuallyEncrypted = await backupDecryptionService.isBackupEncrypted(deviceBackupPath);
          log.info("[BackupService] Backup encryption check:", {
            deviceWillEncrypt: encryptionInfo.isEncrypted,
            backupActuallyEncrypted: actuallyEncrypted,
          });

          // Update encryption info to reflect actual backup state
          if (actuallyEncrypted !== encryptionInfo.isEncrypted) {
            log.warn("[BackupService] Encryption mismatch - backup on disk differs from device setting");
            encryptionInfo.isEncrypted = actuallyEncrypted;
            encryptionInfo.needsPassword = actuallyEncrypted;
          }

          // Handle encrypted backup - need password to proceed
          if (actuallyEncrypted && !options.password) {
            // Backup is encrypted but no password provided - need to ask user
            log.info("[BackupService] Backup is encrypted but no password provided, requesting password");
            this.emit("password-required", { udid: options.udid });

            const result: BackupResult = {
              success: false,
              backupPath: deviceBackupPath,
              error: "Backup password required",
              errorCode: "PASSWORD_REQUIRED" as BackupErrorCode,
              duration: Date.now() - this.startTime,
              deviceUdid: options.udid,
              isIncremental: this.resolveIsIncremental(previousBackupExists, options),
              deviceReportedBackupMode: this.deviceReportedBackupMode,
              backupSize,
              isEncrypted: true,
            };
            this.emit("complete", result);
            resolve(result);
            return;
          }

          // Handle encrypted backup decryption (TASK-007)
          if (actuallyEncrypted && options.password) {
            this.lastProgress = {
              phase: "decrypting",
              percentComplete: 95,
              currentFile: null,
              filesTransferred: 0,
              totalFiles: null,
              // BACKLOG-2917: `totalBytes` is already nullable and carries the
              // unknown honestly. `bytesTransferred` is a progress-bar input typed
              // `number`; 0 there means "no bar movement to report", which is the
              // truth when the size is unmeasured, and it is paired with a null
              // total so nothing downstream can compute a false percentage from it.
              bytesTransferred: backupSize ?? 0,
              totalBytes: backupSize,
              // BACKLOG-2915: no batch is open at this point and the device never
              // authored a percent for the decryption step. Null is the honest answer.
              batchBytesTransferred: null,
              batchTotalBytes: null,
              deviceOverallPercent: this.deviceOverallPercent,
              estimatedTimeRemaining: 30,
            };
            this.emit("progress", this.lastProgress);

            const decryptionResult =
              await backupDecryptionService.decryptBackup(
                deviceBackupPath,
                options.password,
              );

            if (!decryptionResult.success) {
              const result: BackupResult = {
                success: false,
                backupPath: deviceBackupPath,
                error: decryptionResult.error || "Decryption failed",
                errorCode:
                  decryptionResult.error === "Incorrect password"
                    ? ("INCORRECT_PASSWORD" as BackupErrorCode)
                    : ("DECRYPTION_FAILED" as BackupErrorCode),
                duration: Date.now() - this.startTime,
                deviceUdid: options.udid,
                isIncremental: this.resolveIsIncremental(previousBackupExists, options),
              deviceReportedBackupMode: this.deviceReportedBackupMode,
                backupSize,
                isEncrypted: true,
              };
              this.emit("complete", result);
              resolve(result);
              return;
            }

            // Update path to decrypted location
            finalBackupPath = decryptionResult.decryptedPath!;
          }
        } else {
          log.error(`[BackupService] Backup failed with code ${code}`);
          log.error("[BackupService] stderr:", stderrBuffer);

          // BACKLOG-1354: Breadcrumb with full context when backup exits with unexpected code
          Sentry.addBreadcrumb({
            category: "iphone.sync",
            message: `Backup process exited with code ${code}`,
            level: "warning",
            data: {
              exitCode: code,
              stderr: stderrBuffer.trim().substring(0, 500),
              udid: options.udid.substring(0, 8) + "...",
              duration: `${duration}ms`,
              isIncremental: this.resolveIsIncremental(previousBackupExists, options),
              deviceReportedBackupMode: this.deviceReportedBackupMode,
            },
          });
        }

        // Convert error code to user-friendly message
        let errorMessage: string | null = null;
        let errorCode: BackupErrorCode | undefined;
        let failureCause: BackupFailureCause | undefined;
        if (!success) {
          if (diskFullDetected) {
            // BACKLOG-2899: the host disk filled mid-transfer, which idevicebackup2
            // absorbs in silence — it never checks its own fwrite/fclose, so this
            // can arrive alongside exit code 0 and "Backup Successful."
            //
            // BACKLOG-2913: this branch used to carry its own, vaguer sentence
            // ("free up space and try again"), so which of the two disk messages the
            // user saw depended on which detector happened to fire. Both paths now
            // share one constant. The cause is still recorded so the support log can
            // tell a mid-transfer fill from a device-reported 105.
            errorMessage = BACKUP_HOST_DISK_FULL_MESSAGE;
            errorCode = "INSUFFICIENT_SPACE";
            failureCause = {
              ...parseDeviceBackupError(stdoutBuffer, stderrBuffer),
              exitCode: code,
            };
          } else {
            // BACKLOG-2915 (round 4): a disconnect event may still be in flight.
            //
            // The poller runs every 2 s and `idevicebackup2` exits the moment the
            // channel dies, so on the founder's real cable pull the OS event arrived
            // 468 ms AFTER this point. Waited out only when a late event could still
            // change the answer — see DISCONNECT_SETTLE_MS.
            if (
              this.hasDisconnectFeed &&
              // BACKLOG-2915 (round 5, SR F5): a cancel never needs this window, and
              // ANSWER-PRESERVINGLY so — the cancel rung sits ABOVE the observed rung,
              // so no disconnect arriving here could change the classification. All it
              // could change is how long the user waits, and SR measured a cancel paying
              // the full 3,035 ms for an event that cannot matter. That stacks on the
              // up-to-30 s SIGKILL grace, so a cancel was taking ~35 s.
              !this.cancelRequested &&
              !this.deviceDisconnectedDuringRun &&
              !this.mobilebackup2ReceiveFailure &&
              this.latchedDeviceError === null
            ) {
              await this.awaitDisconnectSettle();
            }
            const classification = this.classifyFailure(
              code,
              stdoutBuffer,
              stderrBuffer,
            );
            if (this.deviceOutcomeLine !== null) {
              log.info(
                `[BackupService] idevicebackup2's own outcome line: Backup ${this.deviceOutcomeLine}`,
              );
            }
            errorMessage = classification.message;
            errorCode = classification.errorCode;
            failureCause = classification.cause;
          }
        }

        const result: BackupResult = {
          success,
          backupPath: success ? finalBackupPath : null,
          error: errorMessage,
          ...(errorCode ? { errorCode } : {}),
          ...(failureCause ? { failureCause } : {}),
          duration: Date.now() - this.startTime,
          deviceUdid: options.udid,
          isIncremental: this.resolveIsIncremental(previousBackupExists, options),
          deviceReportedBackupMode: this.deviceReportedBackupMode,
          backupSize,
          isEncrypted: encryptionInfo.isEncrypted,
        };

        this.lastProgress = {
          phase: "finishing",
          percentComplete: success ? 100 : 0,
          currentFile: null,
          filesTransferred: 0,
          totalFiles: null,
          // BACKLOG-2917 — see the decrypting-phase progress above.
          bytesTransferred: backupSize ?? 0,
          totalBytes: backupSize,
          batchBytesTransferred: null,
          batchTotalBytes: null,
          deviceOverallPercent: this.deviceOverallPercent,
          estimatedTimeRemaining: 0,
        };
        this.emit("progress", this.lastProgress);
        this.emit("complete", result);

        resolve(result);
      });
    });
  }

  /**
   * BACKLOG-2915: a NEW SYNC is beginning — forget anything the last one asked for.
   *
   * The only place `cancelRequested` is cleared. `deviceSyncOrchestrator` calls it where
   * a sync starts, alongside the fresh `AbortController` that is the sync's own cancel
   * scope. It used to be cleared in the per-RUN reset inside `startBackup`, which is why
   * a cancel could not survive to the next run of the same sync.
   *
   * If a caller ever forgets to call this, the failure is loud and immediate — every
   * subsequent backup reports "Backup was cancelled" — which is strictly better than the
   * silent misclassification it replaces, and it is what ROW 28 and ROW 29c catch.
   */
  /**
   * BACKLOG-2915 (round 4): the caller undertakes to report device disconnects.
   *
   * Called by `deviceSyncOrchestrator`, which already receives `device-disconnected`
   * from `deviceDetectionService`. It gates the settle wait: without a feed there is no
   * late event to wait for, so nothing waits.
   */
  attachDeviceDisconnectFeed(): void {
    this.hasDisconnectFeed = true;
  }

  /**
   * BACKLOG-2915 (round 4): the OS says this device is gone.
   *
   * Guarded on the UDID of the run in flight — another iPhone being unplugged says
   * nothing about this backup, and latching it would turn an unrelated event into a
   * stated fact.
   *
   * Verified safe by observation, not assumed: the founder's session log shows
   * `Starting device polling (interval: 2000ms)` at 23:34:54.815 with no stop before the
   * next app start, so `idevice_id -l` polled every 2 s throughout a 19-minute sync that
   * transferred 5.8 GB at ~49 MB/s. Polling does not disturb the mobilebackup2 session.
   */
  noteDeviceDisconnected(udid: string): void {
    // Accepted while the run is alive OR while the close path is still waiting for
    // exactly this — see `runDeviceUdid`.
    if (!this.isRunning && this.disconnectSettleResolver === null) return;
    if (this.runDeviceUdid !== null && this.runDeviceUdid !== udid) return;
    if (!this.deviceDisconnectedDuringRun) {
      log.warn(
        "[BackupService] The OS reported the device disconnected during this backup",
      );
    }
    this.deviceDisconnectedDuringRun = true;
    // If the close path is waiting for exactly this, stop waiting.
    this.disconnectSettleResolver?.();
  }

  /**
   * BACKLOG-2915 (round 4): wait out {@link DISCONNECT_SETTLE_MS}, or return the moment
   * a disconnect arrives. See that constant for the measurement behind it.
   */
  private awaitDisconnectSettle(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.disconnectSettleResolver = null;
        resolve();
      }, BackupService.DISCONNECT_SETTLE_MS);
      this.disconnectSettleResolver = () => {
        clearTimeout(timer);
        this.disconnectSettleResolver = null;
        resolve();
      };
    });
  }

  beginSyncScope(): void {
    if (this.cancelRequested) {
      log.info("[BackupService] New sync scope — clearing the pending cancel");
    }
    this.cancelRequested = false;
  }

  /**
   * Cancel an in-progress backup
   */
  cancelBackup(): void {
    log.info("[BackupService] Cancelling backup");

    // BACKLOG-1582: Clear watchdog on cancel
    this.clearWatchdog();

    // BACKLOG-2915: record that this was US, before anything can classify the exit.
    // A cancel is SIGTERM -> clean_exit -> exit 255 with no device code, which is
    // exactly the shape the link-drop inference rung matches. Without this latch every
    // cancelled backup would tell the user their cable had failed.
    this.cancelRequested = true;

    const proc = this.currentProcess;
    if (!proc) {
      // Race between spawn and cancel: nothing to wait for, so reset immediately.
      this.isRunning = false;
      return;
    }

    proc.kill("SIGTERM");

    // BACKLOG-2915: 30 s, not 5. `clean_exit` needs the process to unwind before stdio
    // flushes, and that took 13.1 s when it was measured. See SIGKILL_GRACE_MS.
    setTimeout(() => {
      if (BackupService.isStillRunning(proc)) {
        log.warn(
          `[BackupService] Cancel: no exit ${BackupService.SIGKILL_GRACE_MS / 1000}s after SIGTERM — escalating to SIGKILL`,
        );
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
      // `unref` so a pending escalation cannot by itself hold the event loop open. In
      // the Electron main process the loop is alive regardless, so the timer still
      // fires; what it stops is a 30/45-second tail on a process otherwise finished.
    }, BackupService.SIGKILL_GRACE_MS).unref?.();

    // BACKLOG-2915 (SR B1): `isRunning` is NOT cleared here any more.
    //
    // It used to be cleared synchronously, which meant the 13.1-second flush arrived
    // into a run the service already considered finished — and a second backup could
    // be started on top of a process that was still writing. The close handler owns
    // the transition now, with this bounded backstop for a process that never closes
    // at all. Start-after-cancel is therefore blocked for at most
    // POST_KILL_STATE_RESET_MS.
    setTimeout(() => {
      if (this.isRunning && this.currentProcess === proc) {
        log.error(
          "[BackupService] Cancel: process never closed — force-resetting state",
        );
        this.isRunning = false;
        this.currentProcess = null;
        this.currentDeviceUdid = null;
      }
    }, BackupService.POST_KILL_STATE_RESET_MS).unref?.();
  }

  /**
   * BACKLOG-2915: has this process NOT exited yet?
   *
   * The guard this replaces was `!proc.killed`, and it was dead code: node sets
   * `.killed` to true after any successful `kill()`, including the SIGTERM sent one
   * line earlier, so the escalation could never run. The capture proves it empirically
   * — `capture.js` carries the identical `if (!p.killed)` guard, its events log
   * contains ZERO occurrences of SIGKILL, and the process lived to 13.128 s.
   *
   * Both halves are needed. A process that exited normally has a numeric `exitCode`; a
   * process reaped by a signal keeps `exitCode === null` forever and reports
   * `signalCode` instead, so testing `exitCode === null` alone would re-KILL a corpse
   * on every signal-terminated run.
   */
  private static isStillRunning(proc: ChildProcess): boolean {
    return proc.exitCode === null && proc.signalCode === null;
  }

  /**
   * BACKLOG-1582: Start the watchdog timer that detects zombie idevicebackup2 processes.
   * If no stdout activity is received within the timeout, kills the process.
   */
  private startWatchdog(): void {
    this.clearWatchdog();
    const timeoutMs = BackupService.WATCHDOG_NO_PROGRESS_TIMEOUT_MS;
    log.info(
      `[BackupService] Watchdog started (no-progress timeout: ${timeoutMs / 1000}s)`,
    );

    this.watchdogInterval = setInterval(() => {
      if (!this.currentProcess || !this.isRunning) {
        this.clearWatchdog();
        return;
      }

      // BACKLOG-2911 (FIX 2): the question is "has anything HAPPENED", not "has
      // anything been PRINTED". BACKLOG-1628's requirement is preserved through the
      // signal list rather than through the stream: a silent stdout during a manifest
      // upload is still kept alive, by the SSL_write lines that upload produces.
      const elapsed = Date.now() - this.lastMeaningfulActivityAt;
      if (elapsed >= timeoutMs) {
        log.error(
          `[BackupService] Watchdog: no progress for ${Math.round(elapsed / 1000)}s — killing zombie process`,
        );
        this.killZombieProcess();
      }
    }, BackupService.WATCHDOG_CHECK_INTERVAL_MS);
  }

  /**
   * BACKLOG-2911 (FIX 2): something happened. Restart the clock.
   *
   * Every call site is a place where the process demonstrated work: stdout from
   * idevicebackup2, or an stderr line carrying traffic. Adding a call site is adding
   * something the watchdog will accept as life, so add one only for output that cannot
   * be produced by an idle connection.
   */
  private noteMeaningfulActivity(): void {
    this.lastMeaningfulActivityAt = Date.now();
  }


  /**
   * BACKLOG-2914: was this run incremental?
   *
   * The device's own report wins when it gave one. The old derivation — a directory
   * exists and nobody forced a full backup — remains as the fallback, because a run
   * that fails before the mode line is printed still has to answer, but it is a
   * FALLBACK now and telemetry records which of the two produced the flag.
   *
   * The fallback's failure mode is on record: on 2026-08-28 it reported
   * `incremental=true` for a 61.2 GB / 52-minute transfer against a 4.4 GB partial
   * with no `Manifest.db`, while `Status.plist` said `IsFullBackup: 1`.
   */
  private resolveIsIncremental(
    previousBackupExists: boolean,
    options: BackupOptions,
  ): boolean {
    if (this.deviceReportedBackupMode !== null) {
      return this.deviceReportedBackupMode === "incremental";
    }
    return previousBackupExists && !options.forceFullBackup;
  }

  /**
   * BACKLOG-1582: Clear the watchdog interval.
   */
  private clearWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  /**
   * BACKLOG-1582: Kill an unresponsive idevicebackup2 process.
   * Sets watchdogFired flag so the close handler emits a BACKUP_TIMEOUT result.
   */
  private killZombieProcess(): void {
    if (!this.currentProcess || this.currentProcess.killed) return;

    this.watchdogFired = true;
    this.clearWatchdog();

    const pid = this.currentProcess.pid;
    log.warn(`[BackupService] Watchdog: killing unresponsive process (PID: ${pid})`);

    Sentry.captureMessage("Backup process killed by watchdog (zombie detected)", {
      level: "warning",
      tags: { component: "backup_service", platform: process.platform },
      extra: {
        pid,
        durationAliveMs: Date.now() - this.backupCommandStartTime,
        lastProgress: this.lastProgress?.phase,
        hasReceivedFileProgress: this.hasReceivedFileProgress,
        hasEmittedPasscodeWaiting: this.hasEmittedPasscodeWaiting,
      },
    });

    try {
      this.currentProcess.kill("SIGTERM");
    } catch (err) {
      log.error(`[BackupService] Watchdog: kill failed, pid=${pid}`, err);
    }

    // BACKLOG-2915: SIGKILL after SIGKILL_GRACE_MS (was 5 s), and only if the process
    // is genuinely still running. The old guard `!this.currentProcess.killed` was true
    // the instant the SIGTERM above succeeded, so this escalation had never once run.
    // On Windows SIGTERM already hard-kills, so there is nothing to escalate to.
    const zombie = this.currentProcess;
    if (process.platform !== "win32") {
      setTimeout(() => {
        try {
          if (BackupService.isStillRunning(zombie)) {
            log.warn(
              `[BackupService] Watchdog: no exit ${BackupService.SIGKILL_GRACE_MS / 1000}s after SIGTERM — escalating to SIGKILL`,
            );
            zombie.kill("SIGKILL");
          }
        } catch { /* process already dead */ }
      }, BackupService.SIGKILL_GRACE_MS);
    }

    // Safety net: if close event never fires after kill, force-reset state.
    //
    // BACKLOG-2915 (SR B1): 45 s, not 10. Ten seconds is LESS THAN the 13.1-second
    // graceful shutdown that was measured, so this timer used to fire first on every
    // single kill — declaring the run dead, emitting BACKUP_TIMEOUT and nulling
    // `currentProcess` three seconds before idevicebackup2's final flush delivered the
    // outcome. Raising the SIGKILL grace without raising this one would have bought
    // exactly nothing.
    setTimeout(() => {
      if (this.isRunning && this.currentProcess) {
        log.error("[BackupService] Watchdog: process did not exit after kill, force-resetting state");
        this.isRunning = false;
        this.currentProcess = null;
        this.currentDeviceUdid = null;
        this.emit("error", Object.assign(new Error("Backup process became unresponsive and was terminated"), {
          code: "BACKUP_TIMEOUT",
        }));
      }
    }, BackupService.POST_KILL_STATE_RESET_MS);
  }

  /**
   * BACKLOG-2898: classify ONE stderr line as a real error signal, benign
   * libimobiledevice debug chatter, or something unrecognised.
   *
   * Called for every stderr line on a hot path (30K+ lines in 20s during
   * manifest upload), so every test is a cheap substring or a single anchored
   * regex.
   */
  private classifyStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // A libimobiledevice MUTEX trace: `np_lock(): Locked`, `np_unlock():
    // Unlocked`, `afc_lock(): Locked`. The word "Locked" here is a pthread
    // mutex state inside notification_proxy.c — it says nothing about the
    // DEVICE being locked, and it is emitted continuously during a healthy
    // backup. Strip the trace before testing for trigger words, so a line that
    // ALSO carries a genuine signal is still caught.
    const withoutMutexTrace = trimmed.replace(
      BackupService.LIBIMOBILEDEVICE_MUTEX_TRACE,
      "",
    );

    const lower = withoutMutexTrace.toLowerCase();
    const isErrorPattern = BackupService.STDERR_ERROR_WORDS.some((word) =>
      lower.includes(word),
    );

    if (isErrorPattern) {
      log.warn("[BackupService] stderr (error pattern):", trimmed.substring(0, 500));
      return;
    }

    // BACKLOG-1628: Sentry breadcrumbs for unrecognised non-debug lines, which
    // may indicate error patterns we have not categorised yet.
    //
    // BACKLOG-2898: this is now per LINE where it used to be per chunk, so it
    // is bounded two ways — libimobiledevice's own debug-trace format counts as
    // a known debug line, and identical lines (ignoring numbers) breadcrumb
    // once per backup. Without both, a chunk that produced one breadcrumb could
    // produce dozens and push the useful ones out of Sentry's ring buffer.
    const fingerprint = trimmed.replace(/\d+/g, "#").substring(0, 200);
    if (this.breadcrumbedStderrLines.has(fingerprint)) return;
    if (this.breadcrumbedStderrLines.size >= BackupService.MAX_STDERR_BREADCRUMBS) return;
    this.breadcrumbedStderrLines.add(fingerprint);

    Sentry.addBreadcrumb({
      category: "backup",
      message: trimmed.substring(0, 200),
      level: "info",
    });
  }


  /**
   * Build backup command arguments
   *
   * Note: the `backup` command accepts exactly one option, --full, so the argv
   * built here is the whole of what we are able to ask the device for. We need
   * only messages and contacts (HomeDomain); we receive the entire device
   * regardless. See BACKLOG-2910 and docs/BACKUP_RESEARCH.md.
   *
   * SECURITY (TASK-601): The validatedUdid parameter MUST be pre-validated using
   * validateDeviceUdid() before calling this method. This is a private method,
   * so the caller (startBackup) is responsible for validation.
   *
   * @param options - Backup options
   * @param backupPath - Destination path for backup
   * @param validatedUdid - Pre-validated device UDID (caller must validate)
   */
  private buildBackupArgs(
    options: BackupOptions,
    backupPath: string,
    validatedUdid: string,
  ): string[] {
    const args: string[] = [];

    // BACKLOG-2915: `-d` IS GONE, AND WITH IT EVERY REASON THIS SERVICE HAD TO READ
    // STDERR.
    //
    // `-d` maps to exactly one statement in idevicebackup2's option parser —
    // `case 'd': idevice_set_debug_level(1);` (idevicebackup2.c:1549-1550). It never
    // touches `verbose`, so **stdout is byte-identical with and without it**. All the
    // flag ever did was turn on libimobiledevice's `debug_info_real`
    // (`common/debug.c:91`, `if (!debug_level) return;`) and flood stderr.
    //
    // What that flood cost, measured on the founder's real runs of 2026-08-27:
    // stderr hit the 65 KB tail cap in 5 of 5 failures, 336 chatter records in one
    // 21-minute log, and every one of those records was logged as an "error pattern"
    // because libimobiledevice writes `np_lock(): Locked` hundreds of times a run
    // (BACKLOG-2903). It also kept the watchdog's liveness clock permanently fresh,
    // which is why BACKLOG-1582's zombie detector never once fired (BACKLOG-2911).
    //
    // What it costs to remove, measured in the 2026-08-30 live capture: stderr
    // emitted **11 bytes in 20 minutes**, all of them the `Exiting...` we caused
    // ourselves with SIGTERM. Every signal this service actually needs — the backup
    // mode, `Sending '<udid>/Manifest.db'`, `Requesting backup from device...`,
    // `ErrorCode N: ...`, the progress renders, `Received N files from device.` and
    // the outcome line — is `printf` on STDOUT and is unaffected. See
    // `parseStdoutLine`.
    //
    // The one genuine loss is `usbmuxd_send returned -N (Broken pipe)`, which only
    // ever existed under `-d`. It is replaced by the inference rung in
    // `classifyBackupFailure` (BACKLOG-2915 D1, founder decision 2026-08-30).

    // Target device by UDID
    // SECURITY: validatedUdid must be validated before this call
    args.push("-u", validatedUdid);

    // Command: backup
    args.push("backup");

    // Force full backup if requested (otherwise incremental)
    if (options.forceFullBackup) {
      args.push("--full");
    }

    // Backup destination path
    args.push(backupPath);

    return args;
  }

  // ==========================================================================
  // BACKLOG-2915: STDOUT IS THE PROGRESS STREAM. THESE ARE ITS LINES.
  //
  // Every pattern below was TRANSCRIBED from the live capture of 2026-08-30 kept at
  // ~/Developer/keepr-captures/2915/ (a 20-minute run against a real device, UDIDs
  // redacted at capture time), and cross-checked against libimobiledevice 1.4.0's
  // tools/idevicebackup2.c and against the format strings in the binary this app
  // executes. None of them is invented.
  // ==========================================================================

  /**
   * The BYTE progress render: `[====      ]  48% (24.2 MB/50.8 MB)` + five spaces.
   *
   * From `print_progress_real()` (idevicebackup2.c:665-682): `"\r["`, 50 cells,
   * `"] %3.0f%%"`, then `progress_printf(" (%s/%s)     ")`. `%3.0f` right-aligns the
   * percent in three columns, so `]   0%`, `]  48%` and `] 100%` all occur and the
   * `\s*` is load-bearing.
   *
   * BOTH NUMBERS ARE PER-BATCH. See {@link BackupProgress.batchBytesTransferred}.
   *
   * Units come from libimobiledevice-glue's `string_format_size()`: `%d Bytes` below
   * 1000 (integer, no decimal), then `%0.1f` KB/MB/GB/TB. The regex this replaced
   * accepted `(MB|KB|GB)` only, so it silently dropped every small batch — the capture
   * contains 16 renders with `Bytes` in the numerator, e.g.
   * `(373 Bytes/20.1 MB)` and `(79 Bytes/64.0 KB)`. `Bytes` as a DENOMINATOR and `TB`
   * in either position are source-verified but were not seen live.
   *
   * Anchored at `^` on purpose. `Content:` (idevicebackup2.c:2508-2513) prints
   * arbitrary DEVICE-SUPPLIED text on this same stream, and an unanchored render
   * pattern would eventually read a message body as progress. The anchor also makes
   * the parser degrade safely against upstream's ANSI-cursor rewrite
   * (`\033[1A`, `\033[2K` before the bar): such a line starts with ESC, matches
   * nothing, and is a no-op rather than a crash or a wrong number.
   */
  private static readonly STDOUT_BYTE_RENDER =
    /^\[[^\]]*\]\s*(\d{1,3})% \((\d+(?:\.\d+)?)\s*(Bytes|KB|MB|GB|TB)\/(\d+(?:\.\d+)?)\s*(Bytes|KB|MB|GB|TB)\)/;

  /**
   * The OVERALL render: `[=========    ]  17% Finished` — the DEVICE'S OWN percent.
   *
   * A DIFFERENT NUMBER from the byte render above, and conflating the two is the bug
   * this whole item exists to fix: in the capture the byte bar read 48% while this one
   * read 94%, in the same second.
   *
   * It is sparse and bursty — 37 of these against 76,024 byte renders — because
   * `print_progress_real(overall_progress, 0)` at :2524 passes `flush = 0`, so the
   * value only reaches us on the next byte render's flush. The distinct sequence
   * observed was 0,1,2,3,4,5,6,8,9,10,11,12,17,62,75,94: 7 never appeared and the last
   * four steps are enormous.
   *
   * Unlike the byte render this one IS newline-terminated, by the `" Finished\n"` at
   * :2525.
   */
  private static readonly STDOUT_OVERALL_RENDER = /^\[[^\]]*\]\s*(\d{1,3})% Finished\s*$/;

  /** `Sending '<udid>/Manifest.db' (869.3 MB)` — `PRINT_VERBOSE(1, ...)` at :833, so STDOUT. */
  private static readonly STDOUT_MANIFEST_UPLOAD =
    /Sending\s+'[^']*\/Manifest\.db'\s+\(([^)]+)\)/;

  /** `Received 4604 files from device.` — the GRAND total (`file_count +=` at :2309, printed once at :2568). */
  private static readonly STDOUT_RECEIVED_FILES = /Received\s+(\d+)\s+files\s+from\s+device/;

  /** `ErrorCode 208: Device locked (MBErrorDomain/208)` — `printf` at :2500, unconditional. */
  private static readonly STDOUT_ERROR_CODE_LINE = /^[ \t]*ErrorCode[ \t]+(\d+):[ \t]*(.*)$/;

  /** `Backup Failed (Error Code 208).` — the closing summary. Secondary source; see below. */
  private static readonly STDOUT_FAILED_SUMMARY = /Backup Failed \(Error Code (\d+)\)/;

  /** `*** Waiting for passcode to be entered on the device ***` — iOS >= 16.1 only, :2055-2063. */
  private static readonly PASSCODE_PROMPT_LINE =
    "*** Waiting for passcode to be entered on the device ***";

  /**
   * BACKLOG-2915: take one chunk of stdout, return AT MOST ONE progress event.
   *
   * Splits on `[\r\n]` — both, because renders are `\r`-delimited and everything else
   * is `\n`-terminated — and holds the trailing partial across chunks.
   *
   * THE EMIT POLICY (SR B4). Lines within a chunk did not necessarily happen at
   * different times: stdout is fully buffered on a pipe (idevicebackup2 calls no
   * `setvbuf`, and the only `fflush` in the progress path runs inside
   * `print_progress()`), so the capture's first chunk delivered eleven lines printed
   * across 9.4 minutes in one 826-byte read. Emitting per line would walk the UI
   * backwards inside a single tick. Instead the chunk yields one snapshot: the
   * furthest-along phase it contained, and within one phase the last one seen.
   */
  private consumeStdoutChunk(output: string): BackupProgress | null {
    this.stdoutLineBuffer += output;
    const parts = this.stdoutLineBuffer.split(/[\r\n]/);
    this.stdoutLineBuffer = parts.pop() ?? "";
    if (this.stdoutLineBuffer.length > BackupService.MAX_STDOUT_PARTIAL_LINE) {
      // Nothing idevicebackup2 prints is this long without a terminator. Drop it
      // rather than grow without bound on a stream we no longer control the format of.
      log.warn(
        `[BackupService] Discarding an unterminated stdout line of ${this.stdoutLineBuffer.length} bytes`,
      );
      this.stdoutLineBuffer = "";
    }

    let best: BackupProgress | null = null;
    for (const line of parts) {
      const next = this.parseStdoutLine(line);
      if (!next) continue;
      if (
        best === null ||
        BackupService.phaseRank(next.phase) >= BackupService.phaseRank(best.phase)
      ) {
        best = next;
      }
    }
    return best;
  }

  /**
   * BACKLOG-2915 (SR B4): parse whatever partial line is still held, at `close`.
   *
   * A byte render has no terminator, so the final render of EVERY run is still held at
   * this point and was, before this, dropped on the floor every time. A `data` event is
   * a pipe read, not a line, so any other line can be left held too.
   *
   * It EMITS rather than only latching, because the held render carries the last thing
   * known about how far the batch got, and a consumer that never receives it is stuck
   * on the second-to-last value. Called before the close handler reads any latch, so
   * `deviceReportedBackupMode` and the device error code are set from it in time to
   * decide the result.
   */
  private flushStdoutLineBuffer(): void {
    const tail = this.stdoutLineBuffer;
    this.stdoutLineBuffer = "";
    if (!tail) return;
    const progress = this.parseStdoutLine(tail);
    if (progress) {
      this.lastProgress = progress;
      this.emit("progress", progress);
    }
  }

  /** preparing < transferring < finishing. Used only to order candidates within one chunk. */
  private static phaseRank(phase: BackupProgress["phase"]): number {
    switch (phase) {
      case "preparing":
        return 0;
      case "transferring":
        return 1;
      default:
        return 2;
    }
  }

  /**
   * BACKLOG-2915: classify ONE complete stdout line, update the run's latches, and
   * return a progress snapshot if the line moved anything the UI cares about.
   *
   * This replaces `parseProgress`, which regexed the whole raw chunk and returned the
   * first branch that matched anywhere in it. That could not see a `\r`-delimited
   * render at all except by accident, could not tell the byte render from the overall
   * render (they differ only in their tail), and had no way to latch anything.
   */
  private parseStdoutLine(line: string): BackupProgress | null {
    if (!line) return null;

    // ---- 1. byte render (per-batch) -------------------------------------------
    const byteRender = BackupService.STDOUT_BYTE_RENDER.exec(line);
    if (byteRender) {
      const current = this.parseBytes(parseFloat(byteRender[2]), byteRender[3]);
      const total = this.parseBytes(parseFloat(byteRender[4]), byteRender[5]);
      this.openBatch(total, current);
      this.batchBytesTransferred = current;
      this.batchTotalBytes = total;
      this.bytesTransferred = this.completedBatchBytes + current;
      // Bytes have MOVED. That is the claim `transferStarted` makes downstream, and it
      // is why the overall render below does not make it: a `0% Finished` says the
      // device is reporting, not that anything has been received.
      this.markTransferStarted();
      return this.progressSnapshot("transferring");
    }

    // ---- 2. overall render (device-authored percent) --------------------------
    const overallRender = BackupService.STDOUT_OVERALL_RENDER.exec(line);
    if (overallRender) {
      this.deviceOverallPercent = Number.parseInt(overallRender[1], 10);
      return this.progressSnapshot(
        this.hasReceivedFileProgress ? "transferring" : "preparing",
      );
    }

    // ---- 3. the device's own error code ---------------------------------------
    const errorLine = BackupService.STDOUT_ERROR_CODE_LINE.exec(line);
    if (errorLine) {
      const description = errorLine[2].trim();
      // Last one wins: a run can print several, and the one that ended it is last.
      this.latchedDeviceError = {
        deviceErrorCode: Number.parseInt(errorLine[1], 10),
        deviceErrorDescription: description.length > 0 ? description : null,
        source: "stdout-line",
      };
      log.error(`[BackupService] Device reported ${line.trim()}`);
      return null;
    }

    // ---- 4. the backup mode, from the device ----------------------------------
    // BACKLOG-2914 latched this off STDERR, where idevicebackup2 has never written it:
    // `PRINT_VERBOSE(1, "Incremental backup mode.\n")` at :2051-2053 is a printf.
    // `deviceReportedBackupMode` therefore never once fired in production and
    // `resolveIsIncremental` always fell through to the directory heuristic whose
    // failure that item documents (a 61.2 GB, 52-minute run reported incremental).
    // Reading it here is the whole fix.
    if (line.includes("backup mode")) {
      const lower = line.toLowerCase();
      if (lower.includes("incremental backup mode")) {
        this.deviceReportedBackupMode = "incremental";
      } else if (lower.includes("full backup mode")) {
        this.deviceReportedBackupMode = "full";
      }
      log.info("[BackupService] " + line.trim());
      return null;
    }

    // ---- 5. the passcode line — latched, never surfaced live -------------------
    if (line.includes(BackupService.PASSCODE_PROMPT_LINE)) {
      this.deviceRequestedPasscode = true;
      log.info(
        "[BackupService] Device asked for a passcode (note: this line is buffered and can arrive minutes late)",
      );
      return null;
    }

    // ---- 6. manifest upload ---------------------------------------------------
    const manifest = BackupService.STDOUT_MANIFEST_UPLOAD.exec(line);
    if (manifest) {
      this.manifestUploadPhase = true;
      this.manifestUploadSize = manifest[1];
      log.info(`[BackupService] Manifest upload started (${this.manifestUploadSize})`);
      // Kept, and honestly so: on macOS this message is usually superseded inside its
      // own chunk, because the flush that delivers it also delivers the renders that
      // come minutes later. It still fires on a build or platform that flushes sooner.
      return this.progressSnapshot("preparing", {
        message: `Preparing incremental backup — uploading backup index (${this.manifestUploadSize})...`,
      });
    }

    // ---- 7. `Receiving files` — a new batch opens ------------------------------
    if (line.includes("Receiving files")) {
      this.closeBatch();
      // The branch this replaces returned `bytesTransferred: 0, filesTransferred: 0`.
      // `Receiving files` occurred 36 times in the captured run, so through the
      // renderer's `hasStartedTransfer` check the "N transferred - N files" block
      // blinked out and back 36 times in one sync. The snapshot is cumulative and
      // never regresses, so it cannot do that.
      return this.progressSnapshot("transferring");
    }

    // ---- 8. the device's own file count ---------------------------------------
    const received = BackupService.STDOUT_RECEIVED_FILES.exec(line);
    if (received) {
      this.filesReceivedFromDevice = Number.parseInt(received[1], 10);
      log.info(
        `[BackupService] Device reported ${this.filesReceivedFromDevice} files received`,
      );
      return this.progressSnapshot("finishing", { percentComplete: 95 });
    }

    // ---- 9. outcome lines ------------------------------------------------------
    if (line.includes("Backup Successful.")) {
      this.deviceOutcomeLine = "successful";
      return this.progressSnapshot("finishing", { percentComplete: 98 });
    }
    if (line.includes("Backup Aborted.")) {
      // Printed when `quit_flag` was set — i.e. something signalled the process.
      this.deviceOutcomeLine = "aborted";
      log.info("[BackupService] idevicebackup2 reported: Backup Aborted.");
      return null;
    }
    if (line.includes("Backup Failed")) {
      this.deviceOutcomeLine = "failed";
      // BACKLOG-2915 (SR I3): the closing summary carries the device's code too, and
      // until now the number was thrown away. It is a SECONDARY source — no
      // description, and only read when no `ErrorCode N: <desc>` line was latched, so
      // the richer line always wins. The gap it closes is small but real: the two lines
      // co-occurring is OBSERVED (the founder's 2026-08-27 log, code 208) rather than
      // proven, and a run that printed only the summary would otherwise lose its code
      // and drop to the inference rung — a device-reported `4` answered with cable
      // advice.
      const summaryCode = BackupService.STDOUT_FAILED_SUMMARY.exec(line);
      if (summaryCode && this.latchedDeviceError === null) {
        this.latchedDeviceError = {
          deviceErrorCode: Number.parseInt(summaryCode[1], 10),
          deviceErrorDescription: null,
          source: "stdout-summary",
        };
      }
      log.error(`[BackupService] idevicebackup2 reported: ${line.trim()}`);
      return null;
    }

    // ---- 10. early protocol chatter -------------------------------------------
    if (line.includes("Requesting backup from device")) {
      log.info("[BackupService] Requesting backup from device");
      if (this.manifestUploadPhase) {
        this.manifestUploadPhase = false;
        return this.progressSnapshot("preparing", {
          message: "Waiting for iPhone to process backup index...",
        });
      }
      return this.progressSnapshot("preparing");
    }
    if (line.includes("Starting backup")) {
      log.info("[BackupService] Starting backup...");
      return this.progressSnapshot("preparing");
    }
    if (line.includes("Negotiated Protocol Version")) {
      log.info("[BackupService] " + line.trim());
      return null;
    }
    if (line.includes("Sending") && line.includes("Status.plist")) {
      log.info("[BackupService] Sending Status.plist (initial negotiation)");
      return null;
    }
    if (line.includes("Sending") && line.includes("Manifest.plist")) {
      log.info("[BackupService] Sending Manifest.plist");
      return null;
    }

    // ---- 11. lines the plan did not have, added from the capture / source ------
    if (line.includes("Discarding current data hunk")) {
      // Printed on abort, mid-batch. Observed live; absent from the item body's table.
      log.info("[BackupService] idevicebackup2 discarded the in-flight data hunk");
      return null;
    }
    if (line.includes("Could not receive from mobilebackup2")) {
      // `PRINT_VERBOSE(0, ...)` — always on, and a genuine fault: idevicebackup2 saying
      // its own channel to the device died.
      //
      // BACKLOG-2915 (round 4): this was parsed, logged and DISCARDED. It fired on the
      // founder's real cable pull at 00:27:01.651, one millisecond before the process
      // exited — the only link signal fast enough to reach the classifier in time.
      this.mobilebackup2ReceiveFailure = true;
      log.error(`[BackupService] ${line.trim()}`);
      return null;
    }

    return null;
  }

  /** Bytes have started moving. Idempotent; drives `transferStarted` and the wait timer. */
  private markTransferStarted(): void {
    if (this.hasReceivedFileProgress) return;
    this.hasReceivedFileProgress = true;
    if (this.passcodeWaitingTimer) {
      clearTimeout(this.passcodeWaitingTimer);
      this.passcodeWaitingTimer = null;
    }
    if (this.hasEmittedPasscodeWaiting) {
      const waitTime = ((Date.now() - this.backupCommandStartTime) / 1000).toFixed(1);
      // BACKLOG-2911 (FIX 3): the transfer starting proves the transfer started. It
      // does NOT prove a passcode was entered — on 2026-08-28 the founder's passcode
      // had been entered ~15 minutes before this line printed, and the 2026-08-30
      // capture measured the same gap from the other side (entered ~t=150s, reported
      // at t=564s). The duration is the useful part and it is the whole claim.
      log.info(
        `[BackupService] File transfer started after ${waitTime}s of waiting for the device`,
      );
      this.emit("passcode-entered");
    }
  }

  /**
   * A render arrived for what may be a different batch than the one currently open.
   *
   * The device supplies a fresh total on every `DLMessageUploadFiles`, so a changed
   * total — or a current that has gone backwards — means the previous batch is done
   * and its bytes belong in the run total.
   */
  private openBatch(total: number, current: number): void {
    if (this.batchTotalBytes === null) return;
    if (total !== this.batchTotalBytes || current < (this.batchBytesTransferred ?? 0)) {
      this.closeBatch();
    }
  }

  /** Fold the open batch into the run total. Keeps `bytesTransferred` monotonic. */
  private closeBatch(): void {
    this.completedBatchBytes += this.batchBytesTransferred ?? 0;
    this.batchBytesTransferred = null;
    this.batchTotalBytes = null;
    this.bytesTransferred = this.completedBatchBytes;
  }

  /**
   * BACKLOG-2915: one progress event, built from the run's latches.
   *
   * `totalBytes` stays null and `percentComplete` keeps its existing time-based
   * derivation ON PURPOSE. The device's real percent is reported in
   * `deviceOverallPercent`, and wiring it through the orchestrator, the IPC payload
   * type and `SyncProgress.tsx` is BACKLOG-1925's scope by founder decision. Setting
   * `percentComplete` from the device here would reach the renderer unchanged whenever
   * `estimatedBackupSize` is 0, which is that scope, through that seam.
   */
  private progressSnapshot(
    phase: BackupProgress["phase"],
    extra?: Partial<BackupProgress>,
  ): BackupProgress {
    const percentComplete = this.calculateOverallPercent();
    return {
      phase,
      percentComplete,
      currentFile: null,
      // The DEVICE'S count, or 0 until it gives one. Never the old batch-counting
      // heuristic, which was out by 159x on the captured run.
      filesTransferred: this.filesReceivedFromDevice ?? 0,
      totalFiles: this.filesReceivedFromDevice,
      bytesTransferred: this.bytesTransferred,
      totalBytes: null,
      batchBytesTransferred: this.batchBytesTransferred,
      batchTotalBytes: this.batchTotalBytes,
      deviceOverallPercent: this.deviceOverallPercent,
      estimatedTimeRemaining: this.estimateTimeRemaining(percentComplete),
      ...extra,
    };
  }

  /**
   * BACKLOG-2913: classify a failed backup from what the device actually reported.
   *
   * This used to be a substring ladder over the raw `-d` debug stream, and every
   * failure — disk full, cable pulled, service stuck, genuinely locked — came out as
   * "iPhone is locked. Please unlock your iPhone and try again.", because
   * libimobiledevice writes `afc_lock(): Locked` hundreds of times per run and the
   * `locked` rung sat above every other rung. Four causes were observed on the
   * founder's machine in one evening and all four produced that sentence.
   *
   * The work now lives in the exported {@link classifyBackupFailure}, which is a
   * pure function of the two streams and the exit code, so the real captured output
   * can be tested against it without spawning anything.
   */
  private classifyFailure(
    code: number | null,
    stdout: string,
    stderr: string,
  ): BackupFailureClassification {
    // BACKLOG-2913 (copy defect): `hasReceivedFileProgress` is the transfer-started
    // signal, and `bytesTransferred` deliberately is NOT. The latter only advances
    // when a whole file COMPLETES (the percent-drop heuristic in parseProgress), so
    // a drop part-way through the first file reads zero bytes while transfer is
    // demonstrably under way — and the user would get cable advice for a sleep or a
    // power-management fault. `hasReceivedFileProgress` flips on the first progress
    // bar, which cannot be emitted before enumeration, pairing and the passcode.
    const classification = classifyBackupFailure(
      code,
      stdout,
      stderr,
      this.hasReceivedFileProgress,
      {
        // BACKLOG-2915 (SR B3): the code as latched off the live stream, not as
        // re-read from a 65 KB tail that now holds ~7 seconds of progress renders.
        latchedDeviceError: this.latchedDeviceError,
        // BACKLOG-2915: without this the inference rung below calls a user cancel a
        // dropped cable. See BackupFailureEvidence.cancelRequested.
        cancelRequested: this.cancelRequested,
        // BACKLOG-2915 (round 4): observation, so the link-drop class stops being a
        // guess. See BackupLinkDropEvidence.
        deviceDisconnected: this.deviceDisconnectedDuringRun,
        mobilebackup2ReceiveFailure: this.mobilebackup2ReceiveFailure,
      },
    );
    log.error("[BackupService] Failure classified", {
      // BACKLOG-2915: recorded because it is the one thing a support log cannot
      // reconstruct afterwards. It is NOT used to classify anything — the line is
      // gated on iOS >= 16.1 inside a 2-second race and arrived SEVEN MINUTES late in
      // the 2026-08-30 capture, so it can only ever be read post-mortem.
      deviceRequestedPasscode: this.deviceRequestedPasscode,
      deviceOutcomeLine: this.deviceOutcomeLine,
      // BACKLOG-2915 (round 4): a support log must be able to tell a fact from a guess.
      linkDropEvidence: classification.cause.linkDropEvidence,
      deviceDisconnectedDuringRun: this.deviceDisconnectedDuringRun,
      deviceErrorCode: classification.cause.deviceErrorCode,
      deviceErrorDescription: classification.cause.deviceErrorDescription,
      exitCode: classification.cause.exitCode,
      source: classification.cause.source,
      errorCode: classification.errorCode,
    });
    return classification;
  }

  /**
   * Parse bytes from value and unit.
   *
   * BACKLOG-2915: `Bytes` and `TB` are new here, and their absence was a real defect
   * rather than a theoretical one. libimobiledevice-glue's `string_format_size()`
   * (utils.c:196-216) prints `%d Bytes` below 1000 and `%0.1f` KB/MB/GB/TB above it;
   * the caller's regex accepted three of the five, so every render of a small batch
   * was silently dropped. The 2026-08-30 capture contains 16 such renders.
   *
   * 1024-based to match `string_format_size`, which divides by 1024.
   */
  private parseBytes(value: number, unit: string): number {
    switch (unit.toUpperCase()) {
      case "BYTES":
        return value;
      case "KB":
        return value * 1024;
      case "MB":
        return value * 1024 * 1024;
      case "GB":
        return value * 1024 * 1024 * 1024;
      case "TB":
        return value * 1024 * 1024 * 1024 * 1024;
      default:
        return value;
    }
  }

  /**
   * Calculate overall progress percentage.
   *
   * BACKLOG-2915: THIS IS A TIME-BASED ESTIMATE AND NOTHING ELSE. It always mostly was
   * — `elapsedMinutes / estimatedTotalMinutes`, capped at 94 — but it also carried a
   * blend against `filesCompleted`, fed by the per-file heuristic that is now deleted
   * because the render it read is per-BATCH. That blend is gone rather than left as a
   * branch that can no longer be taken.
   *
   * The honest number now exists next to this one: `deviceOverallPercent`, authored by
   * the device. Replacing `percentComplete` with it is deliberately NOT done here —
   * see `progressSnapshot`, and BACKLOG-1925.
   */
  private calculateOverallPercent(): number {
    const elapsedMs = Date.now() - this.startTime;
    const elapsedMinutes = elapsedMs / 1000 / 60;

    // Estimate total time based on typical backup sizes
    // We use a heuristic: if we've been going > 5 min, assume it's a larger backup
    let estimatedTotalMinutes: number;

    if (elapsedMinutes < 2) {
      // Early phase - assume 10 minutes total (will adjust as we go)
      estimatedTotalMinutes = 10;
    } else if (elapsedMinutes < 10) {
      // Getting data - estimate based on rate
      estimatedTotalMinutes = Math.max(elapsedMinutes * 3, 15);
    } else {
      // Long backup - use logarithmic scaling to avoid stalling at high %
      estimatedTotalMinutes = elapsedMinutes * 1.5;
    }

    // Calculate percentage, capped at 94% until we get a completion signal
    const percent = Math.min((elapsedMinutes / estimatedTotalMinutes) * 100, 94);

    return Math.max(percent, 1); // Never show 0%
  }

  /**
   * Estimate remaining time based on progress and elapsed time
   */
  private estimateTimeRemaining(percentComplete: number): number | null {
    if (percentComplete <= 0 || this.startTime === 0) {
      return null;
    }

    const elapsed = (Date.now() - this.startTime) / 1000; // seconds
    const estimatedTotal = elapsed / (percentComplete / 100);
    const remaining = estimatedTotal - elapsed;

    return Math.max(0, Math.round(remaining));
  }

  /**
   * Get the default backup path in app's userData folder
   */
  private getDefaultBackupPath(): string {
    return path.join(app.getPath("userData"), "Backups");
  }

  /**
   * Measure the total size of a backup directory.
   * BACKLOG-1086: Use atomic readdir instead of check-then-read (TOCTOU fix).
   *
   * BACKLOG-2917: this returned `number` and answered `0` on any throw, so an
   * unreadable backup and an empty one were the same value. Two distinct defects
   * followed from that, and only the first had been reported:
   *
   *  1. The whole walk throwing reported a real backup as 0 bytes. Downstream that
   *     becomes `{ exists: true, sizeBytes: 0 }`, a successful backup annotated
   *     `bytes: 0`, and a real backup listed to the user at size 0.
   *  2. **The recursion swallowed subtree failures silently.** Every recursive call
   *     had its own catch-all, so one unreadable subdirectory returned 0 for that
   *     subtree and the PARENT added 0 and carried on — returning a short total with
   *     no error anywhere. A partial sum presented as a measurement is worse than a
   *     failure, because nothing downstream can tell it apart from a smaller backup.
   *     Unmeasured now propagates up through the recursion.
   *
   * `measureBackupSize` is the name because `calculateBackupSize` returning a
   * `BackupSizeReading` would leave every existing call site compiling unchanged.
   *
   * Note the ENOENT paths are NOT failures and stay `measured`: a directory that does
   * not exist genuinely holds 0 bytes, and a file that vanished between `readdir` and
   * `stat` is a normal race in a directory the device is still writing to.
   */
  private async measureBackupSize(backupPath: string): Promise<BackupSizeReading> {
    try {
      let totalSize = 0;
      // Atomic: attempt readdir directly, handle ENOENT if path disappeared
      let files: import("fs").Dirent[];
      try {
        files = await fs.readdir(backupPath, { withFileTypes: true });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
          return { measured: true, bytes: 0 };
        }
        throw err;
      }

      for (const file of files) {
        const filePath = path.join(backupPath, file.name);
        if (file.isDirectory()) {
          const subtree = await this.measureBackupSize(filePath);
          // The defect this replaces: an unmeasurable subtree used to contribute 0
          // and the parent reported a short total as if it were a measurement.
          if (!subtree.measured) {
            return subtree;
          }
          totalSize += subtree.bytes;
        } else {
          try {
            const stats = await fs.stat(filePath);
            totalSize += stats.size;
          } catch (statErr: unknown) {
            // File may have been removed between readdir and stat; skip it
            if (statErr && typeof statErr === "object" && "code" in statErr && (statErr as { code: string }).code === "ENOENT") {
              continue;
            }
            throw statErr;
          }
        }
      }

      return { measured: true, bytes: totalSize };
    } catch (error) {
      log.error("[BackupService] Error measuring backup size:", error);
      Sentry.captureException(error, {
        tags: { service: "backup", operation: "measureBackupSize" },
      });
      return { measured: false, reason: describeError(error) };
    }
  }

  /**
   * Check if a path exists
   */
  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a backup for a device exists and its status.
   *
   * BACKLOG-2917: returns a three-state report. It used to return `null` for BOTH
   * "ENOENT, no backup exists" and "the check itself threw", which are opposite
   * facts. `deviceSyncOrchestrator` read the collapsed value as a first sync, so a
   * failing check produced a confident first-sync estimate and — after BACKLOG-2898 —
   * a telemetry mark asserting `reusedPreviousBackup: false`. The epic calls a
   * `checkBackupStatus` that cannot find a backup which demonstrably exists "a far
   * larger bug than a bad estimate"; this is the value that has to be able to say so.
   *
   * Not hypothetical: the walk behind `size` measures 7.2 s warm over 496k blobs and
   * runs twice per sync, so a throw is a realistic event.
   *
   * `exists` and the deprecated `isCorrupted` alias are gone. `exists: true` was
   * failure-proof but redundant once `state: "present"` carries it, and
   * `isCorrupted`'s own doc gave its removal condition as "once PR #2409 and
   * BACKLOG-2910 have landed" — both are merged into this branch's base.
   *
   * @param udid Device UDID
   * @returns Which of the three states was established, never a collapsed `null`
   */
  async checkBackupStatus(udid: string): Promise<BackupStatusReport> {
    // BACKLOG-1123: Validate UDID before using in path operations
    const validatedUdid = validateDeviceUdid(udid);
    const backupPath = this.getDefaultBackupPath();
    const deviceBackupPath = path.join(backupPath, validatedUdid);

    try {
      // Atomic: stat directly, handle ENOENT instead of check-then-act (TOCTOU)
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await fs.stat(deviceBackupPath);
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
          // The ONE state that proves there is no backup. Everything else that can
          // go wrong here lands in the catch below as `unknown`.
          return { state: "absent" };
        }
        throw err;
      }

      const size = await this.measureBackupSize(deviceBackupPath);

      // Check for key files atomically by attempting to access them directly
      const manifestPath = path.join(deviceBackupPath, "Manifest.db");
      const infoPlistPath = path.join(deviceBackupPath, "Info.plist");
      const statusPlistPath = path.join(deviceBackupPath, "Status.plist");

      // Use fs.stat directly instead of fs.access to avoid TOCTOU race condition
      const fileExists = async (p: string): Promise<boolean> => {
        try { await fs.stat(p); return true; } catch { return false; }
      };

      const [hasManifest, hasInfoPlist] = await Promise.all([
        fileExists(manifestPath),
        fileExists(infoPlistPath),
      ]);

      // A complete backup should have Manifest.db and Info.plist
      const isComplete = hasManifest && hasInfoPlist;

      // BACKLOG-2911: did the device report this snapshot as finished?
      const snapshotState = await this.readSnapshotState(statusPlistPath);
      const isInterrupted = snapshotState === "unfinished";

      log.info(`[BackupService] Backup status for ${udid}:`, {
        state: "present",
        isComplete,
        isInterrupted,
        snapshotState,
        hasManifest,
        hasInfoPlist,
        // BACKLOG-2917: log what was established, not a number stood in for it.
        sizeBytes: size.measured ? size.bytes : "unmeasured",
        sizeUnmeasuredReason: size.measured ? undefined : size.reason,
      });

      return {
        state: "present",
        isComplete,
        isInterrupted,
        // BACKLOG-2926: the value was computed and logged here, then dropped on the
        // floor. Only the wire was missing.
        snapshotState,
        lastModified: stats.mtime,
        size,
      };
    } catch (error) {
      // BACKLOG-2917: the check FAILED. Saying "no backup" here is the defect —
      // it converts an unknown into a confident wrong answer, and the caller then
      // reports a first sync that nobody established.
      const reason = describeError(error);
      log.error("[BackupService] Backup status check failed; state is UNKNOWN, not absent:", error);
      // A backup that demonstrably exists failing its check is the alarming case the
      // epic names. A timeline mark is only seen when someone pulls the timeline, so
      // this one is raised without being asked for.
      Sentry.captureException(error, {
        tags: { service: "backup", operation: "checkBackupStatus" },
        extra: { reason },
      });
      return { state: "unknown", reason };
    }
  }

  /**
   * BACKLOG-2911: read the device's own verdict on the last backup from `Status.plist`.
   *
   * `Status.plist` is written by BackupAgent2 on the device and uploaded to the host.
   * The values it actually carries are `SnapshotState: "uploading" | "finished"` and
   * `BackupState: "empty" | "new"`.
   *
   * The predicate this replaced looked for the substring `"InProgress"`, which iOS
   * never writes, so it could not return true for any readable `Status.plist`. Verified
   * against a real torn backup (`SnapshotState: "uploading"`, 41,097 orphaned blobs,
   * no `Manifest.db`) — see `backupService.interruptedDetection-2911.test.ts` for the
   * bytes and their provenance. The old code also read a binary plist as UTF-8, which
   * mangles every non-ASCII byte.
   *
   * This matches the ONE known-good value rather than enumerating in-progress ones, so
   * any state not seen before — an older iOS variant, a truncated write, a format
   * change — counts as unfinished rather than silently passing as complete.
   *
   * `"absent"` is reported separately from `"unfinished"` because a missing
   * `Status.plist` carries no evidence either way: it is also the state before a
   * device has ever completed a backup into this directory.
   *
   * Note this is only a *report*. It never deletes the partial backup and never
   * changes the backup invocation — `idevicebackup2` does not read `Status.plist` on
   * the backup path at all (`mb2_status_check_snapshot_state` is called only from
   * `CMD_RESTORE`), and the only option the protocol accepts on a backup request is
   * `ForceFullBackup`. Continuation across a failed run is device-driven.
   */
  private async readSnapshotState(
    statusPlistPath: string,
  ): Promise<"finished" | "unfinished" | "absent"> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(statusPlistPath);
    } catch (readErr: unknown) {
      if (readErr && typeof readErr === "object" && "code" in readErr && (readErr as { code: string }).code === "ENOENT") {
        return "absent";
      }
      // Present but unreadable: we cannot prove the snapshot finished, so it did not.
      //
      // BACKLOG-2926 (§6.4): failing CLOSED is correct — this refuses under uncertainty
      // rather than substituting a different answer, which is the opposite of the
      // BACKLOG-2917 defect. But an infrastructure break would present to EVERY user as
      // "Previous sync didn't finish" with only a `log.warn` to show for it. The
      // breadcrumb makes "the file could not be read" separable from "the device said
      // the snapshot was not finished" without changing the safe behaviour.
      log.warn("[BackupService] Status.plist unreadable, treating snapshot as unfinished:", readErr);
      Sentry.addBreadcrumb({
        category: "backup.snapshot",
        message: "Status.plist unreadable; failing closed to unfinished",
        level: "warning",
        data: { reason: describeError(readErr) },
      });
      return "unfinished";
    }

    try {
      // Required lazily rather than imported at the top of the file: `Status.plist` may
      // be binary or XML, and `simple-plist` handles both, but keeping the require here
      // keeps this change clear of the import block that PR #2409 and BACKLOG-2910 both
      // edit. Same pattern as electron/utils/messageParser.ts.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const simplePlist = require("simple-plist") as { parse: (data: Buffer) => unknown };
      const parsed = simplePlist.parse(raw);
      const snapshotState =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)["SnapshotState"]
          : undefined;

      // The only value that means "the device finished this snapshot".
      const SNAPSHOT_STATE_FINISHED = "finished";
      return snapshotState === SNAPSHOT_STATE_FINISHED ? "finished" : "unfinished";
    } catch (parseErr: unknown) {
      // BACKLOG-2926 (§6.4): as above. This catch cannot separate "the plist says
      // something else" from "the parser broke", and a broken parser would report every
      // user's healthy backup as torn. Failing closed stays; the breadcrumb is what
      // makes a systemic break visible as one.
      log.warn("[BackupService] Status.plist unparseable, treating snapshot as unfinished:", parseErr);
      Sentry.addBreadcrumb({
        category: "backup.snapshot",
        message: "Status.plist unparseable; failing closed to unfinished",
        level: "warning",
        data: { reason: describeError(parseErr) },
      });
      return "unfinished";
    }
  }

  /**
   * Get backup metadata for change detection (TASK-908)
   *
   * Returns the modification time and SHA-256 hash of Manifest.db,
   * which is the primary indicator of backup content changes.
   *
   * @param backupPath Full path to the backup directory
   * @returns Metadata object or null if backup/manifest doesn't exist
   */
  async getBackupMetadata(backupPath: string): Promise<{
    modifiedAt: Date;
    manifestHash: string;
  } | null> {
    try {
      const manifestPath = path.join(backupPath, "Manifest.db");

      // Read file and stats directly, handling ENOENT instead of pre-checking
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      let manifestContent: Buffer;
      try {
        stats = await fs.stat(manifestPath);
        manifestContent = await fs.readFile(manifestPath);
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
          log.debug("[BackupService] Manifest.db not found at:", manifestPath);
          return null;
        }
        throw err;
      }

      // Compute SHA-256 hash of manifest for reliable change detection
      const { createHash } = await import("crypto");
      const hash = createHash("sha256").update(manifestContent).digest("hex");

      log.debug("[BackupService] Backup metadata:", {
        backupPath,
        modifiedAt: stats.mtime.toISOString(),
        manifestHash: hash.substring(0, 16) + "...", // Log truncated for brevity
      });

      return {
        modifiedAt: stats.mtime,
        manifestHash: hash,
      };
    } catch (error) {
      log.error("[BackupService] Failed to get backup metadata:", error);
      return null;
    }
  }

  /**
   * List existing backups.
   * BACKLOG-1086: Use atomic readdir instead of check-then-read (TOCTOU fix).
   */
  async listBackups(): Promise<BackupInfo[]> {
    const backupPath = this.getDefaultBackupPath();
    const backups: BackupInfo[] = [];

    try {
      // Atomic: attempt readdir directly, handle ENOENT if path doesn't exist
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(backupPath, { withFileTypes: true });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
          return backups;
        }
        throw err;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const deviceBackupPath = path.join(backupPath, entry.name);
          const info = await this.getBackupInfo(deviceBackupPath, entry.name);
          if (info) {
            backups.push(info);
          }
        }
      }
    } catch (error) {
      log.error("[BackupService] Error listing backups:", error);
    }

    return backups;
  }

  /**
   * Get information about a specific backup
   */
  private async getBackupInfo(
    backupPath: string,
    udid: string,
  ): Promise<BackupInfo | null> {
    try {
      const stats = await fs.stat(backupPath);
      // BACKLOG-2917: the third caller of the size walk. A real backup whose walk
      // threw used to be listed to the user at size 0; `null` says "not measured"
      // and cannot be formatted as "0 B" without the caller deciding to.
      const sizeReading = await this.measureBackupSize(backupPath);
      const size = sizeReading.measured ? sizeReading.bytes : null;
      if (!sizeReading.measured) {
        log.warn(
          `[BackupService] Listing a backup whose size could not be measured (${sizeReading.reason})`,
        );
      }

      // Try to read Info.plist for device info
      let deviceName: string | null = null;
      let iosVersion: string | null = null;
      let isEncrypted = false;

      // Atomic: read directly, handle ENOENT instead of check-then-act (TOCTOU)
      const infoPlistPath = path.join(backupPath, "Info.plist");
      try {
        const content = await fs.readFile(infoPlistPath, "utf8");
        const deviceNameMatch = content.match(
          /<key>Device Name<\/key>\s*<string>([^<]+)<\/string>/,
        );
        const versionMatch = content.match(
          /<key>Product Version<\/key>\s*<string>([^<]+)<\/string>/,
        );
        const encryptedMatch = content.match(
          /<key>IsEncrypted<\/key>\s*<(true|false)/,
        );

        if (deviceNameMatch) deviceName = deviceNameMatch[1];
        if (versionMatch) iosVersion = versionMatch[1];
        if (encryptedMatch) isEncrypted = encryptedMatch[1] === "true";
      } catch (plistErr: unknown) {
        if (!(plistErr && typeof plistErr === "object" && "code" in plistErr && (plistErr as { code: string }).code === "ENOENT")) {
          log.warn("[BackupService] Error reading Info.plist:", plistErr);
        }
        // Info.plist not found or unreadable — continue with defaults
      }

      return {
        path: backupPath,
        deviceUdid: udid,
        createdAt: stats.mtime,
        size,
        isEncrypted,
        iosVersion,
        deviceName,
      };
    } catch (error) {
      log.error("[BackupService] Error getting backup info:", error);
      return null;
    }
  }

  /**
   * Delete a backup for a specific device
   */
  async deleteBackup(backupPath: string): Promise<void> {
    log.info("[BackupService] Deleting backup:", backupPath);

    // Validate path is within our backup directory for safety (before any FS ops)
    const defaultPath = this.getDefaultBackupPath();
    if (!backupPath.startsWith(defaultPath)) {
      throw new Error("Cannot delete backup outside of backup directory");
    }

    // Atomic: attempt delete directly, handle ENOENT instead of check-then-act (TOCTOU)
    try {
      await fs.rm(backupPath, { recursive: true, force: true });
      log.info("[BackupService] Backup deleted successfully");
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
        log.warn("[BackupService] Backup path does not exist:", backupPath);
        return;
      }
      throw err;
    }
  }

  /**
   * Clean up old backups, keeping only the most recent
   * @param keepCount Number of backups to keep per device (default: 1)
   */
  async cleanupOldBackups(keepCount: number = 1): Promise<void> {
    const backups = await this.listBackups();

    // Group by device UDID
    const byDevice = new Map<string, BackupInfo[]>();
    for (const backup of backups) {
      const existing = byDevice.get(backup.deviceUdid) || [];
      existing.push(backup);
      byDevice.set(backup.deviceUdid, existing);
    }

    // For each device, keep only the most recent backups
    for (const [udid, deviceBackups] of byDevice) {
      // Sort by date, newest first
      deviceBackups.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );

      // Delete older backups
      for (let i = keepCount; i < deviceBackups.length; i++) {
        log.info(
          `[BackupService] Cleaning up old backup for device ${udid}:`,
          deviceBackups[i].path,
        );
        await this.deleteBackup(deviceBackups[i].path);
      }
    }
  }

  /**
   * Clean up decrypted files after extraction (TASK-007)
   * @param backupPath Path to the backup
   */
  async cleanupDecryptedFiles(backupPath: string): Promise<void> {
    const decryptedPath = path.join(backupPath, "decrypted");
    await backupDecryptionService.cleanup(decryptedPath);
  }

  /**
   * Verify a backup password without performing full backup (TASK-007)
   */
  async verifyBackupPassword(
    backupPath: string,
    password: string,
  ): Promise<boolean> {
    return backupDecryptionService.verifyPassword(backupPath, password);
  }

  /**
   * Mock backup for development without actual device
   */
  private async mockBackup(options: BackupOptions): Promise<BackupResult> {
    log.info("[BackupService] Running mock backup");

    this.isRunning = true;
    this.currentDeviceUdid = options.udid;
    this.startTime = Date.now();

    // Simulate progress
    const phases: Array<{
      phase: BackupProgress["phase"];
      percent: number;
      delay: number;
    }> = [
      { phase: "preparing", percent: 0, delay: 500 },
      { phase: "transferring", percent: 10, delay: 500 },
      { phase: "transferring", percent: 30, delay: 500 },
      { phase: "transferring", percent: 50, delay: 500 },
      { phase: "transferring", percent: 70, delay: 500 },
      { phase: "transferring", percent: 90, delay: 500 },
      { phase: "finishing", percent: 100, delay: 500 },
    ];

    for (const step of phases) {
      await new Promise((resolve) => setTimeout(resolve, step.delay));
      this.lastProgress = {
        phase: step.phase,
        percentComplete: step.percent,
        currentFile: step.phase === "transferring" ? "mock_file.dat" : null,
        filesTransferred: Math.floor(step.percent * 10),
        totalFiles: 1000,
        bytesTransferred: step.percent * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024,
        batchBytesTransferred: step.percent * 1024 * 1024,
        batchTotalBytes: 100 * 1024 * 1024,
        deviceOverallPercent: step.percent,
        estimatedTimeRemaining: Math.max(0, (100 - step.percent) / 10),
      };
      this.emit("progress", this.lastProgress);
    }

    this.isRunning = false;
    this.currentDeviceUdid = null;

    const result: BackupResult = {
      success: true,
      backupPath: path.join(this.getDefaultBackupPath(), options.udid),
      error: null,
      duration: Date.now() - this.startTime,
      deviceUdid: options.udid,
      isIncremental: false,
      backupSize: 100 * 1024 * 1024, // 100 MB mock
    };

    this.emit("complete", result);
    return result;
  }
}

// Export singleton instance
export const backupService = new BackupService();
