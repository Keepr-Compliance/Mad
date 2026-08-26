/**
 * Disk Space Diagnostic Utility (TASK-2270)
 *
 * Checks available disk space before critical operations and reports
 * low-space conditions to Sentry with rich context. Returns structured
 * results so callers can build user-facing messages.
 *
 * Usage:
 *   import { checkDiskSpaceForOperation } from "./diagnostics";
 *   const result = await checkDiskSpaceForOperation("sync");
 *   if (!result.sufficient) { // show warning to user }
 */

import * as Sentry from "@sentry/electron/main";
import checkDiskSpace from "check-disk-space";
import { app } from "electron";
import log from "electron-log";

/** Minimum disk space thresholds per operation (in MB) */
export const DISK_SPACE_THRESHOLDS = {
  sync: 2048, // 2GB -- iPhone backups can be very large
  update: 1024, // 1GB -- app update download + install
  emailImport: 512, // 500MB -- 3-month email archive
  /**
   * BACKLOG-2870: floor for a macOS Messages import, force re-import included.
   *
   * MEASURED, not picked by analogy to `sync` or `emailImport`. Two sources:
   *
   * 1. What a message costs, from the founder's REAL library (measured under
   *    BACKLOG-2743 against his own chat.db): 41 MB / 25,424 messages =
   *    1,690 bytes per message. His library is 707,828 messages, so the macOS
   *    message rows settle at S = 1.20 GB.
   *
   * 2. What a FORCE re-import PEAKS at, measured for BACKLOG-2870 on the real
   *    better-sqlite3 driver against the real `messages` DDL and all twelve of
   *    its real indexes, with the staging table mirrored the way
   *    `deriveStagingTableDdl`/`deriveStagingIndexDdl` mirror it and the swap run
   *    as one transaction exactly like `swapStagingIntoLive` (N = 150,000):
   *
   *      steady state (live only)      110,092,288 B   1.00 x S
   *      staging filled                220,049,408 B   2.00 x S
   *      PEAK, inside the swap txn     330,716,760 B   3.00 x S
   *      settled after the swap        220,049,408 B   2.00 x S
   *
   *    Peak is 3x because live rows, staged rows and the swap's WAL all coexist:
   *    stage-and-swap builds the replacement BESIDE the original (BACKLOG-2790),
   *    and the WAL cannot checkpoint inside the swap transaction. So the free
   *    space a force re-import needs beyond what the store already occupies is
   *    2.00 x S.
   *
   * 2.00 x 1.20 GB = 2.4 GB for the largest real library measured. Rounded up to
   * 3 GB.
   *
   * A FLOOR, not a prediction — deliberately the same stance as
   * `ATTACHMENT_SPACE_HEADROOM_BYTES`. Attachment bytes are guarded separately
   * and proportionally by BACKLOG-2743; this covers the message text, its twelve
   * indexes and the staging copy the force path builds, none of which the
   * attachment estimate counts.
   */
  messagesImport: 3072, // 3GB -- see the measurement above
  general: 100, // 100MB -- minimum for app operation
} as const;

export type DiskOperation = keyof typeof DISK_SPACE_THRESHOLDS;

export interface DiskSpaceCheckResult {
  sufficient: boolean;
  availableMB: number;
  requiredMB: number;
  path: string;
  warning: boolean; // true if < 1GB but above minimum
}

/**
 * Check disk space before a critical operation.
 *
 * Always adds a Sentry breadcrumb for audit trail.
 * Reports captureMessage (warning/error) when space is insufficient.
 * On check failure, returns sufficient=true so operations are not blocked.
 */
export async function checkDiskSpaceForOperation(
  operation: DiskOperation,
  customMinMB?: number
): Promise<DiskSpaceCheckResult> {
  const requiredMB = customMinMB ?? DISK_SPACE_THRESHOLDS[operation];
  const targetPath = app.getPath("userData");

  try {
    const { free } = await checkDiskSpace(targetPath);
    const availableMB = Math.round(free / (1024 * 1024));
    const sufficient = availableMB >= requiredMB;
    const warning = availableMB < 1024 && sufficient; // < 1GB but still enough

    // Always add breadcrumb for audit trail
    Sentry.addBreadcrumb({
      category: "diagnostics.disk",
      message: `Disk check for ${operation}: ${availableMB}MB available, ${requiredMB}MB required`,
      level: sufficient ? "info" : "warning",
      data: { operation, availableMB, requiredMB, sufficient },
    });

    if (!sufficient) {
      Sentry.captureMessage(`Insufficient disk space for ${operation}`, {
        level: availableMB < 100 ? "error" : "warning",
        tags: {
          operation,
          platform: process.platform,
        },
        extra: {
          availableMB,
          requiredMB,
          path: targetPath,
        },
      });
      log.warn(
        `[DiskDiagnostics] Insufficient space for ${operation}: ${availableMB}MB < ${requiredMB}MB`
      );
    }

    return { sufficient, availableMB, requiredMB, path: targetPath, warning };
  } catch (error) {
    // Graceful degradation: if check fails, allow operation but log
    log.error("[DiskDiagnostics] Failed to check disk space:", error);
    Sentry.captureException(error, {
      tags: { operation, check: "disk_space" },
    });
    return {
      sufficient: true, // Assume sufficient if check fails
      availableMB: -1,
      requiredMB,
      path: targetPath,
      warning: true,
    };
  }
}
