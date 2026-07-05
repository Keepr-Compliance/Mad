/**
 * Database Service - Facade Layer
 *
 * This service acts as a thin facade over the domain-specific db/* services.
 * It provides backward compatibility for existing consumers while delegating
 * all operations to the appropriate domain service.
 *
 * ARCHITECTURE:
 * - Initialization, encryption, and migration logic lives here
 * - Domain operations (CRUD) delegate to db/* services
 * - 37 consumer files import from here for backward compatibility
 *
 * SECURITY: Database is encrypted at rest using SQLCipher (AES-256)
 * Encryption key is stored in OS keychain via Electron safeStorage
 *
 * @see electron/services/db/ for domain-specific implementations
 */

import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType } from "better-sqlite3";
import log from "electron-log";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { app, dialog } from "electron";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import {
  setDb,
  setDbPath,
  setEncryptionKey,
  closeDb,
  vacuumDb,
} from "./db/core/dbConnection";

// Import types
import type {
  User,
  NewUser,
  Contact,
  NewContact,
  ContactFilters,
  Transaction,
  NewTransaction,
  TransactionFilters,
  TransactionWithContacts,
  Communication,
  NewCommunication,
  CommunicationFilters,
  UserFeedback,
  OAuthToken,
  Session,
  OAuthProvider,
  OAuthPurpose,
  IDatabaseService,
  IgnoredCommunication,
  NewIgnoredCommunication,
  Message,
  Attachment,
} from "../types";

import { DatabaseError } from "../types";
import { databaseEncryptionService } from "./databaseEncryptionService";
import { initializationBroadcaster } from "./initializationBroadcaster";
import type { AuditLogEntry, AuditLogDbRow } from "./auditService";

// Import domain services for delegation
import * as userDb from "./db/userDbService";
import * as sessionDb from "./db/sessionDbService";
import * as oauthDb from "./db/oauthTokenDbService";
import * as transactionDb from "./db/transactionDbService";
import * as contactDb from "./db/contactDbService";
import * as transactionContactDb from "./db/transactionContactDbService";
import * as communicationDb from "./db/communicationDbService";
import * as feedbackDb from "./db/feedbackDbService";
import * as auditDb from "./db/auditLogDbService";
import * as messageDb from "./db/messageDbService";
import * as diagnosticDb from "./db/diagnosticDbService";
import * as attachmentDb from "./db/attachmentDbService";
import * as submissionDb from "./db/submissionDbService";
import * as syncDb from "./db/syncDbService";
import * as maintenanceDb from "./db/maintenanceDbService";

// Re-export types for backward compatibility
export type { ContactAssignmentOperation } from "./db/transactionContactDbService";
export type {
  TransactionContactData,
  TransactionContactResult,
} from "./db/transactionContactDbService";
export type { ContactWithActivity, TransactionWithRoles } from "./db/contactDbService";

/** Result of a dry-run migration check */
export interface MigrationPlan {
  currentVersion: number;
  targetVersion: number;
  pendingMigrations: { version: number; description: string }[];
  wouldRunCount: number;
}

/** Internal migration definition */
interface MigrationEntry {
  version: number;
  description: string;
  migrate: (d: DatabaseType) => void;
}

/**
 * DatabaseService - Facade for all database operations
 *
 * Maintains backward compatibility while delegating to domain services.
 * Only initialization, encryption, and migration logic remains here.
 */
class DatabaseService implements IDatabaseService {
  private db: DatabaseType | null = null;
  private dbPath: string | null = null;
  private encryptionKey: string | null = null;

  // ============================================
  // INITIALIZATION & LIFECYCLE (Keep in facade)
  // ============================================

  /**
   * Initialize database - creates DB file and tables if needed
   * Handles encryption and migration from unencrypted databases
   */
  async initialize(): Promise<boolean> {
    if (this.db) {
      await logService.debug("Database already initialized, skipping", "DatabaseService");
      return true;
    }

    try {
      const userDataPath = app.getPath("userData");
      this.dbPath = path.join(userDataPath, "mad.db");

      await logService.info("Initializing database", "DatabaseService", { path: this.dbPath });

      // BACKLOG-1381: Broadcast db-opening stage
      initializationBroadcaster.broadcast({
        stage: "db-opening",
        message: "Opening secure database...",
      });

      // Ensure app data directory exists before any DB file operations.
      // Uses recursive:true which is a safe no-op if directory already exists,
      // avoiding TOCTOU race with existsSync. Fixes Sentry ELECTRON-33.
      const dbDir = path.dirname(this.dbPath);
      fs.mkdirSync(dbDir, { recursive: true });

      await databaseEncryptionService.initialize();
      this.encryptionKey = await databaseEncryptionService.getEncryptionKey();

      const needsMigration = await this._checkMigrationNeeded();
      if (needsMigration) {
        await logService.info("Migrating existing database to encrypted storage", "DatabaseService");
        await this._migrateToEncryptedDatabase();
      }

      this.db = this._openDatabase();

      // Share connection with dbConnection module for sub-services
      setDb(this.db);
      setDbPath(this.dbPath);
      setEncryptionKey(this.encryptionKey);

      // Safety check: ensure failure_log table exists even if migration v31 failed
      // (e.g., disk full during migration). Fixes Sentry ELECTRON-2P / ELECTRON-2X.
      this._ensureFailureLogTable(this.db);

      // BACKLOG-1381: Broadcast migrating stage before running migrations
      initializationBroadcaster.broadcast({
        stage: "migrating",
        progress: 0,
        message: "Updating database...",
      });

      try {
        await this.runMigrations();

        // BACKLOG-1381: Broadcast db-ready after successful migrations
        initializationBroadcaster.broadcast({
          stage: "db-ready",
          message: "Database ready",
        });
      } catch (migrationError) {
        // BACKLOG-1381: Broadcast error on migration failure
        initializationBroadcaster.broadcast({
          stage: "error",
          error: {
            message: migrationError instanceof Error ? migrationError.message : "Migration failed",
            retryable: true,
          },
        });

        // Migration failed -- attempt auto-restore from pre-migration backup
        log.error("[DatabaseService] Migration FAILED:", migrationError instanceof Error ? migrationError.message : String(migrationError));
        await logService.error("Migration failed, attempting auto-restore", "DatabaseService", {
          error: migrationError instanceof Error ? migrationError.message : String(migrationError),
        });

        const restoreResult = await this._attemptAutoRestore(migrationError);

        // Report to Sentry with migration failure tags
        Sentry.captureException(migrationError, {
          tags: {
            service: "database-service",
            operation: "runMigrations",
            migration_failure: "true",
            auto_restore: restoreResult.autoRestoreStatus,
            backup_integrity: restoreResult.backupIntegrity,
          },
        });

        // Ensure app is ready before showing dialog
        if (!app.isReady()) {
          await app.whenReady();
        }

        if (restoreResult.restored) {
          dialog.showMessageBox({
            type: "warning",
            title: "Database Update Notice",
            message: "A database update failed, but your data has been restored.",
            detail: "The app will continue with your existing data. Please contact support if this happens again.",
            buttons: ["OK"],
          });
        } else {
          dialog.showMessageBox({
            type: "error",
            title: "Database Update Failed",
            message: "A database update failed and could not be automatically fixed.",
            detail: "Please contact support. Your data may need manual recovery.",
            buttons: ["OK"],
          });
        }
      }

      await logService.debug("Database initialized successfully with encryption", "DatabaseService");
      return true;
    } catch (error) {
      // BACKLOG-1381: Broadcast error on initialization failure
      initializationBroadcaster.broadcast({
        stage: "error",
        error: {
          message: error instanceof Error ? error.message : "Database initialization failed",
          retryable: true,
        },
      });

      await logService.error("Failed to initialize database", "DatabaseService", {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "database-service", operation: "initialize" },
      });
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.db !== null;
  }

  private _ensureDb(): DatabaseType {
    if (!this.db) {
      throw new DatabaseError("Database is not initialized. Call initialize() first.");
    }
    return this.db;
  }

  getRawDatabase(): DatabaseType {
    return this._ensureDb();
  }

  private _openDatabase(): DatabaseType {
    if (!this.dbPath) throw new DatabaseError("Database path is not set");
    if (!this.encryptionKey) throw new DatabaseError("Encryption key is not set");

    const openedDb = new Database(this.dbPath);
    openedDb.pragma(`key = "x'${this.encryptionKey}'"`);
    openedDb.pragma("cipher_compatibility = 4");
    openedDb.pragma("foreign_keys = ON");

    try {
      openedDb.pragma("cipher_integrity_check");
    } catch {
      throw new DatabaseError("Failed to decrypt database. Encryption key may be invalid.");
    }

    return openedDb;
  }

  /**
   * Safety check: ensure the failure_log table exists.
   *
   * If migration v31 failed (e.g., disk full), this table may not exist,
   * causing "no such table: failure_log" errors (Sentry ELECTRON-2P, ELECTRON-2X).
   * This runs BEFORE migrations so that any migration error logging that
   * touches failure_log will not crash.
   */
  private _ensureFailureLogTable(currentDb: DatabaseType): void {
    try {
      currentDb.exec(`
        CREATE TABLE IF NOT EXISTS failure_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          operation TEXT NOT NULL,
          error_message TEXT NOT NULL,
          metadata TEXT,
          acknowledged INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_failure_log_timestamp ON failure_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_failure_log_acknowledged ON failure_log(acknowledged);
      `);
      log.info("[DatabaseService] failure_log table safety check passed");
    } catch (err) {
      // Log but do not throw -- this is a safety net, not a hard requirement
      log.warn(
        "[DatabaseService] failure_log safety check failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private async _checkMigrationNeeded(): Promise<boolean> {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return false;
    const isEncrypted = await databaseEncryptionService.isDatabaseEncrypted(this.dbPath);
    return !isEncrypted;
  }

  private async _migrateToEncryptedDatabase(): Promise<void> {
    if (!this.dbPath || !this.encryptionKey) {
      throw new DatabaseError("Database path or encryption key not set");
    }

    const unencryptedPath = this.dbPath;
    const backupPath = `${this.dbPath}.backup`;
    const encryptedPath = `${this.dbPath}.encrypted`;

    try {
      await logService.info("Starting database encryption migration", "DatabaseService");
      fs.copyFileSync(unencryptedPath, backupPath);

      const oldDb = new Database(unencryptedPath, { readonly: true });
      const tables = oldDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as { name: string }[];

      const indexes = oldDb.prepare(`
        SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL
      `).all() as { sql: string }[];

      const triggers = oldDb.prepare(`
        SELECT sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL
      `).all() as { sql: string }[];

      const newDb = new Database(encryptedPath);
      newDb.pragma(`key = "x'${this.encryptionKey}'"`);

      for (const { name: tableName } of tables) {
        const tableInfo = oldDb.prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
        ).get(tableName) as { sql: string } | undefined;

        if (tableInfo?.sql) {
          newDb.exec(tableInfo.sql);
          const rows = oldDb.prepare(`SELECT * FROM "${tableName}"`).all();
          if (rows.length > 0) {
            const columns = Object.keys(rows[0] as object);
            const placeholders = columns.map(() => "?").join(", ");
            const insertStmt = newDb.prepare(
              `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`
            );
            const insertMany = newDb.transaction((data: unknown[]) => {
              for (const row of data) {
                insertStmt.run(...columns.map((col) => (row as Record<string, unknown>)[col]));
              }
            });
            insertMany(rows);
          }
        }
      }

      for (const { sql } of indexes) {
        try { newDb.exec(sql); } catch { /* Index may already exist */ }
      }

      for (const { sql } of triggers) {
        try { newDb.exec(sql); } catch { /* Trigger may already exist */ }
      }

      oldDb.close();
      newDb.close();

      await this._secureDelete(unencryptedPath);
      fs.renameSync(encryptedPath, unencryptedPath);
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

      await logService.info("Database encryption migration completed successfully", "DatabaseService");
    } catch (error) {
      await logService.error("Database encryption migration failed", "DatabaseService", {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "database-service", operation: "_migrateToEncryptedDatabase" },
      });

      if (fs.existsSync(backupPath)) {
        if (fs.existsSync(unencryptedPath)) fs.unlinkSync(unencryptedPath);
        fs.renameSync(backupPath, unencryptedPath);
      }
      if (fs.existsSync(encryptedPath)) fs.unlinkSync(encryptedPath);

      throw error;
    }
  }

