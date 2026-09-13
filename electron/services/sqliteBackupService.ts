/**
 * SQLite Backup Service
 * TASK-2052: Database backup and restore functionality
 *
 * Provides safe backup and restore operations for the encrypted SQLite database.
 * Uses SQLite's backup API for safe concurrent backups.
 * Restore workflow: verify -> close -> safety copy -> replace -> reopen -> migrate
 *
 * SECURITY: Backup files are encrypted with the same SQLCipher key as the original.
 * They can only be restored on the same machine (keychain-bound encryption key).
 */

import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import { app } from "electron";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import databaseService from "./databaseService";
import { databaseEncryptionService } from "./databaseEncryptionService";
import { ensureDb } from "./db/core/dbConnection";
// BACKLOG-2553. NOTE: this module has its own `getDbPath()` below, so the
// pool is restarted from the credentials it was OPENED with (passing null
// lets the pool use its stored `lastDbPath`/`lastEncryptionKey`) rather than
// from a second, independent derivation of the database location.
import {
  drainPoolForExclusiveAccess,
  restartPoolAfterExclusiveAccess,
} from "../workers/contactWorkerPool";
import { BACKUP_TABLE_COUNT_SQL } from "./db/backupVerificationSql";

/** Result of a backup operation */
export interface BackupResult {
  success: boolean;
  filePath?: string;
  fileSize?: number;
  error?: string;
}

/**
 * BACKLOG-2553 — shown when the contact worker could not be stopped.
 *
 * It is exact about the two things the user needs: the database was NOT
 * changed, and quitting the app clears the condition. `backupRestoreHandlers`
 * returns this result verbatim, so this string is what reaches the dialog.
 */
export const RESTORE_POOL_DRAIN_REFUSAL =
  "Restore cancelled - the contact background task could not be stopped, so " +
  "your database was not changed. Quit and reopen Keepr, then try the restore again.";

/** Result of a restore operation */
export interface RestoreResult {
  success: boolean;
  error?: string;
  requiresRestart?: boolean;
}

/** Database info for display in settings */
export interface DatabaseInfo {
  filePath: string;
  fileSize: number;
  lastModified: string;
}

/**
 * Generate the default backup filename with current date
 */
export function generateBackupFilename(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return `keepr-backup-${dateStr}.db`;
}

/**
 * Get the database file path
 */
function getDbPath(): string {
  return path.join(app.getPath("userData"), "mad.db");
}

/**
 * Create a backup of the database to the specified path.
 * Uses SQLite's backup API which is safe for concurrent access.
 *
 * @param destinationPath - Where to save the backup file
 * @returns BackupResult with success status and file info
 */
