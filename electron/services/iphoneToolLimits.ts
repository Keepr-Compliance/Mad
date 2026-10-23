/**
 * BACKLOG-4002: the iPhone tool time limits, in a module with no imports, so the
 * user-facing messages (diagnostics/userFacingErrors.ts) can derive "90 seconds" and
 * "30 minutes" from the values the code actually uses instead of retyping them (SR R6).
 */

/**
 * The time limit on every short iPhone query (A-F in the BACKLOG-3996 plan).
 *
 * Measured, not chosen: a storage query that stalled for 60.0 s and then answered
 * (exit 0, empty) stays under the line, and a first-run security scan of about 60 s
 * is not cut off at the moment it lets the tool go. Nothing that ran past 90 s has
 * ever returned usable data. Its own constant on purpose — not shared with any other
 * 90 s budget in the app.
 *
 * idevicebackup2 is NOT covered by this: it runs for hours, and its 30-minute
 * no-progress watchdog (BackupService) already covers a held start.
 */
export const IPHONE_QUERY_TIMEOUT_MS = 90_000;

/**
 * BACKLOG-2911 (FIX 2): how long idevicebackup2 may go with NO meaningful activity
 * before BackupService's watchdog judges it dead. See WATCHDOG_NO_PROGRESS_TIMEOUT_MS in
 * backupService.ts for why the value is 30 minutes.
 */
export const BACKUP_WATCHDOG_NO_PROGRESS_TIMEOUT_MS = 1_800_000;
