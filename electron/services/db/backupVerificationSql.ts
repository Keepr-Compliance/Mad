/**
 * SQL for verifying a Keepr backup file — BACKLOG-2989 (epic BACKLOG-2958).
 *
 * Moved out of `sqliteBackupService.verifyBackup`. The rule that SQL text is
 * defined only under `electron/services/db/**` is BACKLOG-2959, which also
 * ships the CI gate that enforces it.
 *
 * ## The statement runs against a DIFFERENT database file
 *
 * `verifyBackup` opens the backup at `backupPath` as its own read-only
 * connection and keys it, precisely because the point is to prove the file on
 * disk can be opened and read — a check against the live singleton would prove
 * nothing about the backup. That EXECUTION on a non-singleton handle is a
 * declared exception in `scripts/ci/check-sql-boundary.mjs`
 * (`DECLARED_EXCEPTIONS`, BACKLOG-2959 ruling 4), and it stays where it is,
 * together with the file's four `pragma` calls: cipher and connection
 * configuration are not query text.
 *
 * What was never covered by that exception is the query text itself, which is
 * why this constant now lives here.
 *
 * ## Why counting tables is the verification
 *
 * A wrong key does not fail `open`; it fails the first READ, because the page
 * cannot be decrypted. So the cheapest honest proof that the backup is both
 * readable and non-empty is to ask its schema how many tables it has. Zero
 * tables means the file opened but carries nothing — reported as a failed
 * verification rather than a success with no data.
 *
 * The text is byte-identical to the statement this replaced, verified by
 * comparing the gate's own content hash (`ec146917d073`) before and after.
 */

/**
 * Number of tables in a database's schema. No bound parameters.
 * Returns one row shaped `{ count: number }`.
 */
export const BACKUP_TABLE_COUNT_SQL =
  "SELECT count(*) as count FROM sqlite_master WHERE type='table'";