export async function backupDatabase(
  destinationPath: string
): Promise<BackupResult> {
  try {
    const dbPath = getDbPath();

    // Prevent backup to same file as active database
    const resolvedDest = path.resolve(destinationPath);
    const resolvedDb = path.resolve(dbPath);
    if (resolvedDest === resolvedDb) {
      return {
        success: false,
        error: "Cannot backup to the same file as the active database.",
      };
    }

    if (!databaseService.isInitialized()) {
      return {
        success: false,
        error: "Database is not initialized.",
      };
    }

    await logService.info(
      `Starting database backup to: ${destinationPath}`,
      "SqliteBackupService"
    );

    // BACKLOG-1122: Flush WAL to main database file before copying.
    // Without this, the backup may be inconsistent if writes are in-flight.
    try {
      const db = ensureDb();
      if (db) {
        const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; checkpointed: number; log: number }>;
        const checkpointResult = result[0];
        if (checkpointResult && checkpointResult.busy !== 0) {
          // Checkpoint was blocked by concurrent readers/writers - abort backup
          await logService.error(
            "WAL checkpoint blocked by concurrent access - aborting backup",
            "SqliteBackupService",
            { busy: checkpointResult.busy }
          );
          return {
            success: false,
            error: "Database is busy. Please try again in a moment.",
          };
        }
        await logService.info(
          "WAL checkpoint completed before backup",
          "SqliteBackupService",
          { checkpointed: checkpointResult?.checkpointed, log: checkpointResult?.log }
        );
      }
    } catch (walError) {
      // If checkpoint fails, abort backup rather than creating an inconsistent copy
      const walErrorMsg = walError instanceof Error ? walError.message : String(walError);
      await logService.error(
        "WAL checkpoint failed - aborting backup",
        "SqliteBackupService",
        { error: walErrorMsg }
      );
      return {
        success: false,
        error: `WAL checkpoint failed: ${walErrorMsg}`,
      };
    }

    // Use fs.copyFileSync for encrypted databases -- SQLite backup API
    // creates an unencrypted destination which is incompatible with SQLCipher.
    // This matches the approach used by databaseService pre-migration backups.
    fs.copyFileSync(dbPath, destinationPath);

    // Get backup file size
    const stats = fs.statSync(destinationPath);

    await logService.info(
      `Database backup completed successfully (${stats.size} bytes)`,
      "SqliteBackupService"
    );

    return {
      success: true,
      filePath: destinationPath,
      fileSize: stats.size,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    await logService.error("Database backup failed", "SqliteBackupService", {
      error: errorMessage,
    });
    Sentry.captureException(error, {
      tags: { service: "sqlite-backup", operation: "backup" },
    });
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Verify a backup file is a valid, decryptable SQLite database.
 *
 * @param backupPath - Path to the backup file to verify
 * @returns true if the backup is valid and decryptable
 */
export async function verifyBackup(backupPath: string): Promise<boolean> {
  let testDb: DatabaseType | null = null;
  try {
    if (!fs.existsSync(backupPath)) {
      await logService.warn(
        "Backup file does not exist",
        "SqliteBackupService",
        { path: backupPath }
      );
      return false;
    }

    // Get the encryption key
    const encryptionKey = await databaseEncryptionService.getEncryptionKey();

    // Try to open the backup with the encryption key
    testDb = new Database(backupPath, { readonly: true });
    testDb.pragma(`key = "x'${encryptionKey}'"`);
    testDb.pragma("cipher_compatibility = 4");

    // Run integrity check
    testDb.pragma("cipher_integrity_check");

    // Verify we can read data (tables exist)
    const tables = testDb
      .prepare(BACKUP_TABLE_COUNT_SQL)
      .get() as { count: number };

    if (tables.count === 0) {
      await logService.warn(
        "Backup file contains no tables",
        "SqliteBackupService"
      );
      return false;
    }

    await logService.info(
      `Backup verified: ${tables.count} tables found`,
      "SqliteBackupService"
    );
    return true;
  } catch (error) {
    await logService.warn("Backup verification failed", "SqliteBackupService", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (testDb) {
      try {
        testDb.close();
      } catch {
        // Ignore close errors during verification
      }
    }
  }
}

/**
 * Restore a database from a backup file.
 *
 * Workflow:
 * 1. Verify the backup file is valid and decryptable
 * 2. Close the current database connection
 * 3. Create a safety copy of the current database
 * 4. Copy the backup file over the current database
 * 5. Reopen the database connection
 * 6. Run migrations if needed
 * 7. If any step fails, restore the safety copy
 *
 * @param backupPath - Path to the backup file to restore from
 * @returns RestoreResult with success status
 */
export async function restoreDatabase(
  backupPath: string
): Promise<RestoreResult> {
  const dbPath = getDbPath();
  const safetyPath = `${dbPath}.safety-restore-copy`;
  let safetyCreated = false;
  /**
   * BACKLOG-2553 — gates the restart in `finally`. Deliberately NOT
   * `safetyCreated`: that flag is false whenever the database file did not
   * exist, and the existing catch only re-initialises inside its
   * `if (safetyCreated && ...)` block, so keying the restart off it would leave
   * the app with no contact worker on exactly the paths that already went wrong.
   */
  let poolDrained = false;

  try {
    await logService.info(
      `Starting database restore from: ${backupPath}`,
      "SqliteBackupService"
    );

    // Step 1: Verify the backup file
    const isValid = await verifyBackup(backupPath);
    if (!isValid) {
      return {
        success: false,
        error:
          "The selected file is not a valid backup. It may be corrupted or encrypted with a different key.",
      };
    }

    /**
     * Step 1b (BACKLOG-2553): stop the contact worker BEFORE anything is closed
     * or copied.
     *
     * The worker holds its own connection to this exact file and is shut down
     * nowhere but app quit. With it running, the copy below either fails
     * (Windows, EBUSY/EPERM on a file a second thread holds open) or succeeds
     * while the worker goes on reading the old unlinked inode (macOS), serving
     * the user pre-restore contacts after a restore they asked for. The
     * worker's connection is `readonly: true` since BACKLOG-2536, so no WRITE
     * can be lost — this is a failed restore and a stale read, not corruption.
     *
     * Ordered ahead of `databaseService.close()` on purpose: a refusal here has
     * closed nothing, written no safety copy, and replaced no file.
     *
     * WHAT A REFUSAL IS NOT: a no-op for the POOL. The drain marks the pool
     * not-ready and rejects in-flight queries before it posts the shutdown
     * message, and a posted message cannot be un-posted. So a refused restore
     * leaves the database file untouched and the contact pool unusable until
     * the app restarts — which is exactly what the message below tells the user
     * to do.
     */
    const drain = await drainPoolForExclusiveAccess();
    if (!drain.drained) {
      await logService.error(
        "Restore refused: contact worker pool could not be drained",
        "SqliteBackupService",
        { reason: drain.reason }
      );
      return { success: false, error: RESTORE_POOL_DRAIN_REFUSAL };
    }
    poolDrained = true;
    await logService.info(
      `Contact worker pool drained for restore (via: ${drain.via})`,
      "SqliteBackupService"
    );

    // Step 2: Close the current database
    await logService.info(
      "Closing current database for restore",
      "SqliteBackupService"
    );
    await databaseService.close();

    // Step 3: Create safety copy
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, safetyPath);
      safetyCreated = true;
      await logService.info(
        "Created safety copy of current database",
        "SqliteBackupService"
      );
    }

    // Also remove WAL and SHM files if they exist (SQLite journal files)
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }
    if (fs.existsSync(shmPath)) {
      fs.unlinkSync(shmPath);
    }

    // Step 4: Copy the backup file over the current database
    fs.copyFileSync(backupPath, dbPath);
    await logService.info(
      "Backup file copied to database location",
      "SqliteBackupService"
    );

    // Step 5: Reinitialize the database
    await databaseService.initialize();

    // Step 6: Migrations run automatically during initialize()

    // Clean up safety copy on success
    if (safetyCreated && fs.existsSync(safetyPath)) {
      fs.unlinkSync(safetyPath);
    }

    await logService.info(
      "Database restore completed successfully",
      "SqliteBackupService"
    );

    return {
      success: true,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    await logService.error("Database restore failed", "SqliteBackupService", {
      error: errorMessage,
    });
    Sentry.captureException(error, {
      tags: { service: "sqlite-backup", operation: "restore" },
    });

    // Attempt to restore from safety copy
    if (safetyCreated && fs.existsSync(safetyPath)) {
      try {
        await logService.info(
          "Restoring from safety copy after failed restore",
          "SqliteBackupService"
        );
        fs.copyFileSync(safetyPath, dbPath);
        // Try to reinitialize with original database
        await databaseService.initialize();
        fs.unlinkSync(safetyPath);
        await logService.info(
          "Safety copy restored successfully",
          "SqliteBackupService"
        );
      } catch (recoveryError) {
        await logService.error(
          "Failed to restore safety copy -- database may be in broken state",
          "SqliteBackupService",
          {
            error:
              recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError),
          }
        );
        // Return a more severe error
        return {
          success: false,
          error: `Restore failed and recovery also failed: ${errorMessage}. The app may need to be restarted.`,
          requiresRestart: true,
        };
      }
    }

    return {
      success: false,
      error: `Restore failed: ${errorMessage}`,
    };
  } finally {
    /**
     * BACKLOG-2553 — the restart, on EVERY exit.
     *
     * `finally` and not the catch block: the catch re-initialises the database
     * only inside `if (safetyCreated && fs.existsSync(safetyPath))`, and it has
     * its own early return on the recovery-failed path. A restart placed in
     * either would be skipped on the paths that need it most. This runs after
     * the return value is computed and before it is handed back, so the pool is
     * up before the renderer is answered.
     *
     * The whole body is wrapped: a throw in a `finally` REPLACES the return
     * value, so a failure here would turn a successful restore into an
     * exception at the IPC boundary. `restartPoolAfterExclusiveAccess` already
     * swallows its own errors; this guards the call itself.
     *
     * `spawn` is `databaseService.isInitialized()` — on the double-failure path
     * the file is not open, and a worker started against it would hold the
     * user's error dialog behind a 10-second init timeout for nothing. The hold
     * is still released in that case; only the spawn is skipped.
     */
    if (poolDrained) {
      try {
        await restartPoolAfterExclusiveAccess(
          null,
          null,
          databaseService.isInitialized()
        );
      } catch {
        // Unreachable in practice; the restart swallows its own errors. Kept so
        // that a future change there cannot silently rewrite this return value.
      }
    }
  }
}

/**
 * Get database file info (size and last modified date)
 *
 * @returns DatabaseInfo or null if database file doesn't exist
 */
export async function getDatabaseInfo(): Promise<DatabaseInfo | null> {
  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
      return null;
    }

    const stats = fs.statSync(dbPath);
    return {
      filePath: dbPath,
      fileSize: stats.size,
      lastModified: stats.mtime.toISOString(),
    };
  } catch (error) {
    await logService.error(
      "Failed to get database info",
      "SqliteBackupService",
      { error: error instanceof Error ? error.message : String(error) }
    );
    return null;
  }
}
