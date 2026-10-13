/**
 * BACKLOG-3892 E: the one Sentry event for a saved-iPhone-backup problem. Tags only:
 * a component and a reason from a closed set. Never a udid, a path or message text.
 */
import * as Sentry from "@sentry/electron/main";
import type { BackupProblemReason } from "./backupProblem";

/** One Sentry event per backup problem. Tags only; never throws. */
export function reportBackupProblem(reason: BackupProblemReason): void {
  try {
    Sentry.captureMessage("iPhone backup problem", {
      level: "warning",
      tags: { component: "iphone_backup", reason },
      fingerprint: ["iphone-backup-problem", reason],
    });
  } catch {
    // Reporting must never change what the sync does.
  }
}
