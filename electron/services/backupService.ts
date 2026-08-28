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
 * BACKLOG-2913: the USB link dropped. Exit 255 with
 * `usbmuxd_send returned -32 (Broken pipe)`.
 */
export const BACKUP_CONNECTION_LOST_MESSAGE =
  "The connection to your iPhone dropped during the backup. Try a different cable, " +
  "plug the iPhone straight into this Mac without a hub or dock, then sync again. " +
  "If it keeps dropping, restart your iPhone.";

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
 * stdout first (always emitted, survives truncation), then the stderr plist. The
 * LAST occurrence wins in both: a run can log several DLMessage responses, and the
 * one that ended it is the last.
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
 * What it never does is match keywords against the raw `-d` debug stream. That
 * stream contains `afc_lock(): Locked` and `np_lock(): Locked` hundreds of times per
 * run, plus `PasswordProtected`, `TrustedHostAttached` and `PairRecordProtectionClass`
 * as ordinary plist keys — so the old ladder's `locked` rung matched on every single
 * failure and the `disk`, `trust` and `password` rungs below it were unreachable.
 */
export function classifyBackupFailure(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): BackupFailureClassification {
  const parsed = parseDeviceBackupError(stdout, stderr);
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
    return {
      message: BACKUP_CONNECTION_LOST_MESSAGE,
      errorCode: "CONNECTION_LOST",
      cause,
    };
  }

  // Last resort, and the ONLY surviving substring match: idevicebackup2's own
  // human-readable stdout (BACKLOG-2899's detector), never the debug stream.
  if (isIdevicebackup2DiskFullOutput(stdout)) {
    return {
      message: BACKUP_HOST_DISK_FULL_MESSAGE,
      errorCode: "INSUFFICIENT_SPACE",
      cause,
    };
  }

  if (exitCode === -1) {
    return {
      message: "Backup was cancelled.",
      errorCode: "BACKUP_CANCELLED",
      cause,
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
 * - 'waiting-for-passcode': void - When waiting for user to enter passcode on iPhone
 * - 'passcode-entered': void - When passcode was entered and transfer begins
 */
export class BackupService extends EventEmitter {
  private currentProcess: ChildProcess | null = null;
  private isRunning: boolean = false;
  private currentDeviceUdid: string | null = null;
  private startTime: number = 0;
  private lastProgress: BackupProgress | null = null;

  // Progress tracking for accurate overall progress
  private filesCompleted: number = 0;
  private totalFilesEstimate: number = 0;
  private bytesTransferred: number = 0;
  private currentFileProgress: number = 0;
  private lastFileSize: number = 0;

  // Passcode waiting detection
  private passcodeWaitingTimer: NodeJS.Timeout | null = null;
  private hasReceivedFileProgress: boolean = false;
  private hasEmittedPasscodeWaiting: boolean = false;
  private backupCommandStartTime: number = 0;
  private static readonly PASSCODE_WAIT_DETECTION_MS = 5000; // 5 seconds without progress = waiting for passcode

  // BACKLOG-1582: Watchdog timer to detect zombie idevicebackup2 processes
  // BACKLOG-1628: Track both stdout and stderr activity for watchdog
  private lastStdoutTimestamp: number = 0;
  private lastStderrTimestamp: number = 0;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private watchdogFired: boolean = false;
  private static readonly WATCHDOG_CHECK_INTERVAL_MS = 30_000; // Check every 30s
  private static readonly WATCHDOG_PREPARING_TIMEOUT_MS = 180_000; // 3 min during preparation
  private static readonly WATCHDOG_TRANSFER_TIMEOUT_MS = 120_000; // 2 min during active transfer

  // BACKLOG-1628: Stderr debug parsing state
  private stderrLineBuffer: string = "";

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

  /** libimobiledevice's -d trace format: `16:06:22 D:\...\idevice.c:652 func(): msg`. */
  private static readonly LIBIMOBILEDEVICE_TRACE_FORMAT =
    /^\d{2}:\d{2}:\d{2}\s+\S+[\\/][^\s]+:\d+\s+\w+\(\):/;

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
    if (this.isRunning) {
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

      // Reset progress tracking
      this.filesCompleted = 0;
      this.totalFilesEstimate = 0;
      this.bytesTransferred = 0;
      this.currentFileProgress = 0;
      this.lastFileSize = 0;

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
        estimatedTimeRemaining: null,
      };
      this.emit("progress", this.lastProgress);

      // BACKLOG-1582: Reset watchdog state
      // BACKLOG-1628: Reset both stdout and stderr timestamps
      this.watchdogFired = false;
      this.lastStdoutTimestamp = Date.now();
      this.lastStderrTimestamp = Date.now();
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

      // Start timer to detect if we're waiting for passcode
      // If no file transfer progress after 5 seconds, assume waiting for user passcode
      this.passcodeWaitingTimer = setTimeout(() => {
        if (!this.hasReceivedFileProgress && !this.hasEmittedPasscodeWaiting) {
          this.hasEmittedPasscodeWaiting = true;
          const waitTime = ((Date.now() - this.backupCommandStartTime) / 1000).toFixed(1);
          log.info(`[BackupService] No file progress after ${waitTime}s - waiting for user passcode`);
          this.emit("waiting-for-passcode");
          // BACKLOG-1582: Start watchdog with preparing timeout (longer, user may take time)
          this.startWatchdog(BackupService.WATCHDOG_PREPARING_TIMEOUT_MS);
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

        // BACKLOG-1582: Track last stdout activity for watchdog
        this.lastStdoutTimestamp = Date.now();

        // Only log non-progress-bar output (progress bars are very spammy)
        // Progress bars look like: [====] XX% (X.X MB/Y.Y MB)
        const isProgressBar = /\[=*\s*\]\s*\d+%/.test(output);
        if (!isProgressBar && output.trim()) {
          log.info("[BackupService] stdout:", output.trim());
        }

        const progress = this.parseProgress(output);
        if (progress) {
          // Detect when file transfer starts (passcode was entered)
          if (progress.phase === "transferring" && !this.hasReceivedFileProgress) {
            this.hasReceivedFileProgress = true;
            // Clear the waiting timer
            if (this.passcodeWaitingTimer) {
              clearTimeout(this.passcodeWaitingTimer);
              this.passcodeWaitingTimer = null;
            }
            // If we previously emitted waiting-for-passcode, now emit passcode-entered
            if (this.hasEmittedPasscodeWaiting) {
              const waitTime = ((Date.now() - this.backupCommandStartTime) / 1000).toFixed(1);
              log.info(`[BackupService] File transfer started after ${waitTime}s - passcode entered`);
              this.emit("passcode-entered");
            }
            // BACKLOG-1582: Start watchdog with transfer timeout now that data is flowing
            this.startWatchdog(BackupService.WATCHDOG_TRANSFER_TIMEOUT_MS);
          }
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

        // BACKLOG-1628: Track stderr activity for watchdog
        this.lastStderrTimestamp = Date.now();

        // BACKLOG-1628: Parse stderr line-by-line for debug signals
        // The -d flag produces very verbose output (30K+ lines in 20s).
        // We buffer and parse line-by-line, only acting on specific patterns.
        this.stderrLineBuffer += output;
        const lines = this.stderrLineBuffer.split(/\r?\n/);
        // Keep the last incomplete line in the buffer
        this.stderrLineBuffer = lines.pop() || "";

        for (const line of lines) {
          this.parseStderrLine(line, options.udid);
        }

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
          this.classifyStderrLine(line);
        }
      });

      this.currentProcess.on("error", (error: Error) => {
        log.error("[BackupService] Process error:", error);
        this.emit("error", error);
      });

      this.currentProcess.on("close", async (code: number | null) => {
        const duration = Date.now() - this.startTime;
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
            isIncremental: previousBackupExists,
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
              isIncremental: previousBackupExists && !options.forceFullBackup,
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
                isIncremental: previousBackupExists && !options.forceFullBackup,
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
              isIncremental: previousBackupExists && !options.forceFullBackup,
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
            const classification = this.classifyFailure(
              code,
              stdoutBuffer,
              stderrBuffer,
            );
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
          isIncremental: previousBackupExists && !options.forceFullBackup,
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
          estimatedTimeRemaining: 0,
        };
        this.emit("progress", this.lastProgress);
        this.emit("complete", result);

        resolve(result);
      });
    });
  }

  /**
   * Cancel an in-progress backup
   */
  cancelBackup(): void {
    log.info("[BackupService] Cancelling backup");

    // BACKLOG-1582: Clear watchdog on cancel
    this.clearWatchdog();

    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");

      // Give it a moment, then force kill if needed
      setTimeout(() => {
        if (this.currentProcess) {
          this.currentProcess.kill("SIGKILL");
        }
      }, 5000);
    }

    // Always reset state — even if process is null (race between spawn and cancel)
    this.isRunning = false;
  }

  /**
   * BACKLOG-1582: Start the watchdog timer that detects zombie idevicebackup2 processes.
   * If no stdout activity is received within the timeout, kills the process.
   */
  private startWatchdog(timeoutMs: number): void {
    this.clearWatchdog();
    log.info(`[BackupService] Watchdog started (timeout: ${timeoutMs / 1000}s)`);

    this.watchdogInterval = setInterval(() => {
      if (!this.currentProcess || !this.isRunning) {
        this.clearWatchdog();
        return;
      }

      // BACKLOG-1628: Watchdog fires only when BOTH stdout AND stderr are silent.
      // During manifest upload, stdout is silent but stderr shows SSL_write activity.
      const lastActivityTimestamp = Math.max(this.lastStdoutTimestamp, this.lastStderrTimestamp);
      const elapsed = Date.now() - lastActivityTimestamp;
      if (elapsed >= timeoutMs) {
        log.error(`[BackupService] Watchdog: no stdout/stderr for ${Math.round(elapsed / 1000)}s — killing zombie process`);
        this.killZombieProcess();
      }
    }, BackupService.WATCHDOG_CHECK_INTERVAL_MS);
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

    // On macOS, give it 5s then SIGKILL. On Windows, SIGTERM already hard-kills.
    if (process.platform !== "win32") {
      setTimeout(() => {
        try {
          if (this.currentProcess && !this.currentProcess.killed) {
            this.currentProcess.kill("SIGKILL");
          }
        } catch { /* process already dead */ }
      }, 5000);
    }

    // Safety net: if close event never fires after kill, force-reset state
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
    }, 10_000);
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
    if (this.isKnownDebugLine(trimmed)) return;

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
   * Known-benign debug output from the `-d` flag. The first test is
   * libimobiledevice's own trace FORMAT (`HH:MM:SS <src path>:<line>
   * <function>(): ...`), which by construction only exists because we pass -d.
   */
  private isKnownDebugLine(line: string): boolean {
    if (BackupService.LIBIMOBILEDEVICE_TRACE_FORMAT.test(line)) return true;
    return (
      line.includes("SSL_write") ||
      line.includes("service_send") ||
      line.includes("internal_plist") ||
      line.includes("idevice_connection") ||
      line.includes("Sending '") ||
      line.includes("Negotiated Protocol") ||
      line.includes("backup mode") ||
      line.includes("Starting backup") ||
      line.includes("Requesting backup") ||
      line.includes("Status.plist") ||
      line.includes("Manifest.plist") ||
      line.includes("Manifest.db")
    );
  }

  /**
   * BACKLOG-1628: Parse a single stderr line from debug output for progress signals.
   *
   * With the -d flag, idevicebackup2 emits detailed debug output on stderr.
   * We parse for specific patterns to:
   * 1. Detect manifest upload phase and surface progress to UI
   * 2. Reset watchdog on SSL_write/service_send activity
   * 3. Log significant phase transitions (protocol version, backup mode)
   *
   * This method is designed to be lightweight — it's called for every stderr line
   * (potentially 30K+ lines in 20 seconds during manifest upload).
   */
  private parseStderrLine(line: string, _udid: string): void {
    // Fast path: skip empty lines
    if (!line || line.length < 5) return;

    // Pattern 1: Manifest.db upload — "Sending '<udid>/Manifest.db' (563.0 MB)"
    // This signals the start of the long preparing phase where stdout is silent.
    const manifestMatch = line.match(/Sending\s+'[^']*\/Manifest\.db'\s+\(([^)]+)\)/);
    if (manifestMatch) {
      this.manifestUploadPhase = true;
      this.manifestUploadSize = manifestMatch[1]; // e.g., "563.0 MB"
      log.info(`[BackupService] Manifest upload started (${this.manifestUploadSize})`);

      this.lastProgress = {
        phase: "preparing",
        percentComplete: 0,
        currentFile: null,
        filesTransferred: 0,
        totalFiles: null,
        bytesTransferred: 0,
        totalBytes: null,
        estimatedTimeRemaining: null,
        message: `Preparing incremental backup \u2014 uploading backup index (${this.manifestUploadSize})...`,
      };
      this.emit("progress", this.lastProgress);
      return;
    }

    // Pattern 2: SSL_write or service_send — activity signals (hot path)
    // These repeat thousands of times; do NOT log. Just confirm the process is alive.
    // The lastStderrTimestamp is already updated by the data handler.
    if (line.includes("SSL_write") || line.includes("service_send")) {
      // Already tracked via lastStderrTimestamp in the data handler.
      return;
    }

    // Pattern 3: Status.plist upload — initial negotiation
    if (line.includes("Sending") && line.includes("Status.plist")) {
      log.info("[BackupService] Sending Status.plist (initial negotiation)");
      return;
    }

    // Pattern 4: Manifest.plist upload
    if (line.includes("Sending") && line.includes("Manifest.plist")) {
      log.info("[BackupService] Sending Manifest.plist");
      return;
    }

    // Pattern 5: Negotiated Protocol Version
    if (line.includes("Negotiated Protocol Version")) {
      log.info("[BackupService] " + line.trim());
      return;
    }

    // Pattern 6: "Requesting backup from device..."
    if (line.includes("Requesting backup from device")) {
      log.info("[BackupService] Requesting backup from device");
      // The manifest upload phase is ending, device is processing
      if (this.manifestUploadPhase) {
        this.manifestUploadPhase = false;
        this.lastProgress = {
          phase: "preparing",
          percentComplete: 0,
          currentFile: null,
          filesTransferred: 0,
          totalFiles: null,
          bytesTransferred: 0,
          totalBytes: null,
          estimatedTimeRemaining: null,
          message: "Waiting for iPhone to process backup index...",
        };
        this.emit("progress", this.lastProgress);
      }
      return;
    }

    // Pattern 7: "Starting backup..."
    if (line.includes("Starting backup")) {
      log.info("[BackupService] Starting backup...");
      return;
    }

    // Pattern 8: Backup mode — "Incremental backup mode" or "Full backup mode"
    if (line.includes("backup mode")) {
      log.info("[BackupService] " + line.trim());
      return;
    }
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

    // BACKLOG-1628: Enable debug output on stderr for watchdog and progress signals.
    // The -d flag must come before other arguments.
    args.push("-d");

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

  /**
   * Parse idevicebackup2 output for progress information
   *
   * Example output patterns:
   * - "[====================                              ]  39% (18.8 MB/48.3 MB)"
   * - "Receiving files"
   * - "Received 100 files"
   *
   * Note: The percentage shown is per-file, not overall. Each file goes 0-100%.
   * We track cumulative bytes transferred to show accurate overall progress.
   */
  private parseProgress(output: string): BackupProgress | null {
    // Parse progress bar format: "[====...] XX% (X.X MB/Y.Y MB)"
    // This gives us per-file progress with current/total bytes for that file
    const progressMatch = output.match(
      /\[[\s=]+\]\s*(\d+)%\s*\((\d+(?:\.\d+)?)\s*(MB|KB|GB)\/(\d+(?:\.\d+)?)\s*(MB|KB|GB)\)/
    );

    if (progressMatch) {
      const filePercent = parseInt(progressMatch[1], 10);
      const currentBytes = this.parseBytes(
        parseFloat(progressMatch[2]),
        progressMatch[3]
      );
      const totalFileBytes = this.parseBytes(
        parseFloat(progressMatch[4]),
        progressMatch[5]
      );

      // Track when a file completes (goes from high % to low %)
      if (filePercent < this.currentFileProgress - 50 && this.currentFileProgress > 90) {
        // Previous file completed, add its size to our total
        this.bytesTransferred += this.lastFileSize;
        this.filesCompleted++;
        log.debug(
          `[BackupService] File completed. Total transferred: ${this.bytesTransferred}, Files: ${this.filesCompleted}`
        );
      }

      this.currentFileProgress = filePercent;
      this.lastFileSize = totalFileBytes;

      // Calculate overall progress based on cumulative bytes
      // We add the current file's progress to previously completed files
      const totalTransferred = this.bytesTransferred + currentBytes;

      // Estimate total based on time elapsed and transfer rate
      // For display, we show the current file's context
      const overallPercent = this.calculateOverallPercent(totalTransferred);

      return {
        phase: "transferring",
        percentComplete: overallPercent,
        currentFile: null,
        filesTransferred: this.filesCompleted,
        totalFiles: null,
        bytesTransferred: totalTransferred,
        totalBytes: null, // We don't know total until complete
        estimatedTimeRemaining: this.estimateTimeRemaining(overallPercent),
      };
    }

    // Check for file count pattern (end of backup)
    const filesMatch = output.match(/Received (\d+) files/);
    if (filesMatch) {
      const filesTransferred = parseInt(filesMatch[1], 10);
      this.totalFilesEstimate = filesTransferred;
      return {
        phase: "finishing",
        percentComplete: 95,
        currentFile: null,
        filesTransferred,
        totalFiles: filesTransferred,
        bytesTransferred: this.bytesTransferred,
        totalBytes: this.bytesTransferred,
        estimatedTimeRemaining: 30,
      };
    }

    // Check for phase indicators - early initialization phases
    if (output.includes("Requesting backup") || output.includes("Starting backup")) {
      return {
        phase: "preparing",
        percentComplete: 0,
        currentFile: null,
        filesTransferred: 0,
        totalFiles: null,
        bytesTransferred: 0,
        totalBytes: null,
        estimatedTimeRemaining: null,
      };
    }

    // Waiting for device to respond (can take a few minutes after trust/passcode)
    if (output.includes("Waiting") || output.includes("Starting data")) {
      return {
        phase: "preparing",
        percentComplete: 0,
        currentFile: null,
        filesTransferred: 0,
        totalFiles: null,
        bytesTransferred: 0,
        totalBytes: null,
        estimatedTimeRemaining: null,
      };
    }

    if (output.includes("Receiving files")) {
      return {
        phase: "transferring",
        percentComplete: 1,
        currentFile: null,
        filesTransferred: 0,
        totalFiles: null,
        bytesTransferred: 0,
        totalBytes: null,
        estimatedTimeRemaining: null,
      };
    }

    if (output.includes("Finishing") || output.includes("Backup Successful")) {
      return {
        phase: "finishing",
        percentComplete: 98,
        currentFile: null,
        filesTransferred: this.filesCompleted,
        totalFiles: this.filesCompleted,
        bytesTransferred: this.bytesTransferred,
        totalBytes: this.bytesTransferred,
        estimatedTimeRemaining: 10,
      };
    }

    return null;
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
    const classification = classifyBackupFailure(code, stdout, stderr);
    log.error("[BackupService] Failure classified", {
      deviceErrorCode: classification.cause.deviceErrorCode,
      deviceErrorDescription: classification.cause.deviceErrorDescription,
      exitCode: classification.cause.exitCode,
      source: classification.cause.source,
      errorCode: classification.errorCode,
    });
    return classification;
  }

  /**
   * Parse bytes from value and unit
   */
  private parseBytes(value: number, unit: string): number {
    switch (unit.toUpperCase()) {
      case "KB":
        return value * 1024;
      case "MB":
        return value * 1024 * 1024;
      case "GB":
        return value * 1024 * 1024 * 1024;
      default:
        return value;
    }
  }

  /**
   * Calculate overall progress percentage
   * Uses time-based estimation since we don't know total size upfront
   */
  private calculateOverallPercent(bytesTransferred: number): number {
    // For first sync, we use a time-based approach
    // Typical first sync: 30-60 minutes for ~5-20GB
    // Subsequent syncs: 1-5 minutes

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
      // Assume we're roughly 1/3 through at 10 min mark
      estimatedTotalMinutes = Math.max(elapsedMinutes * 3, 15);
    } else {
      // Long backup - use logarithmic scaling to avoid stalling at high %
      estimatedTotalMinutes = elapsedMinutes * 1.5;
    }

    // Calculate percentage, capped at 94% until we get completion signal
    const percent = Math.min((elapsedMinutes / estimatedTotalMinutes) * 100, 94);

    // Blend with file completion estimate if we have it
    if (this.filesCompleted > 10) {
      // Once we have enough files, use a weighted average
      // This helps smooth out the progress
      const fileBasedPercent = Math.min(
        (this.bytesTransferred / (this.bytesTransferred + this.lastFileSize * 5)) * 100,
        94
      );
      return Math.max(percent, fileBasedPercent);
    }

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