  private async _secureDelete(filePath: string): Promise<void> {
    try {
      const fd = fs.openSync(filePath, "r+");
      try {
        const stats = fs.fstatSync(fd);
        for (let pass = 0; pass < 3; pass++) {
          const randomData = crypto.randomBytes(stats.size);
          fs.writeSync(fd, randomData, 0, randomData.length, 0);
          fs.fsyncSync(fd);
        }
      } finally {
        fs.closeSync(fd);
      }
      fs.unlinkSync(filePath);
    } catch {
      try { fs.unlinkSync(filePath); } catch { /* file already gone */ }
    }
  }

  // ============================================
  // MIGRATION FAILURE AUTO-RESTORE (TASK-2057)
  // ============================================

  private async _attemptAutoRestore(
    _migrationError: unknown
  ): Promise<{
    restored: boolean;
    autoRestoreStatus: "succeeded" | "failed" | "no_backup";
    backupIntegrity: "valid" | "corrupt" | "missing";
  }> {
    if (!this.dbPath || !this.encryptionKey) {
      return { restored: false, autoRestoreStatus: "no_backup", backupIntegrity: "missing" };
    }

    const dbDir = path.dirname(this.dbPath);
    const dbName = path.basename(this.dbPath, ".db");

    let backupFiles: string[] = [];
    try {
      backupFiles = fs
        .readdirSync(dbDir)
        .filter((f) => f.startsWith(`${dbName}-backup-`) && f.endsWith(".db"))
        .sort()
        .reverse();
    } catch {
      // Cannot read directory
    }

    if (backupFiles.length === 0) {
      await logService.warn("No backup files found for auto-restore", "DatabaseService");
      return { restored: false, autoRestoreStatus: "no_backup", backupIntegrity: "missing" };
    }

    const latestBackupPath = path.join(dbDir, backupFiles[0]);

    const isValid = this._verifyBackupIntegrity(latestBackupPath, this.encryptionKey);
    if (!isValid) {
      await logService.error("Backup file failed integrity check, cannot auto-restore", "DatabaseService", {
        backupPath: latestBackupPath,
      });
      return { restored: false, autoRestoreStatus: "failed", backupIntegrity: "corrupt" };
    }

    await logService.info("Backup integrity verified, proceeding with auto-restore", "DatabaseService", {
      backupPath: latestBackupPath,
    });

    try {
      if (this.db) {
        try { this.db.close(); } catch { /* May already be in a bad state */ }
        this.db = null;
      }

      fs.copyFileSync(latestBackupPath, this.dbPath);
      await logService.info("Backup file restored over main database", "DatabaseService");

      const newDb = this._openDatabase();
      this.db = newDb;

      setDb(newDb);
      setDbPath(this.dbPath);
      setEncryptionKey(this.encryptionKey);

      try {
        const probe = newDb.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
        if (!probe || probe.ok !== 1) {
          throw new Error("Post-restore connectivity check returned unexpected result");
        }
      } catch (probeError) {
        await logService.error("Post-restore connectivity check failed", "DatabaseService", {
          error: probeError instanceof Error ? probeError.message : String(probeError),
        });
        return { restored: false, autoRestoreStatus: "failed", backupIntegrity: "valid" };
      }

      await logService.info("Auto-restore completed successfully", "DatabaseService");
      return { restored: true, autoRestoreStatus: "succeeded", backupIntegrity: "valid" };
    } catch (restoreError) {
      await logService.error("Auto-restore failed during file replacement or reopening", "DatabaseService", {
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      });
      return { restored: false, autoRestoreStatus: "failed", backupIntegrity: "valid" };
    }
  }

  private _verifyBackupIntegrity(backupPath: string, key: string): boolean {
    let testDb: DatabaseType | null = null;
    try {
      if (!fs.existsSync(backupPath)) return false;

      testDb = new Database(backupPath, { readonly: true });
      testDb.pragma(`key = "x'${key}'"`);
      testDb.pragma("cipher_compatibility = 4");

      const result = testDb.pragma("integrity_check") as Array<{ integrity_check: string }>;
      return result[0]?.integrity_check === "ok";
    } catch {
      return false;
    } finally {
      if (testDb) {
        try { testDb.close(); } catch { /* Ignore close errors */ }
      }
    }
  }

  // ============================================
  // MIGRATIONS (Version-based runner)
  // ============================================

