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
import { BACKUP_TABLE_COUNT_SQL } from "./db/backupVerificationSql";

/** Result of a backup operation */
export interface BackupResult {
  success: boolean;
  filePath?: string;
  fileSize?: number;
  error?: string;
}

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
