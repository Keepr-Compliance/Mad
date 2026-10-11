/**
 * BACKLOG-3814 fixture: the held-start failure, TRANSCRIBED from the Windows PC's
 * diagnostic log of the failed 2.40.0-rc.1 run (relayed by the coordinator on
 * 2026-10-10; full lines in pm_comments on BACKLOG-3814):
 *
 *   20:19:47.167 [BackupService] Starting backup with args: [      <- before spawn()
 *   20:20:03.768 Watchdog started (no-progress timeout: 1800s)     <- after spawn() returned
 *   20:20:04     lockdown StartService com.apple.mobilebackup2 OK, TLS handshake OK
 *   20:20:08     the three stderr lines below
 *   20:20:08.897 Backup failed with code 4294967295 -> SERVICE_UNAVAILABLE
 *
 * The three lines are as relayed; the log's own timestamp prefixes were not relayed
 * and are not invented here. SPAWN_BLOCK_MS is 20:19:47.167 -> 20:20:03.768.
 *
 * `heldStartFailure()` is what `BackupService.startBackup` returns for that run:
 * backupService.toolStartHold-3814.test.ts feeds these exact lines and this spawn block
 * through the REAL service and asserts its result matches this builder, so the
 * orchestrator suites that use the builder stand on producer output.
 */
import { classifyBackupFailure } from "../../backupService";
import type { BackupResult } from "../../../types/backup";

export const SPAWN_BLOCK_MS = 16_601;

/** idevicebackup2 exit code as Windows reported it: unsigned -1. */
export const HELD_EXIT_CODE = 4294967295;

export const HELD_RUN_STDERR = [
  "device_link_service_version_exchange(): Did not receive initial message from device!",
  "mobilebackup2.c:89 mobilebackup2_client_new(): version exchange failed, error -5",
  "internal_plist_send(): ERROR: sending to device failed.",
].join("\n") + "\n";

export function heldStartFailure(
  udid: string,
  toolStart: { delayMs: number; delayed: boolean; firstRunThisVersion: boolean } = {
    delayMs: SPAWN_BLOCK_MS,
    delayed: true,
    firstRunThisVersion: false,
  },
): BackupResult {
  const c = classifyBackupFailure(HELD_EXIT_CODE, "", HELD_RUN_STDERR);
  return {
    success: false,
    backupPath: null,
    error: c.message,
    errorCode: c.errorCode,
    failureCause: c.cause,
    toolStart,
    duration: 21_730,
    deviceUdid: udid,
    isIncremental: true,
    deviceReportedBackupMode: null,
    backupSize: null,
    isEncrypted: false,
  };
}