  async runMigrations(): Promise<void> {
    const currentDb = this._ensureDb();
    const schemaPath = path.join(__dirname, "../database/schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");

    // BACKLOG-1576: Set Sentry user context before migrations run.
    // The DB is open (just not migrated), so we can query users_local
    // to attribute migration errors to the correct user.
    try {
      const tables = currentDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users_local'").all();
      if (tables.length > 0) {
        const user = currentDb.prepare("SELECT id, email FROM users_local LIMIT 1").get() as { id: string; email?: string } | undefined;
        if (user?.id) {
          Sentry.setUser({ id: user.id, email: user.email || undefined });
          Sentry.addBreadcrumb({
            category: "database",
            message: "Pre-migration user context set",
            level: "info",
            data: { userId: user.id },
          });
          await logService.info("[Sentry] Pre-migration user context set", "DatabaseService", { userId: user.id });
        }
      }
    } catch {
      // Non-fatal: if user query fails, Sentry just won't have user context
    }

    // Pre-migration backup (TASK-1969)
    if (this.dbPath && fs.existsSync(this.dbPath)) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
        const bkPath = this.dbPath.replace(".db", `-backup-${timestamp}.db`);

        try { currentDb.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* WAL may not be enabled */ }

        fs.copyFileSync(this.dbPath, bkPath);
        await logService.info(`Pre-migration backup created: ${bkPath}`, "DatabaseService");
      } catch (backupError) {
        await logService.warn("Pre-migration backup failed", "DatabaseService", { error: backupError instanceof Error ? backupError.message : String(backupError) });
        Sentry.captureException(backupError, {
          tags: { service: "database-service", operation: "runMigrations.backup" },
        });
      }
    }

    // R1 (BACKLOG-1722): One-time 30-day pre-junction-backfill snapshot.
    // Taken only when v41 is about to run (schema_version exists and version < 41).
    // Name deliberately avoids the `${dbName}-backup-` rolling-cleanup prefix so
    // it survives the 3-file retention prune below.
    // Idempotent: if snapshot already exists, skip to preserve the earliest
    // pre-migration state (covers mid-migration crash + retry).
    if (this.dbPath && fs.existsSync(this.dbPath)) {
      try {
        const svTableRow = currentDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
          .get();
        if (svTableRow) {
          const dbVersion = (
            currentDb
              .prepare("SELECT version FROM schema_version WHERE id = 1")
              .get() as { version: number } | undefined
          )?.version ?? 0;
          if (dbVersion < 41) {
            const snapshotDir = path.dirname(this.dbPath);
            const snapshotName = path.basename(this.dbPath, ".db");
            const snapshotPath = path.join(snapshotDir, `${snapshotName}-pre-junction-backfill.db`);
            if (!fs.existsSync(snapshotPath)) {
              try { currentDb.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* WAL may not be enabled */ }
              fs.copyFileSync(this.dbPath, snapshotPath);
              await logService.info(
                `Pre-junction backfill snapshot created: ${snapshotPath}`,
                "DatabaseService"
              );
            } else {
              await logService.info(
                "Pre-junction backfill snapshot already exists — skipping to preserve earliest pre-migration state",
                "DatabaseService"
              );
            }
          }
        }
      } catch (snapshotError) {
        // Non-fatal: rolling backup already covers basic recovery.
        await logService.warn(
          "Pre-junction backfill snapshot failed (non-fatal)",
          "DatabaseService",
          { error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError) }
        );
      }
    }

    try {
      currentDb.exec(schemaSql);
      await this._runVersionedMigrations();
    } catch (error) {
      await logService.error("Failed to run migrations", "DatabaseService", {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "database-service", operation: "runMigrations" },
      });
      // BACKLOG-1576: Flush Sentry before re-throwing so the event
      // (with user context) is guaranteed to be sent even if the
      // process exits quickly after the auto-restore flow.
      await Sentry.flush(2000);
      throw error;
    }

    // Backup retention: keep last 3, delete older
    if (this.dbPath) {
      try {
        const dbDir = path.dirname(this.dbPath);
        const dbName = path.basename(this.dbPath, ".db");
        const backupFiles = fs
          .readdirSync(dbDir)
          .filter((f) => f.startsWith(`${dbName}-backup-`) && f.endsWith(".db"))
          .sort()
          .reverse();

        for (const old of backupFiles.slice(3)) {
          fs.unlinkSync(path.join(dbDir, old));
          await logService.info(`Removed old backup: ${old}`, "DatabaseService");
        }
      } catch {
        // Cleanup failures must not affect the app
      }
    }

    // 30-day snapshot cleanup (R1, BACKLOG-1722)
    if (this.dbPath) {
      try {
        const snapshotDir = path.dirname(this.dbPath);
        const snapshotName = path.basename(this.dbPath, ".db");
        const snapshotPath = path.join(snapshotDir, `${snapshotName}-pre-junction-backfill.db`);
        if (fs.existsSync(snapshotPath)) {
          const stats = fs.statSync(snapshotPath);
          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          if (Date.now() - stats.mtimeMs > THIRTY_DAYS_MS) {
            fs.unlinkSync(snapshotPath);
            await logService.info(
              "Removed pre-junction backfill snapshot (age > 30 days)",
              "DatabaseService"
            );
          }
        }
      } catch {
        // Cleanup failures must not affect the app
      }
    }
  }

  /** Baseline version -- schema.sql contains everything through migration 28 */
  static readonly BASELINE_VERSION = 29;

  static readonly MIGRATIONS: MigrationEntry[] = [
    {
      version: 30,
      description: "Fix transaction_summary view to count from transaction_contacts instead of deprecated transaction_participants",
      migrate: (d) => {
        d.exec(`
          DROP VIEW IF EXISTS transaction_summary;
          CREATE VIEW IF NOT EXISTS transaction_summary AS
          SELECT
            t.id,
            t.user_id,
            t.property_address,
            t.transaction_type,
            t.status,
            t.stage,
            t.started_at,
            t.closed_at,
            t.message_count,
            t.attachment_count,
            t.confidence_score,
            (SELECT COUNT(*) FROM transaction_contacts tc WHERE tc.transaction_id = t.id) as participant_count,
            (SELECT COUNT(*) FROM audit_packages ap WHERE ap.transaction_id = t.id) as audit_count
          FROM transactions t;
        `);
      },
    },
    {
      version: 31,
      description: "Add failure_log table for offline diagnostics (TASK-2058)",
      migrate: (d) => {
        d.exec(`
          CREATE TABLE IF NOT EXISTS failure_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            operation TEXT NOT NULL,
            error_message TEXT NOT NULL,
            metadata TEXT,
            acknowledged INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_failure_log_timestamp ON failure_log(timestamp);
          CREATE INDEX IF NOT EXISTS idx_failure_log_acknowledged ON failure_log(acknowledged);
        `);
      },
    },
    {
      version: 32,
      description: "Add sync_session_id columns and indexes for ACID rollback on cancelled iPhone sync (TASK-2110)",
      migrate: (d) => {
        const columns: [string, string][] = [
          ["messages", "sync_session_id"],
          ["attachments", "sync_session_id"],
          ["external_contacts", "sync_session_id"],
        ];
        for (const [table, col] of columns) {
          const info = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
          if (!info.some((c) => c.name === col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
          }
        }
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_messages_sync_session ON messages(user_id, sync_session_id);
          CREATE INDEX IF NOT EXISTS idx_attachments_sync_session ON attachments(sync_session_id);
          CREATE INDEX IF NOT EXISTS idx_external_contacts_sync_session ON external_contacts(user_id, sync_session_id);
        `);
      },
    },
    {
      version: 33,
      description: "Update audit_logs CHECK constraint to include all AuditAction values (BACKLOG-1347)",
      migrate: (d) => {
        // SQLite does not support ALTER CHECK, so we must recreate the table.
        // 1. Create new table with updated CHECK constraint
        d.exec(`
          CREATE TABLE IF NOT EXISTS audit_logs_new (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            session_id TEXT,
            action TEXT NOT NULL CHECK (action IN (
              'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'SESSION_REFRESH',
              'TRANSACTION_CREATE', 'TRANSACTION_UPDATE', 'TRANSACTION_DELETE',
              'TRANSACTION_SUBMIT',
              'CONTACT_CREATE', 'CONTACT_UPDATE', 'CONTACT_DELETE',
              'DATA_ACCESS', 'DATA_EXPORT', 'DATA_DELETE',
              'EXPORT_START', 'EXPORT_COMPLETE', 'EXPORT_FAIL',
              'MAILBOX_CONNECT', 'MAILBOX_DISCONNECT',
              'SETTINGS_CHANGE', 'SETTINGS_UPDATE', 'TERMS_ACCEPT'
            )),
            resource_type TEXT,
            resource_id TEXT,
            details TEXT,
            metadata TEXT,
            ip_address TEXT,
            user_agent TEXT,
            success INTEGER DEFAULT 1,
            error_message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            synced_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
          );
        `);

        // 2. Copy existing data
        d.exec(`INSERT OR IGNORE INTO audit_logs_new SELECT * FROM audit_logs;`);

        // 3. Drop old triggers (they reference audit_logs)
        d.exec(`DROP TRIGGER IF EXISTS prevent_audit_update;`);
        d.exec(`DROP TRIGGER IF EXISTS prevent_audit_delete;`);

        // 4. Drop old table
        d.exec(`DROP TABLE IF EXISTS audit_logs;`);

        // 5. Rename new table
        d.exec(`ALTER TABLE audit_logs_new RENAME TO audit_logs;`);

        // 6. Recreate indexes
        d.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_synced ON audit_logs(synced_at);`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type);`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_session_id ON audit_logs(session_id);`);

        // 7. Recreate triggers
        d.exec(`
          CREATE TRIGGER IF NOT EXISTS prevent_audit_update
          BEFORE UPDATE ON audit_logs
          BEGIN
            SELECT RAISE(ABORT, 'Audit logs cannot be modified');
          END;
        `);
        d.exec(`
          CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
          BEFORE DELETE ON audit_logs
          BEGIN
            SELECT RAISE(ABORT, 'Audit logs cannot be deleted');
          END;
        `);
      },
    },
    {
      version: 34,
      description: "Add skip_address_filter column to transactions (BACKLOG-1364)",
      migrate: (d) => {
        const info = d.prepare("PRAGMA table_info(transactions)").all() as { name: string }[];
        if (!info.some((c) => c.name === "skip_address_filter")) {
          d.exec("ALTER TABLE transactions ADD COLUMN skip_address_filter INTEGER DEFAULT 0");
        }
      },
    },
    {
      version: 35,
      description: "Add default_role column to contacts for auto-role feature (BACKLOG-1355)",
      migrate: (d) => {
        const info = d.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
        if (!info.some((c) => c.name === "default_role")) {
          d.exec("ALTER TABLE contacts ADD COLUMN default_role TEXT");
        }
      },
    },
    {
      version: 36,
      description: "Add 'android_sync' to contacts source CHECK constraint (BACKLOG-1470)",
      migrate: (d) => {
        // SQLite doesn't support ALTER CHECK, so recreate the table.
        // 1. Create new table with updated CHECK constraint
        d.exec(`
          CREATE TABLE IF NOT EXISTS contacts_new (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            company TEXT,
            title TEXT,
            source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'email', 'sms', 'contacts_app', 'inferred', 'android_sync')),
            last_inbound_at DATETIME,
            last_outbound_at DATETIME,
            total_messages INTEGER DEFAULT 0,
            tags TEXT,
            is_imported INTEGER DEFAULT 1,
            default_role TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
          );
        `);

        // 2. Copy existing data
        d.exec("INSERT OR IGNORE INTO contacts_new SELECT * FROM contacts;");

        // 3. Drop views and triggers referencing contacts
        d.exec("DROP VIEW IF EXISTS contact_lookup;");
        d.exec("DROP TRIGGER IF EXISTS update_contacts_timestamp;");

        // 4. Drop old table
        d.exec("DROP TABLE IF EXISTS contacts;");

        // 5. Rename new table
        d.exec("ALTER TABLE contacts_new RENAME TO contacts;");

        // 6. Recreate indexes
        d.exec("CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);");
        d.exec("CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name);");
        d.exec("CREATE INDEX IF NOT EXISTS idx_contacts_is_imported ON contacts(is_imported);");
        d.exec("CREATE INDEX IF NOT EXISTS idx_contacts_user_imported ON contacts(user_id, is_imported);");

        // 7. Recreate trigger
        d.exec(`
          CREATE TRIGGER IF NOT EXISTS update_contacts_timestamp
          AFTER UPDATE ON contacts
          BEGIN
            UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
          END;
        `);

        // 8. Recreate contact_lookup view
        d.exec(`
          CREATE VIEW IF NOT EXISTS contact_lookup AS
          SELECT
            c.id as contact_id,
            c.user_id,
            c.display_name,
            ce.email,
            cp.phone_e164 as phone
          FROM contacts c
          LEFT JOIN contact_emails ce ON c.id = ce.contact_id
          LEFT JOIN contact_phones cp ON c.id = cp.contact_id;
        `);
      },
    },
    {
      version: 37,
      description: "Add email_id and thread_id columns to ignored_communications for auto-link suppression (BACKLOG-1560)",
      migrate: (d) => {
        const info = d.prepare("PRAGMA table_info(ignored_communications)").all() as { name: string }[];
        if (!info.some((c) => c.name === "email_id")) {
          d.exec("ALTER TABLE ignored_communications ADD COLUMN email_id TEXT");
        }
        if (!info.some((c) => c.name === "thread_id")) {
          d.exec("ALTER TABLE ignored_communications ADD COLUMN thread_id TEXT");
        }
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_ignored_comms_email_id
            ON ignored_communications(email_id, transaction_id)
            WHERE email_id IS NOT NULL
        `);
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_ignored_comms_thread_id
            ON ignored_communications(thread_id, transaction_id)
            WHERE thread_id IS NOT NULL
        `);
        // Backfill email_id from communications table (if it exists)
        const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='communications'").all();
        if (tables.length > 0) {
          d.exec(`
            UPDATE ignored_communications
            SET email_id = (
              SELECT c.email_id FROM communications c
              WHERE c.id = ignored_communications.original_communication_id
                AND c.email_id IS NOT NULL
            )
            WHERE email_id IS NULL
              AND original_communication_id IS NOT NULL
          `);
        }
      },
    },
    {
      version: 38,
      description: "No-op — Sentry verification moved to separate beta build (BACKLOG-1576)",
      migrate: () => {
        // Originally a deliberate-throw test for Sentry user attribution.
        // Removed to unblock migration 39. Sentry verification will be done
        // via a separate beta build with a standalone test migration.
      },
    },
    {
      version: 39,
      description: "Migrate old provider-prefixed email IDs to UUIDs (BACKLOG-1579 Phase 2)",
      migrate: (d) => {
        // Old records have id like 'outlook:AQMk...' or 'gmail:abc123'
        // New records already have UUID ids from fetchStoreAndDedup.
        // This migration converts old records to UUIDs and updates all FK references.
        const oldEmails = d.prepare(
          "SELECT id, source, external_id FROM emails WHERE id LIKE 'gmail:%' OR id LIKE 'outlook:%'"
        ).all() as { id: string; source: string | null; external_id: string | null }[];

        if (oldEmails.length === 0) return;

        const crypto = require("crypto");

        const updateEmail = d.prepare("UPDATE emails SET id = ?, external_id = ?, source = ? WHERE id = ?");
        const updateComm = d.prepare("UPDATE communications SET email_id = ? WHERE email_id = ?");
        const updateAttach = d.prepare("UPDATE attachments SET email_id = ? WHERE email_id = ?");
        const updateIgnored = d.prepare("UPDATE ignored_communications SET email_id = ? WHERE email_id = ?");

        for (const email of oldEmails) {
          const newId = crypto.randomUUID();
          const colonIdx = email.id.indexOf(":");
          const prefix = email.id.substring(0, colonIdx);   // 'outlook' or 'gmail'
          const externalId = email.id.substring(colonIdx + 1); // the provider message ID

          // Update emails table — set UUID id, ensure external_id and source are populated
          updateEmail.run(
            newId,
            email.external_id || externalId,
            email.source || prefix,
            email.id
          );

          // Update all FK references
          updateComm.run(newId, email.id);
          updateAttach.run(newId, email.id);
          updateIgnored.run(newId, email.id);
        }
      },
    },
    {
      version: 40,
      description: "Add normalized phone lookup columns (BACKLOG-1727)",
      migrate: (d) => {
        const { normalizePhoneLookupKey } = require("../utils/phoneLookupKey");

        // contact_phones: add column + index, backfill from phone_e164
        const cpCols = d.prepare("PRAGMA table_info(contact_phones)").all() as Array<{ name: string }>;
        if (!cpCols.some((c) => c.name === "phone_normalized")) {
          d.exec("ALTER TABLE contact_phones ADD COLUMN phone_normalized TEXT");
        }

        const cpRows = d.prepare(
          "SELECT id, phone_e164 FROM contact_phones WHERE phone_normalized IS NULL"
        ).all() as Array<{ id: string; phone_e164: string }>;
        const cpUpdate = d.prepare("UPDATE contact_phones SET phone_normalized = ? WHERE id = ?");
        for (const row of cpRows) {
          cpUpdate.run(normalizePhoneLookupKey(row.phone_e164), row.id);
        }

        d.exec(
          "CREATE INDEX IF NOT EXISTS idx_contact_phones_normalized ON contact_phones(phone_normalized)"
        );

        // external_contacts: add phones_normalized_json column, backfill from phones_json
        const ecCols = d.prepare("PRAGMA table_info(external_contacts)").all() as Array<{ name: string }>;
        if (!ecCols.some((c) => c.name === "phones_normalized_json")) {
          d.exec("ALTER TABLE external_contacts ADD COLUMN phones_normalized_json TEXT");
        }

        const ecRows = d.prepare(
          "SELECT id, phones_json FROM external_contacts WHERE phones_normalized_json IS NULL"
        ).all() as Array<{ id: string; phones_json: string | null }>;
        const ecUpdate = d.prepare(
          "UPDATE external_contacts SET phones_normalized_json = ? WHERE id = ?"
        );
        for (const row of ecRows) {
          let phones: string[] = [];
          try {
            phones = row.phones_json ? JSON.parse(row.phones_json) : [];
            if (!Array.isArray(phones)) phones = [];
          } catch {
            phones = [];
          }
          const normalized = phones
            .map((p: unknown) => (typeof p === "string" ? normalizePhoneLookupKey(p) : ""))
            .filter((s: string) => s.length > 0);
          ecUpdate.run(JSON.stringify(normalized), row.id);
        }
      },
    },
    {
      version: 41,
      description: "Add email_participants junction table + backfill (BACKLOG-1722)",
      migrate: (d) => {
        const {
          parseEmailAddressList,
          computeParticipantHash,
          // eslint-disable-next-line @typescript-eslint/no-require-imports
        } = require("../utils/emailAddress") as typeof import("../utils/emailAddress");

        // ----- 1. Junction table -------------------------------------------
        d.exec(`
          CREATE TABLE IF NOT EXISTS email_participants (
            email_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'bcc')),
            position INTEGER NOT NULL,
            participant_hash TEXT NOT NULL,
            email_address TEXT NOT NULL,
            display_name TEXT,
            resolved_contact_id TEXT,
            PRIMARY KEY (email_id, role, position),
            FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
          );
        `);

        // BACKLOG-1722: add nullable `classification` to emails as a
        // forward-investment landing zone for future AI classifier output.
        // No consumer today; this avoids a future ALTER. Idempotent via the
        // same PRAGMA table_info pattern v40 uses. Skip silently if the
        // `emails` table is not present (only happens in migration-runner
        // unit tests that seed a partial v29-shape schema).
        const emailsClassCols = d
          .prepare("PRAGMA table_info(emails)")
          .all() as Array<{ name: string }>;
        if (emailsClassCols.length > 0 && !emailsClassCols.some((c) => c.name === "classification")) {
          d.exec("ALTER TABLE emails ADD COLUMN classification TEXT");
        }

        d.exec(
          "CREATE INDEX IF NOT EXISTS idx_email_participants_email_address ON email_participants(email_address);"
        );
        d.exec(
          "CREATE INDEX IF NOT EXISTS idx_email_participants_address_role ON email_participants(email_address, role);"
        );
        d.exec(
          "CREATE INDEX IF NOT EXISTS idx_email_participants_email_id ON email_participants(email_id);"
        );

        // ----- 2. Error table ----------------------------------------------
        d.exec(`
          CREATE TABLE IF NOT EXISTS email_participants_backfill_errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email_id TEXT NOT NULL,
            role TEXT NOT NULL,
            raw_value TEXT,
            reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(email_id, role, raw_value)
          );
        `);

        // ----- 3. Chunked backfill -----------------------------------------
        // The whole migration already runs inside an outer transaction (see
        // _runVersionedMigrations). We deliberately do NOT open inner
        // transactions per chunk: if any chunk throws, the outer tx rolls back
        // the entire migration and we stay at v40. Simpler + safer.
        //
        // Idempotency: INSERT OR IGNORE on PK (email_id, role, position).
        // Chunk size: 500 rows fits the page cache + parser/insert overhead
        // and keeps per-iteration memory bounded.
        //
        // Defensive: skip the backfill if the `emails` table does not exist
        // in this DB. That only happens in migration-runner unit tests that
        // seed a partial v29-shape schema without the emails table; real
        // user DBs always have it.
        const emailsTableExists = d
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emails'")
          .get();
        if (!emailsTableExists) {
          // BACKLOG-1722 (SR follow-up): warn so a real-world hit on this
          // silent-skip path is diagnosable (unit-test harnesses seed a
          // partial v29-shape schema without `emails`, so this is expected
          // there — but in production it would mean a corrupt DB).
          // eslint-disable-next-line no-console
          console.warn(
            "[migration v41] skipping backfill: `emails` table not present (expected only in migration-runner unit tests)"
          );
          return;
        }

        const CHUNK_SIZE = 500;

        const selectStmt = d.prepare(
          `SELECT id, sender, recipients, cc, bcc FROM emails
           WHERE id > ? ORDER BY id LIMIT ${CHUNK_SIZE}`
        );
        const insertParticipantStmt = d.prepare(
          `INSERT OR IGNORE INTO email_participants
             (email_id, role, position, participant_hash, email_address, display_name)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        const insertErrorStmt = d.prepare(
          `INSERT OR IGNORE INTO email_participants_backfill_errors
             (email_id, role, raw_value, reason)
           VALUES (?, ?, ?, ?)`
        );

        const FIELDS: Array<{ col: keyof EmailBackfillRow; role: "from" | "to" | "cc" | "bcc" }> = [
          { col: "sender", role: "from" },
          { col: "recipients", role: "to" },
          { col: "cc", role: "cc" },
          { col: "bcc", role: "bcc" },
        ];

        interface EmailBackfillRow {
          id: string;
          sender: string | null;
          recipients: string | null;
          cc: string | null;
          bcc: string | null;
        }

        // I1 (BACKLOG-1722): log per-chunk progress so large mailboxes show
        // activity during the startup migration. logService is async; use
        // console.log inside this synchronous migrate() callback.
        const totalRows = (d.prepare("SELECT COUNT(*) AS c FROM emails").get() as { c: number }).c;
        // eslint-disable-next-line no-console
        console.log(`[migration v41] email participants backfill: ${totalRows} emails to process`);

        // I2 (BACKLOG-1722): keyset pagination — O(n) vs O(n²) for OFFSET.
        let lastId = "";
        let totalProcessed = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const rows = selectStmt.all(lastId) as EmailBackfillRow[];
          if (rows.length === 0) break;

          totalProcessed += rows.length;
          // eslint-disable-next-line no-console
          console.log(
            `[migration v41] email participants backfill: ${totalProcessed} / ${totalRows} rows processed`
          );

          for (const row of rows) {
            for (const field of FIELDS) {
              const raw = row[field.col];
              if (!raw) continue;
              const parsed = parseEmailAddressList(raw);
              parsed.addresses.forEach((addr, idx) => {
                insertParticipantStmt.run(
                  row.id,
                  field.role,
                  idx,
                  computeParticipantHash(row.id, field.role, idx, addr.email_address),
                  addr.email_address,
                  addr.display_name
                );
              });
              for (const err of parsed.errors) {
                insertErrorStmt.run(row.id, field.role, err.raw, err.reason);
              }
            }
          }

          lastId = rows[rows.length - 1].id;
          if (rows.length < CHUNK_SIZE) break;
        }
        // eslint-disable-next-line no-console
        console.log(`[migration v41] email participants backfill complete: ${totalProcessed} rows`);
      },
    },
    {
      version: 42,
      description: "Backfill communications.thread_id from emails table for auto-linked rows (BACKLOG-1718 R3)",
      migrate: (d) => {
        // BACKLOG-1718 (R3): autoLinkService was inserting communications rows
        // with email_id set but thread_id = NULL.  The unlink path gates
        // thread-expansion on thread_id being present, so deleting one email
        // only removed a single row.  This backfill resolves thread_id for
        // every pre-fix row so that unlink now correctly expands to siblings.
        //
        // Idempotent: the WHERE clause skips rows that already have thread_id
        // or whose joined email has no thread_id.
        // Safe: UPDATE only, no schema changes.
        d.exec(`
          UPDATE communications
          SET thread_id = (
            SELECT e.thread_id
            FROM emails e
            WHERE e.id = communications.email_id
          )
          WHERE email_id IS NOT NULL
            AND email_id != ''
            AND (thread_id IS NULL OR thread_id = '')
            AND (
              SELECT e.thread_id
              FROM emails e
              WHERE e.id = communications.email_id
            ) IS NOT NULL
        `);
        // eslint-disable-next-line no-console
        console.log("[migration v42] communications.thread_id backfill complete (BACKLOG-1718 R3)");
      },
    },
    {
      version: 43,
      description:
        "Harden communications + ignored_communications: XOR CHECK, email thread_id trigger, real FK cascades, dedup unique index (BACKLOG-1768)",
      migrate: (d) => {
        // BACKLOG-1768 (DB hardening S1). SQLite cannot ALTER-in a CHECK/FK, so both
        // tables are recreated (precedent: v36 contacts recreate).
        //
        // Design decisions (documented in the PR / BACKLOG-1768):
        //  1. CHECK = "exactly one of message_id / email_id, OR thread_id alone". A strict
        //     message XOR email would reject the LIVE thread-only link path
        //     (autoLinkService.createThreadCommunicationReference — SMS thread batch links
        //     carry neither message_id nor email_id), so thread-only rows stay valid.
        //     It rejects both-set (message AND email) and neither-set (links to nothing).
        //  2. "email rows must carry thread_id" cannot be a CHECK (no subqueries), so it is
        //     a BEFORE INSERT trigger that fires only when the linked email actually has a
        //     thread_id (NULLIF guards legacy '' thread_ids so the primary writer, which
        //     inserts `emailRow.thread_id || null`, is never falsely rejected). Created
        //     AFTER the historical copy so legacy rows are not re-validated; the backfill
        //     below fixes them forward.
        //  3. transaction_id FK becomes ON DELETE CASCADE (was SET NULL) so link rows die
        //     with their transaction (deleteTransaction is a bare DELETE that relies on FK
        //     actions). Nullable-at-insert is unchanged.
        //  4. ignored_communications.email_id gains a real FK (was convention-only).
        //
        // defer_foreign_keys makes the multi-step recreate safe under foreign_keys=ON
        // (auto-resets at COMMIT). CHECK is always immediate, so both-set garbage rows are
        // filtered out of the copy explicitly.
        d.pragma("defer_foreign_keys = ON");

        // (1) Backfill thread_id for email rows FIRST (idempotent; same shape as v42) so no
        // surviving email row violates the thread_id invariant after recreate.
        d.exec(`
          UPDATE communications
          SET thread_id = (
            SELECT e.thread_id FROM emails e WHERE e.id = communications.email_id
          )
          WHERE email_id IS NOT NULL
            AND email_id != ''
            AND (thread_id IS NULL OR thread_id = '')
            AND (
              SELECT e.thread_id FROM emails e WHERE e.id = communications.email_id
            ) IS NOT NULL
        `);

        // (2) Null dangling ignored_communications.email_id refs (the column had no FK
        // before, so it may point at deleted emails). Preserve the row + its display cache.
        const danglingIgnored =
          (
            d
              .prepare(
                `SELECT COUNT(*) AS n FROM ignored_communications
               WHERE email_id IS NOT NULL AND email_id NOT IN (SELECT id FROM emails)`
              )
              .get() as { n: number } | undefined
          )?.n ?? 0;
        if (danglingIgnored > 0) {
          d.exec(
            `UPDATE ignored_communications SET email_id = NULL
             WHERE email_id IS NOT NULL AND email_id NOT IN (SELECT id FROM emails)`
          );
          // eslint-disable-next-line no-console
          console.log(
            `[migration v43] nulled ${danglingIgnored} dangling ignored_communications.email_id ref(s) (BACKLOG-1768)`
          );
        }

        // (3) Count both-set garbage rows the new CHECK will drop (message AND email set).
        const bothSet =
          (
            d
              .prepare(
                `SELECT COUNT(*) AS n FROM communications
               WHERE message_id IS NOT NULL AND email_id IS NOT NULL`
              )
              .get() as { n: number } | undefined
          )?.n ?? 0;
        if (bothSet > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[migration v43] dropping ${bothSet} garbage communications row(s) with BOTH message_id and email_id set (BACKLOG-1768)`
          );
        }

        // (4) Recreate communications with the hardened shape.
        //     CREATE body kept byte-for-byte in sync with electron/database/schema.sql.
        d.exec(`ALTER TABLE communications RENAME TO communications_old`);
        d.exec(`
CREATE TABLE IF NOT EXISTS communications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT,                     -- Nullable: may link content before transaction exists

  -- Link to content (exactly one of message_id / email_id; or thread_id alone)
  message_id TEXT,                         -- FK to messages (for texts)
  email_id TEXT,                           -- FK to emails (for emails)
  thread_id TEXT,                          -- For batch-linking all texts in a thread

  -- Link metadata
  link_source TEXT CHECK (link_source IN ('auto', 'manual', 'scan')),
  link_confidence REAL,
  linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys (BACKLOG-1768: transaction_id CASCADE — link rows die with their transaction)
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,

  -- BACKLOG-1768: reject both-set (message AND email) and neither-set (links to nothing)
  CHECK (
    (message_id IS NOT NULL AND email_id IS NULL)
    OR (email_id IS NOT NULL AND message_id IS NULL)
    OR (message_id IS NULL AND email_id IS NULL AND thread_id IS NOT NULL)
  )
);`);
        // Copy every row EXCEPT both-set garbage (all survivors satisfy the new CHECK).
        d.exec(`
          INSERT INTO communications (
            id, user_id, transaction_id, message_id, email_id, thread_id,
            link_source, link_confidence, linked_at, created_at
          )
          SELECT
            id, user_id, transaction_id, message_id, email_id, thread_id,
            link_source, link_confidence, linked_at, created_at
          FROM communications_old
          WHERE NOT (message_id IS NOT NULL AND email_id IS NOT NULL)
        `);
        d.exec(`DROP TABLE communications_old`);

        // Recreate indexes (idx_comm_email_txn predicate tightened — BACKLOG-1768).
        d.exec(`CREATE INDEX IF NOT EXISTS idx_communications_user_id ON communications(user_id)`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_communications_transaction_id ON communications(transaction_id)`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_communications_message_id ON communications(message_id)`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_communications_email_id ON communications(email_id)`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_communications_thread_id ON communications(thread_id)`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_communications_txn_msg ON communications(transaction_id, message_id)`);
        d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_msg_txn ON communications(message_id, transaction_id) WHERE message_id IS NOT NULL`);
        d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_email_txn ON communications(email_id, transaction_id) WHERE email_id IS NOT NULL AND transaction_id IS NOT NULL`);
        d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_thread_txn ON communications(thread_id, transaction_id) WHERE thread_id IS NOT NULL AND message_id IS NULL AND email_id IS NULL`);

        // Trigger created AFTER the copy so historical rows are not re-validated.
        // Body kept byte-for-byte in sync with electron/database/schema.sql.
        d.exec(`
CREATE TRIGGER IF NOT EXISTS communications_email_thread_required
BEFORE INSERT ON communications
FOR EACH ROW
WHEN NEW.email_id IS NOT NULL
  AND NULLIF(NEW.thread_id, '') IS NULL
  AND NULLIF((SELECT thread_id FROM emails WHERE id = NEW.email_id), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'communications.thread_id required: linked email has a thread_id (BACKLOG-1768)');
END;`);

        // (5) Recreate ignored_communications with the real email_id FK.
        //     CREATE body kept byte-for-byte in sync with electron/database/schema.sql.
        d.exec(`ALTER TABLE ignored_communications RENAME TO ignored_communications_old`);
        d.exec(`
CREATE TABLE IF NOT EXISTS ignored_communications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,

  -- Denormalized display/match cache (BACKLOG-1768): NOT authoritative — retained to
  -- match incoming emails during scans. email_id below is the real reference.
  email_subject TEXT,
  email_sender TEXT,
  email_sent_at TEXT,
  email_thread_id TEXT,

  -- BACKLOG-1560: Direct ID references for reliable suppression during auto-link
  email_id TEXT,                          -- FK to emails table (for email suppression)
  thread_id TEXT,                         -- Thread ID (for text message thread suppression)

  -- Original communication reference (if available)
  original_communication_id TEXT,

  -- Reason for ignoring (optional user note)
  reason TEXT,

  ignored_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- BACKLOG-1768: email_id gains a real FK (was convention-only) so suppression rows
  -- are cleaned up when their email is deleted.
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);`);
        d.exec(`
          INSERT INTO ignored_communications (
            id, user_id, transaction_id, email_subject, email_sender, email_sent_at,
            email_thread_id, email_id, thread_id, original_communication_id, reason, ignored_at
          )
          SELECT
            id, user_id, transaction_id, email_subject, email_sender, email_sent_at,
            email_thread_id, email_id, thread_id, original_communication_id, reason, ignored_at
          FROM ignored_communications_old
        `);
        d.exec(`DROP TABLE ignored_communications_old`);

        // Recreate ignored_communications indexes (base + BACKLOG-1560 suppression lookups).
        d.exec(`CREATE INDEX IF NOT EXISTS idx_ignored_comms_user_email ON ignored_communications(user_id, email_sender, email_subject, email_sent_at)`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_ignored_comms_transaction ON ignored_communications(transaction_id)`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_ignored_comms_email_id ON ignored_communications(email_id, transaction_id) WHERE email_id IS NOT NULL`);
        d.exec(`CREATE INDEX IF NOT EXISTS idx_ignored_comms_thread_id ON ignored_communications(thread_id, transaction_id) WHERE thread_id IS NOT NULL`);

        // eslint-disable-next-line no-console
        console.log("[migration v43] communications + ignored_communications hardened (BACKLOG-1768)");
      },
    },
    {
      version: 44,
      description:
        "Message-ID stable identity: ensure emails.message_id_header + convert its dedup index from UNIQUE to NON-unique (BACKLOG-1769)",
      migrate: (d) => {
        // BACKLOG-1769 (DB hardening S2). The RFC 5322 Message-ID is the identity
        // that survives re-delivery: a re-delivered message gets a NEW provider id
        // but keeps its Message-ID. That is the ghost-resurrection root cause
        // (BACKLOG-1764) — dedup-by-external-id cannot catch it, dedup-by-Message-ID
        // can. This migration makes the column + index reliable; emailSyncService
        // (same PR) populates the column and dedups on it.
        //
        // The `message_id_header` column and a UNIQUE partial index on
        // (user_id, message_id_header) both shipped in schema.sql when the emails
        // table was created (TASK-1300). schema.sql is re-exec'd (IF NOT EXISTS) on
        // every startup BEFORE the migration runner, so in production the column
        // already exists and holds NULLs (ingest never wrote it). This migration is
        // still required to:
        //   1. Guarantee the column on any DB that reaches the runner without it
        //      (the migration test harness's minimal emails fixture; drift safety).
        //   2. DOWNGRADE the index from UNIQUE to NON-unique.
        //
        // Why NON-unique (documented per BACKLOG-1769):
        //   - Legacy rows may hold TRUE duplicates (the known ghost pairs) — a UNIQUE
        //     index cannot be built over them, and any header backfill would throw.
        //   - (user_id, message_id_header) is the WRONG uniqueness scope for
        //     multi-account: the same message fetched into two accounts of one user
        //     shares a Message-ID and would collide. The Phase-2 lifecycle design
        //     intentionally RE-SCOPES uniqueness per account
        //     (UNIQUE(account_id, message_id_header)); account_id is hardcoded NULL
        //     today, so per-account uniqueness cannot be enforced yet.
        //   - Dedup is enforced at the WRITER instead (emailSyncService: same
        //     Message-ID → update external_id in place rather than insert a 2nd row).
        //
        // No data backfill: a row's OWN Message-ID is not recoverable from anything
        // stored locally (external_id is the provider id; in_reply_to/references_header
        // are ancestors' IDs; raw headers are not retained). Existing NULL rows stay
        // NULL; new ingests populate the column going forward. Index/CREATE body kept
        // byte-for-byte in sync with electron/database/schema.sql.

        const cols = d.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>;
        const hasHeaderCol = cols.some((c) => c.name === "message_id_header");
        if (!hasHeaderCol) {
          d.exec("ALTER TABLE emails ADD COLUMN message_id_header TEXT");
          // eslint-disable-next-line no-console
          console.log("[migration v44] added emails.message_id_header column (BACKLOG-1769)");
        }

        // Replace the schema-inception UNIQUE index with a NON-unique one. DROP is
        // safe: the partial index is empty today (every row's message_id_header is
        // NULL), so nothing is lost, and relaxing a constraint never fails.
        d.exec("DROP INDEX IF EXISTS idx_emails_message_id_header");
        d.exec(
          "CREATE INDEX IF NOT EXISTS idx_emails_message_id_header ON emails(user_id, message_id_header) WHERE message_id_header IS NOT NULL"
        );

        // eslint-disable-next-line no-console
        console.log("[migration v44] emails.message_id_header index is now NON-unique (BACKLOG-1769)");
      },
    },
  ];

  static validateNoDuplicateVersions(migrations: MigrationEntry[]): void {
    const seen = new Set<number>();
    const duplicates: number[] = [];
    for (const m of migrations) {
      if (seen.has(m.version)) duplicates.push(m.version);
      seen.add(m.version);
    }
    if (duplicates.length > 0) {
      throw new Error(`Duplicate migration versions detected: ${[...new Set(duplicates)].join(", ")}`);
    }
  }

  static validateNoVersionGaps(migrations: MigrationEntry[]): void {
    if (migrations.length === 0) return;
    const versions = migrations.map((m) => m.version).sort((a, b) => a - b);
    for (let i = 1; i < versions.length; i++) {
      if (versions[i] !== versions[i - 1] + 1) {
        const gap = `Missing migration version ${versions[i - 1] + 1} (found ${versions[i - 1]} -> ${versions[i]})`;
        throw new Error(`Migration sequence error: ${gap}`);
      }
    }
  }

  _ensureSchemaVersionTable(currentDb: DatabaseType): void {
    const schemaVersionExists = currentDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get();

    if (!schemaVersionExists) {
      currentDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL DEFAULT 1,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          migrated_at TEXT DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ${DatabaseService.BASELINE_VERSION});
      `);
    } else {
      const columns = currentDb.prepare("PRAGMA table_info(schema_version)").all() as Array<{ name: string }>;
      const hasMigratedAt = columns.some((c) => c.name === "migrated_at");
      if (!hasMigratedAt) {
        currentDb.exec("ALTER TABLE schema_version ADD COLUMN migrated_at TEXT");
      }
    }
  }

  async _runVersionedMigrations(dryRun: boolean = false): Promise<MigrationPlan | void> {
    const currentDb = this._ensureDb();
    const migrations = DatabaseService.MIGRATIONS;

    DatabaseService.validateNoDuplicateVersions(migrations);
    DatabaseService.validateNoVersionGaps(migrations);

    this._ensureSchemaVersionTable(currentDb);

    const currentVersion = (
      currentDb.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
        { version: number } | undefined
    )?.version || 0;

    if (currentVersion > 0 && currentVersion < DatabaseService.BASELINE_VERSION) {
      await logService.warn(
        `DB version ${currentVersion} is below baseline ${DatabaseService.BASELINE_VERSION}. Schema.sql should handle this.`,
        "DatabaseService"
      );
    }

    const pendingMigrations = migrations.filter((m) => m.version > currentVersion);
    const targetVersion = pendingMigrations.length > 0
      ? pendingMigrations[pendingMigrations.length - 1].version
      : currentVersion;

    if (dryRun) {
      return {
        currentVersion,
        targetVersion,
        pendingMigrations: pendingMigrations.map((m) => ({
          version: m.version,
          description: m.description,
        })),
        wouldRunCount: pendingMigrations.length,
      };
    }

    if (pendingMigrations.length > 0 && this.dbPath && fs.existsSync(this.dbPath)) {
      const dbDir = path.dirname(this.dbPath);
      const dbName = path.basename(this.dbPath, ".db");
      const backupFiles = fs.existsSync(dbDir)
        ? fs.readdirSync(dbDir).filter((f) => f.startsWith(`${dbName}-backup-`) && f.endsWith(".db"))
        : [];

      if (backupFiles.length === 0) {
        await logService.error(
          "No pre-migration backup found. Refusing to run migrations.",
          "DatabaseService"
        );
        throw new Error("Pre-migration backup required but not found");
      }
    }

    for (const m of pendingMigrations) {
      await logService.info(`Running migration ${m.version}: ${m.description}`, "DatabaseService");
      try {
        const runInTransaction = currentDb.transaction(() => {
          m.migrate(currentDb);
          currentDb.prepare(
            "UPDATE schema_version SET version = ?, updated_at = CURRENT_TIMESTAMP, migrated_at = datetime('now') WHERE id = 1"
          ).run(m.version);
        });
        runInTransaction();
        await logService.info(`Migration ${m.version} completed: ${m.description}`, "DatabaseService");
      } catch (error) {
        await logService.error(
          `Migration ${m.version} FAILED: ${m.description}`,
          "DatabaseService",
          { error: error instanceof Error ? error.message : String(error) }
        );
        throw new Error(
          `Migration ${m.version} (${m.description}) failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `Database remains at version ${m.version - 1}. Pre-migration backup available.`
        );
      }
    }

    if (currentVersion < DatabaseService.BASELINE_VERSION) {
      currentDb.exec(
        `UPDATE schema_version SET version = ${DatabaseService.BASELINE_VERSION}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
      );
    }

    await logService.info("All database migrations completed successfully", "DatabaseService");
  }

  // ============================================
  // USER OPERATIONS (Delegate to userDbService)
  // ============================================

  async createUser(userData: NewUser & { id?: string }): Promise<User> {
    return userDb.createUser(userData);
  }

  async getUserById(userId: string): Promise<User | null> {
    return userDb.getUserById(userId);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return userDb.getUserByEmail(email);
  }

  async getUserByOAuthId(provider: OAuthProvider, oauthId: string): Promise<User | null> {
    return userDb.getUserByOAuthId(provider, oauthId);
  }

  async updateUser(userId: string, updates: Partial<User>): Promise<void> {
    return userDb.updateUser(userId, updates);
  }

  async deleteUser(userId: string): Promise<void> {
    return userDb.deleteUser(userId);
  }

  async updateLastLogin(userId: string): Promise<void> {
    return userDb.updateLastLogin(userId);
  }

  async acceptTerms(userId: string, termsVersion: string, privacyVersion: string): Promise<User> {
    return userDb.acceptTerms(userId, termsVersion, privacyVersion);
  }

  async completeEmailOnboarding(userId: string): Promise<void> {
    return userDb.completeEmailOnboarding(userId);
  }

  async hasCompletedEmailOnboarding(userId: string): Promise<boolean> {
    return userDb.hasCompletedEmailOnboarding(userId);
  }

  async migrateUserIdForUnification(oldUserId: string, newUserId: string): Promise<void> {
    return userDb.migrateUserIdForUnification(oldUserId, newUserId);
  }

  // ============================================
  // SESSION OPERATIONS (Delegate to sessionDbService)
  // ============================================

  async createSession(userId: string): Promise<string> {
    return sessionDb.createSession(userId);
  }

  async validateSession(sessionToken: string): Promise<(Session & User) | null> {
    return sessionDb.validateSession(sessionToken);
  }

  async deleteSession(sessionToken: string): Promise<void> {
    return sessionDb.deleteSession(sessionToken);
  }

  async deleteAllUserSessions(userId: string): Promise<void> {
    return sessionDb.deleteAllUserSessions(userId);
  }

  async clearAllSessions(): Promise<void> {
    return sessionDb.clearAllSessions();
  }

  async clearAllOAuthTokens(): Promise<void> {
    return oauthDb.clearAllOAuthTokens();
  }

  // ============================================
  // CONTACT OPERATIONS (Delegate to contactDbService + messageDbService)
  // ============================================

  async createContact(contactData: NewContact): Promise<Contact> {
    return contactDb.createContact(contactData);
  }

  createContactsBatch(
    contacts: Parameters<typeof contactDb.createContactsBatch>[0],
    onProgress?: (current: number, total: number) => void
  ): string[] {
    return contactDb.createContactsBatch(contacts, onProgress);
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    return contactDb.getContactById(contactId);
  }

  async findContactByName(userId: string, name: string): Promise<Contact | null> {
    return contactDb.findContactByName(userId, name);
  }

  async getContacts(filters?: ContactFilters): Promise<Contact[]> {
    return contactDb.getContacts(filters);
  }

  async getImportedContactsByUserId(userId: string): Promise<Contact[]> {
    return contactDb.getImportedContactsByUserId(userId);
  }

  async getImportedContactsByUserIdAsync(userId: string): Promise<Contact[]> {
    return contactDb.getImportedContactsByUserIdAsync(userId);
  }

  async getUnimportedContactsByUserId(userId: string): Promise<Contact[]> {
    return contactDb.getUnimportedContactsByUserId(userId);
  }

  async markContactAsImported(contactId: string, source?: string): Promise<void> {
    return contactDb.markContactAsImported(contactId, source);
  }

  async backfillContactEmails(contactId: string, emails: string[]): Promise<number> {
    return contactDb.backfillContactEmails(contactId, emails);
  }

  async backfillContactPhones(contactId: string, phones: string[]): Promise<number> {
    return contactDb.backfillContactPhones(contactId, phones);
  }

  async getContactsSortedByActivity(userId: string, propertyAddress?: string): Promise<contactDb.ContactWithActivity[]> {
    return contactDb.getContactsSortedByActivity(userId, propertyAddress);
  }

  async backfillContactCommunicationDates(userId: string): Promise<number> {
    return contactDb.backfillContactCommunicationDates(userId);
  }

  async searchContacts(query: string, userId: string): Promise<Contact[]> {
    return contactDb.searchContacts(query, userId);
  }

  searchContactsForSelection(userId: string, query: string, limit?: number): contactDb.ContactWithActivity[] {
    return contactDb.searchContactsForSelection(userId, query, limit);
  }

  async updateContact(contactId: string, updates: Partial<Contact>): Promise<void> {
    return contactDb.updateContact(contactId, updates);
  }

  async getTransactionsByContact(contactId: string): Promise<contactDb.TransactionWithRoles[]> {
    return contactDb.getTransactionsByContact(contactId);
  }

  async deleteContact(contactId: string): Promise<void> {
    return contactDb.deleteContact(contactId);
  }

  async getContactByPhone(phone: string): Promise<{ id: string; display_name: string; phone: string } | null> {
    return contactDb.getContactByPhone(phone);
  }

  /**
   * Synchronous phone lookup scoped by user_id (BACKLOG-1469).
   * Used by Android contact promotion to check for duplicates.
   */
  findContactByNormalizedPhone(userId: string, normalizedPhone: string): { id: string; display_name: string } | null {
    return contactDb.findContactByNormalizedPhone(userId, normalizedPhone);
  }

  getLastMessageDateForPhone(userId: string, normalizedPhone: string): string | null {
    return messageDb.getLastMessageDateForPhone(userId, normalizedPhone);
  }

  getLastMessageDatesForPhones(userId: string, phones: string[]): Map<string, string> {
    return messageDb.getLastMessageDatesForPhones(userId, phones);
  }

  async backfillPhoneLastMessageTable(userId: string): Promise<number> {
    return messageDb.backfillPhoneLastMessageTable(userId);
  }

  async getContactNamesByPhones(phones: string[]): Promise<Map<string, string>> {
    return contactDb.getContactNamesByPhones(phones);
  }

  async removeContact(contactId: string): Promise<void> {
    return contactDb.removeContact(contactId);
  }

  async getOrCreateContactFromEmail(userId: string, email: string, name?: string): Promise<Contact> {
    return contactDb.getOrCreateContactFromEmail(userId, email, name);
  }

  // ============================================
  // OAUTH TOKEN OPERATIONS (Delegate to oauthTokenDbService)
  // ============================================

  async saveOAuthToken(userId: string, provider: OAuthProvider, purpose: OAuthPurpose, tokenData: Partial<OAuthToken>): Promise<string> {
    return oauthDb.saveOAuthToken(userId, provider, purpose, tokenData);
  }

  async getOAuthToken(userId: string, provider: OAuthProvider, purpose: OAuthPurpose): Promise<OAuthToken | null> {
    return oauthDb.getOAuthToken(userId, provider, purpose);
  }

  async updateOAuthToken(tokenId: string, updates: Partial<OAuthToken>): Promise<void> {
    return oauthDb.updateOAuthToken(tokenId, updates);
  }

  async deleteOAuthToken(userId: string, provider: OAuthProvider, purpose: OAuthPurpose): Promise<void> {
    return oauthDb.deleteOAuthToken(userId, provider, purpose);
  }

  async getOAuthTokenSyncTime(userId: string, provider: OAuthProvider): Promise<Date | null> {
    return oauthDb.getOAuthTokenSyncTime(userId, provider);
  }

  async updateOAuthTokenSyncTime(userId: string, provider: OAuthProvider, syncTime: Date): Promise<void> {
    return oauthDb.updateOAuthTokenSyncTime(userId, provider, syncTime);
  }

  // ============================================
  // TRANSACTION OPERATIONS (Delegate to transactionDbService)
  // ============================================

  async createTransaction(transactionData: NewTransaction): Promise<Transaction> {
    return transactionDb.createTransaction(transactionData);
  }

  async getTransactions(filters?: TransactionFilters): Promise<Transaction[]> {
    return transactionDb.getTransactions(filters);
  }

  getPendingTransactionCount(userId: string): number {
    return transactionDb.getPendingTransactionCount(userId);
  }

  async getTransactionById(transactionId: string): Promise<Transaction | null> {
    return transactionDb.getTransactionById(transactionId);
  }

  async getTransactionWithContacts(transactionId: string): Promise<TransactionWithContacts | null> {
    return transactionDb.getTransactionWithContacts(transactionId);
  }

  async updateTransaction(transactionId: string, updates: Partial<Transaction>): Promise<void> {
    return transactionDb.updateTransaction(transactionId, updates);
  }

  async deleteTransaction(transactionId: string): Promise<void> {
    return transactionDb.deleteTransaction(transactionId);
  }

  async findExistingTransactionsByAddresses(
    userId: string,
    propertyAddresses: string[],
  ): Promise<Map<string, string>> {
    return transactionDb.findExistingTransactionsByAddresses(userId, propertyAddresses);
  }

  // ============================================
  // COMMUNICATION OPERATIONS (Delegate to communicationDbService)
  // ============================================

  async createCommunication(communicationData: NewCommunication): Promise<Communication> {
    return communicationDb.createCommunication(communicationData);
  }

  async getCommunicationById(communicationId: string): Promise<Communication | null> {
    return communicationDb.getCommunicationById(communicationId);
  }

  async getCommunications(filters?: CommunicationFilters): Promise<Communication[]> {
    return communicationDb.getCommunications(filters);
  }

  async getCommunicationsByTransaction(transactionId: string, channelFilter?: "email" | "text", limit?: number): Promise<Communication[]> {
    return communicationDb.getCommunicationsWithMessages(transactionId, channelFilter, limit);
  }

  async updateCommunication(communicationId: string, updates: Partial<Communication>): Promise<void> {
    return communicationDb.updateCommunication(communicationId, updates);
  }

  async deleteCommunication(communicationId: string): Promise<void> {
    return communicationDb.deleteCommunication(communicationId);
  }

  async deleteCommunicationByMessageId(messageId: string): Promise<void> {
    return communicationDb.deleteCommunicationByMessageId(messageId);
  }

  async deleteCommunicationByThread(threadId: string, transactionId: string): Promise<void> {
    return communicationDb.deleteCommunicationByThread(threadId, transactionId);
  }

  async addIgnoredCommunication(data: NewIgnoredCommunication): Promise<IgnoredCommunication> {
    return communicationDb.addIgnoredCommunication(data);
  }

  async getIgnoredCommunicationsByTransaction(transactionId: string): Promise<IgnoredCommunication[]> {
    return communicationDb.getIgnoredCommunicationsByTransaction(transactionId);
  }

  async getIgnoredCommunicationsByUser(userId: string): Promise<IgnoredCommunication[]> {
    return communicationDb.getIgnoredCommunicationsByUser(userId);
  }

  async isEmailIgnoredForTransaction(transactionId: string, emailSender: string, emailSubject: string, emailSentAt: string): Promise<boolean> {
    return communicationDb.isEmailIgnoredForTransaction(transactionId, emailSender, emailSubject, emailSentAt);
  }

  async isEmailIgnoredByUser(userId: string, emailSender: string, emailSubject: string, emailSentAt: string): Promise<boolean> {
    return communicationDb.isEmailIgnoredByUser(userId, emailSender, emailSubject, emailSentAt);
  }

  async removeIgnoredCommunication(ignoredCommId: string): Promise<void> {
    return communicationDb.removeIgnoredCommunication(ignoredCommId);
  }

  async linkCommunicationToTransaction(communicationId: string, transactionId: string): Promise<void> {
    return communicationDb.linkCommunicationToTransaction(communicationId, transactionId);
  }

  async saveExtractedData(transactionId: string, fieldName: string, fieldValue: string, sourceCommId?: string, confidence?: number): Promise<string> {
    return communicationDb.saveExtractedData(transactionId, fieldName, fieldValue, sourceCommId, confidence);
  }

  // ============================================
  // TRANSACTION CONTACT OPERATIONS (Delegate to transactionContactDbService)
  // ============================================

  async linkContactToTransaction(transactionId: string, contactId: string, role?: string): Promise<void> {
    return transactionContactDb.linkContactToTransaction(transactionId, contactId, role);
  }

  async assignContactToTransaction(transactionId: string, data: transactionContactDb.TransactionContactData): Promise<string> {
    return transactionContactDb.assignContactToTransaction(transactionId, data);
  }

  async getTransactionContacts(transactionId: string): Promise<Contact[]> {
    return transactionContactDb.getTransactionContacts(transactionId);
  }

  async getTransactionContactsWithRoles(transactionId: string): Promise<transactionContactDb.TransactionContactResult[]> {
    return transactionContactDb.getTransactionContactsWithRoles(transactionId);
  }

  async getTransactionContactsByRole(transactionId: string, role: string): Promise<transactionContactDb.TransactionContactResult[]> {
    return transactionContactDb.getTransactionContactsByRole(transactionId, role);
  }

  async updateContactRole(transactionId: string, contactId: string, updates: Partial<transactionContactDb.TransactionContactData>): Promise<void> {
    return transactionContactDb.updateContactRole(transactionId, contactId, updates);
  }

  async unlinkContactFromTransaction(transactionId: string, contactId: string): Promise<void> {
    return transactionContactDb.unlinkContactFromTransaction(transactionId, contactId);
  }

  async isContactAssignedToTransaction(transactionId: string, contactId: string): Promise<boolean> {
    return transactionContactDb.isContactAssignedToTransaction(transactionId, contactId);
  }

  async batchUpdateContactAssignments(transactionId: string, operations: transactionContactDb.ContactAssignmentOperation[]): Promise<void> {
    return transactionContactDb.batchUpdateContactAssignments(transactionId, operations);
  }

  // ============================================
  // USER FEEDBACK OPERATIONS (Delegate to feedbackDbService)
  // ============================================

  async saveFeedback(feedbackData: Omit<UserFeedback, "id" | "created_at">): Promise<UserFeedback> {
    return feedbackDb.saveFeedback(feedbackData);
  }

  async getFeedbackByTransaction(transactionId: string): Promise<UserFeedback[]> {
    return feedbackDb.getFeedbackByTransaction(transactionId);
  }

  async getFeedbackByField(userId: string, fieldName: string, limit: number = 100): Promise<UserFeedback[]> {
    return feedbackDb.getFeedbackByField(userId, fieldName, limit);
  }

  // ============================================
  // AUDIT LOG OPERATIONS (Delegate to auditLogDbService)
  // ============================================

  async insertAuditLog(entry: AuditLogEntry): Promise<void> {
    return auditDb.insertAuditLog(entry);
  }

  async getUnsyncedAuditLogs(limit: number = 100): Promise<AuditLogEntry[]> {
    return auditDb.getUnsyncedAuditLogs(limit);
  }

  async markAuditLogsSynced(ids: string[]): Promise<void> {
    return auditDb.markAuditLogsSynced(ids);
  }

  async getAuditLogs(filters: auditDb.AuditLogFilters): Promise<AuditLogEntry[]> {
    return auditDb.getAuditLogs(filters);
  }

  // ============================================
  // LLM ANALYSIS OPERATIONS (Delegate to messageDbService)
  // ============================================

  async getMessagesForLLMAnalysis(userId: string, limit = 100): Promise<Message[]> {
    return messageDb.getMessagesForLLMAnalysis(userId, limit);
  }

  async getPendingLLMAnalysisCount(userId: string): Promise<number> {
    return messageDb.getPendingLLMAnalysisCount(userId);
  }

  // ============================================
  // MESSAGES TABLE OPERATIONS (Delegate to messageDbService)
  // ============================================

  async getUnlinkedTextMessages(userId: string, limit = 1000): Promise<Message[]> {
    return messageDb.getUnlinkedTextMessages(userId, limit);
  }

  async getUnlinkedEmails(userId: string, limit = 500): Promise<Communication[]> {
    return messageDb.getUnlinkedEmails(userId, limit);
  }

  async getMessageContacts(userId: string): Promise<{ contact: string; messageCount: number; lastMessageAt: string }[]> {
    return messageDb.getMessageContacts(userId);
  }

  async getMessagesByContact(userId: string, contact: string): Promise<Message[]> {
    return messageDb.getMessagesByContact(userId, contact);
  }

  async updateMessage(messageId: string, updates: Partial<Message>): Promise<void> {
    return messageDb.updateMessage(messageId, updates);
  }

  async linkMessageToTransaction(messageId: string, transactionId: string): Promise<void> {
    return messageDb.linkMessageToTransaction(messageId, transactionId);
  }

  async unlinkMessageFromTransaction(messageId: string): Promise<void> {
    return messageDb.unlinkMessageFromTransaction(messageId);
  }

  async getMessagesByTransaction(transactionId: string): Promise<Message[]> {
    return messageDb.getMessagesByTransaction(transactionId);
  }

  async getMessageById(messageId: string): Promise<Message | null> {
    return messageDb.getMessageById(messageId);
  }

  // ============================================
  // DIAGNOSTIC OPERATIONS (Delegate to diagnosticDbService)
  // ============================================

  async diagnosticGetMessagesWithNullThreadId(userId: string) {
    return diagnosticDb.diagnosticGetMessagesWithNullThreadId(userId);
  }

  async diagnosticUnknownRecipientMessages(userId: string) {
    return diagnosticDb.diagnosticUnknownRecipientMessages(userId);
  }

  async diagnosticGetMessagesWithGarbageText(userId: string) {
    return diagnosticDb.diagnosticGetMessagesWithGarbageText(userId);
  }

  async diagnosticMessageHealthReport(userId: string) {
    return diagnosticDb.diagnosticMessageHealthReport(userId);
  }

  async diagnosticGetThreadsForContact(userId: string, phoneDigits: string) {
    return diagnosticDb.diagnosticGetThreadsForContact(userId, phoneDigits);
  }

  async diagnosticNullThreadIdAnalysis(userId: string) {
    return diagnosticDb.diagnosticNullThreadIdAnalysis(userId);
  }

  // ============================================
  // UTILITY OPERATIONS (Keep in facade)
  // ============================================

  async vacuum(): Promise<void> {
    vacuumDb();
  }

  async close(): Promise<void> {
    await closeDb();
    this.db = null;
    this.encryptionKey = null;
    await logService.info("Database connection closed", "DatabaseService");
  }

  async rekeyDatabase(newKey: string): Promise<void> {
    const currentDb = this._ensureDb();
    try {
      currentDb.pragma(`rekey = "x'${newKey}'"`);
      this.encryptionKey = newKey;
      await logService.info("Database re-keyed successfully", "DatabaseService");
    } catch (error) {
      await logService.error("Failed to re-key database", "DatabaseService", {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "database-service", operation: "rekeyDatabase" },
      });
      throw error;
    }
  }

  async getEncryptionStatus(): Promise<{
    isEncrypted: boolean;
    keyMetadata: { keyId: string; createdAt: string; version: number } | null;
  }> {
    const keyMetadata = await databaseEncryptionService.getKeyMetadata();
    const isEncrypted = this.dbPath
      ? await databaseEncryptionService.isDatabaseEncrypted(this.dbPath)
      : false;
    return { isEncrypted, keyMetadata };
  }

  // ============================================
  // MAINTENANCE OPERATIONS (Delegate to maintenanceDbService)
  // ============================================

  async reindexDatabase(): Promise<{
    success: boolean;
    indexesRebuilt: number;
    durationMs: number;
    error?: string;
  }> {
    return maintenanceDb.reindexDatabase();
  }

  // ============================================
  // CONTACT RESOLUTION QUERIES (Delegate to attachmentDbService)
  // ============================================

  getContactNamesByPhoneDigits(normalizedPhones: string[]) {
    return attachmentDb.getContactNamesByPhoneDigits(normalizedPhones);
  }

  getContactNamesByEmails(lowerEmails: string[]) {
    return attachmentDb.getContactNamesByEmails(lowerEmails);
  }

  getContactNameByAppleIdPrefix(appleIdLower: string) {
    return attachmentDb.getContactNameByAppleIdPrefix(appleIdLower);
  }

  // ============================================
  // EMAIL ATTACHMENT QUERIES (Delegate to attachmentDbService)
  // ============================================

  getAttachmentStoragePaths() {
    return attachmentDb.getAttachmentStoragePaths();
  }

  hasAttachmentForEmail(emailId: string, filename: string) {
    return attachmentDb.hasAttachmentForEmail(emailId, filename);
  }

  createAttachmentRecord(params: Parameters<typeof attachmentDb.createAttachmentRecord>[0]) {
    return attachmentDb.createAttachmentRecord(params);
  }

  getAttachmentsByEmailId(emailId: string) {
    return attachmentDb.getAttachmentsByEmailId(emailId);
  }

  // ============================================
  // FOLDER EXPORT ATTACHMENT QUERIES (Delegate to attachmentDbService)
  // ============================================

  getAttachmentsForMessageWithFallback(messageId: string, externalId?: string) {
    return attachmentDb.getAttachmentsForMessageWithFallback(messageId, externalId);
  }

  getAttachmentsForEmailExport(emailId: string) {
    return attachmentDb.getAttachmentsForEmailExport(emailId);
  }

  getAttachmentsForExportBulk(messageIds: string[], externalIds: string[], emailIds: string[]) {
    return attachmentDb.getAttachmentsForExportBulk(messageIds, externalIds, emailIds);
  }

  // ============================================
  // SUBMISSION QUERIES (Delegate to submissionDbService)
  // ============================================

  getTransactionMessages(transactionId: string, auditStartDate?: Date | null, auditEndDate?: Date | null) {
    return submissionDb.getTransactionMessages(transactionId, auditStartDate, auditEndDate);
  }

  getTransactionEmails(transactionId: string, auditStartDate?: Date | null, auditEndDate?: Date | null) {
    return submissionDb.getTransactionEmails(transactionId, auditStartDate, auditEndDate);
  }

  getTransactionAttachments(transactionId: string, auditStartDate?: Date | null, auditEndDate?: Date | null) {
    return submissionDb.getTransactionAttachments(transactionId, auditStartDate, auditEndDate);
  }

  getTransactionBySubmissionId(submissionId: string) {
    return submissionDb.getTransactionBySubmissionId(submissionId);
  }

  getSubmittedTransactionById(transactionId: string) {
    return submissionDb.getSubmittedTransactionById(transactionId);
  }

  getActiveSubmittedTransactions() {
    return submissionDb.getActiveSubmittedTransactions();
  }

  updateTransactionSubmissionStatus(transactionId: string, submissionStatus: string, lastReviewNotes: string | null) {
    return submissionDb.updateTransactionSubmissionStatus(transactionId, submissionStatus, lastReviewNotes);
  }

  // ============================================
  // iPHONE SYNC QUERIES (Delegate to syncDbService)
  // ============================================

  getExistingMessageExternalIds(userId: string) {
    return syncDb.getExistingMessageExternalIds(userId);
  }

  batchInsertMessages(
    messages: Parameters<typeof syncDb.batchInsertMessages>[0],
    batchSize: number,
    sessionId?: string,
    cancelSignal?: { cancelled: boolean }
  ) {
    return syncDb.batchInsertMessages(messages, batchSize, sessionId, cancelSignal);
  }

  getMessageIdMap(userId: string) {
    return syncDb.getMessageIdMap(userId);
  }

  getExistingAttachmentRecords() {
    return syncDb.getExistingAttachmentRecords();
  }

  insertAttachment(params: Parameters<typeof syncDb.insertAttachment>[0]) {
    return syncDb.insertAttachment(params);
  }

  // ============================================
  // SYNC SESSION ROLLBACK (Delegate to syncDbService)
  // ============================================

  deleteMessagesBySessionId(userId: string, sessionId: string) {
    return syncDb.deleteMessagesBySessionId(userId, sessionId);
  }

  deleteMessagesByMetadataSource(userId: string, metadataSource: string) {
    return syncDb.deleteMessagesByMetadataSource(userId, metadataSource);
  }

  deleteAttachmentsBySessionId(sessionId: string) {
    return syncDb.deleteAttachmentsBySessionId(sessionId);
  }

  deleteContactsBySessionId(userId: string, sessionId: string) {
    return syncDb.deleteContactsBySessionId(userId, sessionId);
  }

  // ============================================
  // EMAIL DEDUPLICATION (TASK-2100)
  // ============================================

  getDatabaseForDeduplication(): DatabaseType {
    return this._ensureDb();
  }
}

// Export singleton instance
export default new DatabaseService();
