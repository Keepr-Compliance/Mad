/**
 * Backup Service
 *
 * Handles iPhone backup operations using idevicebackup2 CLI tool.
 * Extracts messages and contacts from iPhone backups.
 * Supports encrypted backup decryption (TASK-007).
 *
 * IMPORTANT: Domain filtering is NOT supported by idevicebackup2.
 * See docs/BACKUP_RESEARCH.md for full research findings.
 * This service uses --skip-apps to reduce backup size by ~40%.
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
} from "../types/backup";
import { validateDeviceUdid, ValidationError } from "../utils/validation";

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
      supportsSkipApps: true,
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
   * Note: Due to iOS backup protocol limitations, this creates a full backup
   * (minus app data if skipApps is true). Domain-specific backups are not possible.
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

        // Original: log non-progress, non-debug lines for error detection
        // With -d flag, only log lines that match known error patterns
        // (the debug output is far too verbose to log in full)
        const outputLower = output.toLowerCase();
        const isErrorPattern =
          outputLower.includes("trust") ||
          outputLower.includes("pair") ||
          outputLower.includes("password") ||
          outputLower.includes("incorrect") ||
          outputLower.includes("locked") ||
          outputLower.includes("passcode") ||
          outputLower.includes("no device") ||
          outputLower.includes("not found") ||
          outputLower.includes("disk") ||
          outputLower.includes("space") ||
          outputLower.includes("storage");

        if (isErrorPattern) {
          log.warn("[BackupService] stderr (error pattern):", output.trim().substring(0, 500));
        } else {
          // BACKLOG-1628: Restore Sentry breadcrumbs for unrecognized non-debug patterns.
          // With -d flag, known debug prefixes (SSL_write, service_send, etc.) are very
          // frequent and should be silently skipped. But genuinely unrecognized lines
          // may indicate new error patterns we haven't categorized yet.
          const isDebugLine =
            output.includes("SSL_write") ||
            output.includes("service_send") ||
            output.includes("internal_plist") ||
            output.includes("idevice_connection") ||
            output.includes("Sending '") ||
            output.includes("Negotiated Protocol") ||
            output.includes("backup mode") ||
            output.includes("Starting backup") ||
            output.includes("Requesting backup") ||
            output.includes("Status.plist") ||
            output.includes("Manifest.plist") ||
            output.includes("Manifest.db");

          if (!isDebugLine && output.trim().length > 0) {
            Sentry.addBreadcrumb({
              category: "backup",
              message: output.trim().substring(0, 200),
              level: "info",
            });
          }
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
        let backupSize = 0;
        let finalBackupPath = deviceBackupPath;

        if (success) {
          backupSize = await this.calculateBackupSize(deviceBackupPath);
          log.info(
            `[BackupService] Backup completed successfully in ${duration}ms, size: ${backupSize} bytes`,
          );

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
              bytesTransferred: backupSize,
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
        if (!success) {
          if (diskFullDetected) {
            // BACKLOG-2899: phrased so deviceSyncOrchestrator's existing
            // /disk space|no space|ENOSPC|not enough space/i matcher recognises it.
            errorMessage =
              "Not enough disk space to complete the backup. Please free up space and try again.";
            errorCode = "INSUFFICIENT_SPACE";
          } else {
            errorMessage = this.getErrorMessage(code, stderrBuffer);
          }
        }

        const result: BackupResult = {
          success,
          backupPath: success ? finalBackupPath : null,
          error: errorMessage,
          ...(errorCode ? { errorCode } : {}),
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
          bytesTransferred: backupSize,
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
   * Note: We use --skip-apps to reduce backup size since we only need
   * messages and contacts which are in HomeDomain.
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

    // Skip apps to reduce backup size (recommended for our use case)
    // This removes AppDomain which can be 10-30 GB
    if (options.skipApps !== false) {
      args.push("--skip-apps");
    }

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
   * Convert exit code to user-friendly error message
   */
  private getErrorMessage(code: number | null, stderr: string): string {
    // Convert unsigned 32-bit to signed (Windows wraps negative codes)
    const signedCode = code !== null && code > 2147483647 ? code - 4294967296 : code;

    // Check stderr for specific error messages first
    const stderrLower = stderr.toLowerCase();

    if (stderrLower.includes("password") || stderrLower.includes("incorrect")) {
      return "Incorrect backup password. Please try again with the correct password.";
    }

    if (stderrLower.includes("locked") || stderrLower.includes("passcode")) {
      return "iPhone is locked. Please unlock your iPhone and try again.";
    }

    if (stderrLower.includes("trust") || stderrLower.includes("pair")) {
      return "iPhone trust not established. Please disconnect and reconnect your iPhone, then tap 'Trust' when prompted.";
    }

    if (stderrLower.includes("no device") || stderrLower.includes("not found")) {
      return "iPhone disconnected. Please reconnect your iPhone and try again.";
    }

    if (stderrLower.includes("disk") || stderrLower.includes("space") || stderrLower.includes("storage")) {
      return "Not enough disk space to complete the backup. Please free up space and try again.";
    }

    // Check by exit code
    switch (signedCode) {
      case -208:
      case -207:
        // Connection lost / device disconnected
        return "Connection to iPhone was lost. Please make sure your iPhone stays connected and unlocked during the sync.";

      case -1:
        return "Backup was cancelled.";

      case 1:
        return "Backup failed. Please make sure your iPhone is unlocked and connected.";

      case 2:
        return "Invalid backup configuration. Please try again.";

      default:
        // Generic error with code
        if (stderr.trim()) {
          return `Backup failed: ${stderr.trim().substring(0, 200)}`;
        }
        return `Backup failed with error code ${code}. Please try again.`;
    }
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
   * Calculate the total size of a backup directory.
   * BACKLOG-1086: Use atomic readdir instead of check-then-read (TOCTOU fix).
   */
  private async calculateBackupSize(backupPath: string): Promise<number> {
    try {
      let totalSize = 0;
      // Atomic: attempt readdir directly, handle ENOENT if path disappeared
      let files: import("fs").Dirent[];
      try {
        files = await fs.readdir(backupPath, { withFileTypes: true });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
          return 0;
        }
        throw err;
      }

      for (const file of files) {
        const filePath = path.join(backupPath, file.name);
        if (file.isDirectory()) {
          totalSize += await this.calculateBackupSize(filePath);
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

      return totalSize;
    } catch (error) {
      log.error("[BackupService] Error calculating backup size:", error);
      return 0;
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
   * Check if a backup for a device exists and its status
   * @param udid Device UDID
   * @returns Backup status info or null if no backup exists
   */
  async checkBackupStatus(udid: string): Promise<{
    exists: boolean;
    isComplete: boolean;
    isCorrupted: boolean;
    lastModified: Date | null;
    sizeBytes: number;
  } | null> {
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
          return null;
        }
        throw err;
      }

      const size = await this.calculateBackupSize(deviceBackupPath);

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

      // Check for corruption indicators: read directly, handle ENOENT
      let isCorrupted = false;
      try {
        const statusContent = await fs.readFile(statusPlistPath, "utf8");
        // If Status.plist indicates backup was in progress, it was interrupted
        if (statusContent.includes("BackupState") && statusContent.includes("InProgress")) {
          isCorrupted = true;
        }
      } catch (statusErr: unknown) {
        if (statusErr && typeof statusErr === "object" && "code" in statusErr && (statusErr as { code: string }).code === "ENOENT") {
          // Status.plist doesn't exist — not corrupted by this metric
        } else {
          // Can't read status, assume potentially corrupted
          isCorrupted = !isComplete;
        }
      }

      log.info(`[BackupService] Backup status for ${udid}:`, {
        exists: true,
        isComplete,
        isCorrupted,
        hasManifest,
        hasInfoPlist,
        sizeBytes: size,
      });

      return {
        exists: true,
        isComplete,
        isCorrupted,
        lastModified: stats.mtime,
        sizeBytes: size,
      };
    } catch (error) {
      log.error("[BackupService] Error checking backup status:", error);
      return null;
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
      const size = await this.calculateBackupSize(backupPath);

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
