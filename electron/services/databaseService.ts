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
  ContactUpdateFields,
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
  ContactMessageThread,
  ContactInfoSource,
  AutoRestoreStatus,
  BackupIntegrity,
} from "../types";

import {
  DatabaseError,
  SchemaBaselineRefusalError,
  MigrationRecoveryFailedError,
} from "../types";
// BACKLOG-2993: the contactIdentitySchemaSql / contactValueProvenanceBackfill
// imports lived here for the deleted migration chain (v57..v69). The identity
// DDL's single definition (BACKLOG-2410) now reaches production through the
// generated schema.sql; the modules remain for their other consumers.
// BACKLOG-3067: branded row ids — see electron/types/ids.ts.
import type {
  CommunicationId,
  CommunicationRow,
  TransactionId,
  TransactionRow,
} from "../types/ids";
import { databaseEncryptionService } from "./databaseEncryptionService";
import { initializationBroadcaster } from "./initializationBroadcaster";
import type { AuditLogEntry } from "./auditService";

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
// BACKLOG-1933: ContactMessageThread lives in the shared models module.
export type { ContactMessageThread } from "../types";

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
   *
   * BACKLOG-2999: rejects with MigrationRecoveryFailedError when a migration
   * failed AND the auto-restore recovered nothing. It previously returned
   * `true` on that path, so the caller could not tell a good start from a
   * failed one.
   *
   * @param options.quitOnUnrecoverableFailure - exit the app after telling the
   *   user, on that unrecoverable path. DEFAULT FALSE, deliberately: only the
   *   startup caller (authHandlers.initializeDatabase) passes `true`. See the
   *   comment on the terminal branch for why the destructive outcome is the
   *   one that must be opted into.
   */
  async initialize(options?: { quitOnUnrecoverableFailure?: boolean }): Promise<boolean> {
    if (this.db) {
      await logService.debug("Database already initialized, skipping", "DatabaseService");
      return true;
    }

    // BACKLOG-2171: mark init as in-flight SYNCHRONOUSLY, before any `await`
    // (including the test-seam delay below). whenDbReady() treats bare `idle`
    // as "not started, don't wait" so deferred-init launches don't burn a
    // 30s timeout waiting on work that was never scheduled. Broadcasting
    // `starting` here first closes the gap for the real BACKLOG-2149 race
    // (init genuinely in flight) — waiters see `starting` immediately and
    // still wait for the eventual `db-ready`.
    initializationBroadcaster.broadcast({ stage: "starting", message: "Starting up..." });

    // BACKLOG-1842 (resume-at-step fix round): test-only seam to reproduce
    // the "relaunch reaches auth/onboarding reads before the local DB is
    // ready" race on demand, without depending on real memory pressure.
    // Double-gated (!app.isPackaged && KEEPR_TEST_DB_DELAY set) so it is DEAD
    // CODE in any packaged/shipped build, mirroring the KEEPR_E2E gates in
    // permissionHandlers.ts. Value is milliseconds to sleep before DB init
    // proceeds -- e.g. `KEEPR_TEST_DB_DELAY=5000 npm run dev` delays DB
    // readiness by 5s so the db-ready-gated consumers (getCurrentUser,
    // get-phone-type, check-email-onboarding, check-all-connections, the
    // onboarding resume-marker flow) can be exercised against a real race
    // instead of only unit-test mocks.
    if (!app.isPackaged && process.env.KEEPR_TEST_DB_DELAY) {
      const delayMs = parseInt(process.env.KEEPR_TEST_DB_DELAY, 10);
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await logService.warn(
          `[TEST SEAM] KEEPR_TEST_DB_DELAY set -- delaying DB init by ${delayMs}ms`,
          "DatabaseService",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
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

      // ======================================================================
      // BACKLOG-2993 — THE SCHEMA-BASELINE FENCE.
      //
      // The local migration chain was deleted; schema.sql IS the schema, at
      // the baseline (70). A database below the baseline predates the reset
      // and has no upgrade path: it must be REFUSED, UNTOUCHED, and EXPLAINED
      // — never half-migrated (exec'ing today's schema.sql against an old
      // file is BACKLOG-2751's corrupt-then-crash), and never routed through
      // auto-restore (every restorable backup is also pre-baseline, so that
      // path would restore-and-refuse in a loop).
      //
      // Two evaluations of the same predicate, both BEFORE this.db is
      // assigned or setDb() is called — 21 call sites gate on
      // databaseService.isInitialized() and 25 more on
      // dbConnection.isInitialized(), so a refused database must never be
      // exposed through either:
      //
      //  1. A separate READ-ONLY open. _openDatabase() runs
      //     `journal_mode = WAL`, which rewrites the header of any
      //     pre-WAL-era file — precisely the oldest databases the fence most
      //     needs to refuse untouched. The readonly pre-open refuses them
      //     with zero writes. (Verified empirically for this driver: a
      //     readonly open+read SUCCEEDS against a crashed hot-WAL database,
      //     with and without its -shm file, main file hash unchanged — so an
      //     open/read failure here is NOT "pre-reset", it is "cannot open",
      //     a different axis. Such failures defer to the read-write open
      //     below, which reproduces today's canonical error behaviour.)
      //  2. The same predicate against the read-write handle, before
      //     assignment — closes the readonly→read-write gap and any future
      //     driver-behaviour drift.
      // ======================================================================
      this._enforceSchemaBaselineReadonly();

      const openedDb = this._openDatabase();
      try {
        this._evaluateSchemaBaseline(openedDb, "read-write");
      } catch (fenceError) {
        try {
          openedDb.close();
        } catch {
          /* the refusal matters, not the close */
        }
        throw fenceError;
      }
      this.db = openedDb;

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
          // BACKLOG-2999 — DELIBERATELY NON-TERMINAL, and this boundary is
          // load-bearing. The restore recovered something: the backup was
          // copied over the database, reopened and probe-verified, so the
          // user's data is open and readable. What is STILL wrong is that
          // migrations are never re-run against the restored file — that is
          // BACKLOG-2834's subject, not this item's. Widening the terminal
          // path to cover it here would change a user-visible outcome ("the
          // app opens on your data" -> "the app quits") on a branch with no
          // 2999 defect behind it, in the same commit. Do not "fix" 2834 by
          // deleting this boundary: the no-quit assertion in
          // databaseService.migration-restore.test.ts pins it.
          dialog.showMessageBox({
            type: "warning",
            title: "Database Update Notice",
            message: "A database update failed, but your data has been restored.",
            detail: "The app will continue with your existing data. Please contact support if this happens again.",
            buttons: ["OK"],
          });
        } else {
          // ==============================================================
          // BACKLOG-2999 — THE TERMINAL BRANCH. Nothing was recovered.
          //
          // `restored === false` is reached by FOUR routes and the wreckage
          // each leaves differs: no backup and corrupt backup (the original
          // handle is still open), the restore copy throwing (`this.db` is
          // already null and dbConnection still holds a CLOSED handle), and
          // the post-restore connectivity probe failing (`this.db = newDb`
          // AND `setDb(newDb)` have already run, so every isInitialized()
          // call site sees a perfectly initialized database). Before this
          // branch existed all four fell through to `return true` below.
          //
          // ORDER IS LOAD-BEARING, mirroring the BACKLOG-2993 refusal path:
          // tear the handle down, TELL the user (dialog AWAITED), flush the
          // telemetry, then exit. Dropping the await would exit mid-dialog
          // and the user would never learn why.
          // ==============================================================

          // Nothing usable is open, so drop the handle through BOTH
          // predicates the app gates on — databaseService.isInitialized()
          // and dbConnection.isInitialized() — rather than leaving a
          // condemned database readable.
          try {
            await closeDb();
          } catch {
            // Already closed on the copy-throw route (_attemptAutoRestore
            // closes at the top and never reassigns), and close() is
            // unguarded. Swallowed on purpose: a throw here would replace
            // the terminal error with the wrong one and skip the dialog and
            // the exit — strictly worse than the bug being fixed. This is a
            // terminal fall-through, not a data fallback.
          }
          this.db = null;

          // AWAITED — see the order note above. The copy deliberately does
          // NOT point at the cleanup scripts the way the BACKLOG-2993
          // refusal does: that database provably has no upgrade path,
          // whereas this user's data may well be recoverable and those
          // scripts would destroy it. The path is appended because it is the
          // first thing support asks for.
          await dialog.showMessageBox({
            type: "error",
            title: "Database Update Failed",
            message: "A database update failed and could not be automatically fixed.",
            detail:
              "Please contact support. Your data may need manual recovery.\n\n" +
              `Database: ${this.dbPath ?? "unknown"}`,
            buttons: ["OK"],
          });

          // Flush before any exit path so the migration_failure event
          // survives it (BACKLOG-1576 precedent).
          await Sentry.flush(2000);

          // THE FLAG IS NOT THE FIX — THE THROW IS. Quitting is a
          // startup-specific remedy and it defaults OFF. Forgetting the
          // argument at a non-startup call site (sqliteBackupService's
          // restore calls initialize() at step 5 and AGAIN from its own
          // safety-copy recovery) would tear the process down mid-recovery
          // and cost a user who explicitly asked to restore the database
          // they still had. Forgetting it at startup costs only the exit:
          // initialize() still rejects, the handler still returns
          // success:false, and the renderer still lands on its error screen.
          // Destructive beats annoying, so the destructive outcome is the
          // one that has to be opted into.
          if (options?.quitOnUnrecoverableFailure) {
            app.quit();
          }

          throw new MigrationRecoveryFailedError(
            "Database migration failed and could not be recovered from a backup",
            restoreResult.autoRestoreStatus,
            restoreResult.backupIntegrity,
          );
        }
      }

      await logService.debug("Database initialized successfully with encryption", "DatabaseService");
      return true;
    } catch (error) {
      if (error instanceof MigrationRecoveryFailedError) {
        // BACKLOG-2999 — already fully handled by the terminal branch above:
        // handle torn down, dialog awaited, Sentry captured WITH the
        // migration_failure tags by the inner catch, flushed, exited if the
        // caller asked. Re-thrown untouched because the generic branch below
        // would capture a SECOND Sentry event for one failure (untagged, so it
        // would not even group with the first) and broadcast `retryable: true`
        // for a state that is not retryable.
        throw error;
      }

      if (error instanceof SchemaBaselineRefusalError) {
        // BACKLOG-2993 — terminal refusal surface. The broadcast below is
        // TELEMETRY ONLY: the renderer's reducer never reads `error` off the
        // init broadcast (reducer.ts destructures {stage, progress, message}
        // and documents the case as informational), and LoadingOrchestrator
        // reads `retryable` only into a Sentry extra. What actually stops a
        // retry loop on an unfixable database is the sequence below: the user
        // is TOLD (dialog, awaited), and then the app EXITS (app.quit()) —
        // quit makes renderer state moot. Do not "fix" a future retry bug by
        // teaching the reducer about retryable; the dialog+quit is the
        // load-bearing surface, by SR ruling on this item.
        initializationBroadcaster.broadcast({
          stage: "error",
          error: { message: error.message, retryable: false },
        });
        await logService.error("Pre-baseline database refused (schema baseline fence)", "DatabaseService", {
          error: error.message,
          foundVersion: error.foundVersion,
          path: this.dbPath,
        });
        Sentry.captureException(error, {
          tags: {
            service: "database-service",
            operation: "initialize",
            schema_baseline_refusal: "true",
          },
        });
        // Flush before the quit path so the event survives the exit
        // (BACKLOG-1576 precedent on the auto-restore path).
        await Sentry.flush(2000);

        if (!app.isReady()) {
          await app.whenReady();
        }
        // ORDER IS LOAD-BEARING: the dialog is AWAITED, then quit. Dropping
        // the await would exit mid-dialog — the user would never learn why
        // the app won't start. The boundary-sweep suite pins this order.
        // The in-app reset flow (Settings → Troubleshooting) is UNREACHABLE
        // here — the app is about to quit — so the copy points at the cleanup
        // scripts. They matter beyond convenience: the database is encrypted
        // and its key lives outside the file (macOS Keychain "keepr Safe
        // Storage" / Windows DPAPI), and the scripts remove BOTH; a
        // hand-deleted folder leaves a stale key behind and produces a
        // different, more confusing failure. No retry is offered — there is
        // nothing to retry.
        await dialog.showMessageBox({
          type: "error",
          title: "Database from an older version",
          message: "This database was created by an older version of Keepr and cannot be opened.",
          detail:
            "Keepr reset its local database format, and older databases have no " +
            "upgrade path.\n\n" +
            "To start fresh, run the Keepr cleanup script for your platform, then " +
            "reinstall:\n" +
            "  \u2022 macOS:   scripts/cleanup-macos.sh\n" +
            "  \u2022 Windows: scripts/cleanup-windows.ps1\n\n" +
            "The script also removes the old encryption key, which deleting the " +
            "database folder by hand would leave behind. Cloud data is unaffected " +
            "and will re-sync.\n\n" +
            `Database: ${this.dbPath ?? "unknown"}`,
          buttons: ["Quit"],
        });
        app.quit();
        throw error;
      }

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

  /**
   * BACKLOG-2394: the on-disk location of the database, for the support-ticket
   * diagnostics block (file size, `-wal` size, free space on that volume).
   *
   * A read-only accessor, deliberately NOT a second derivation of the path.
   * `_openDatabase` and the migration-backup logic already key off `this.dbPath`;
   * anything reporting the file's size must report the size of THAT file, or it
   * is describing a database the app is not using.
   *
   * NOTE the value is absolute and therefore carries the account name — every
   * caller must redact before it leaves the machine.
   */
  getDatabasePath(): string | null {
    return this.dbPath;
  }

  /**
   * BACKLOG-2394: the highest migration version this build ships, so diagnostics
   * can report `schema_version=54 (latest 56, MIGRATION PENDING)`. A database
   * stuck at an old version explains an entire class of bug report, and the app
   * ships migrations regularly.
   */
  getLatestSchemaVersion(): number {
    // BACKLOG-2993: with the chain empty the baseline IS the latest version a
    // build ships. Unguarded, the last-element read is a TypeError that would
    // silently void the ENTIRE support-ticket storage-diagnostics block
    // (supportTicketService.ts catches and leaves it null).
    const migrations = DatabaseService.MIGRATIONS;
    if (migrations.length === 0) return DatabaseService.BASELINE_VERSION;
    return migrations[migrations.length - 1].version;
  }

  /**
   * BACKLOG-2993 — readonly half of the schema-baseline fence. See the block
   * comment in initialize() for the full design.
   *
   * Refuses BEFORE any read-write open so a pre-WAL-era file is never touched
   * (the read-write opener's `journal_mode = WAL` rewrites the main file's
   * header). An open/read failure here is NOT a refusal — version and
   * openability are independent axes (SR review addendum, BACKLOG-2993): it
   * logs and defers to the read-write open, whose predicate re-check keeps
   * the fence closed and whose failure modes are today's canonical ones.
   */
  private _enforceSchemaBaselineReadonly(): void {
    if (!this.dbPath || !this.encryptionKey) return; // initialize() sets both first
    // Load-bearing, not defensive: a readonly open of a MISSING file fails
    // (SQLITE_CANTOPEN) — a fresh install must skip the fence entirely.
    if (!fs.existsSync(this.dbPath)) return;

    let ro: DatabaseType | null = null;
    try {
      ro = new Database(this.dbPath, { readonly: true });
      ro.pragma(`key = "x'${this.encryptionKey}'"`);
      ro.pragma("cipher_compatibility = 4");
      ro.pragma("busy_timeout = 5000");
    } catch (openError) {
      try {
        ro?.close();
      } catch {
        /* ignore */
      }
      log.warn(
        "[BaselineFence] readonly open failed — deferring to the read-write open (cannot-open is not pre-reset):",
        openError instanceof Error ? openError.message : String(openError),
      );
      return;
    }
    try {
      this._evaluateSchemaBaseline(ro, "read-only");
    } finally {
      try {
        ro.close();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * BACKLOG-2993 — the schema-baseline predicate. Throws
   * SchemaBaselineRefusalError on a positive pre-baseline determination;
   * throws NOTHING else (a driver-level read failure is "could not evaluate",
   * neither refusal nor acceptance — it logs and lets the existing pipeline
   * produce its canonical error, and keeps heavily-mocked test harnesses
   * transparent).
   *
   * The strictly-greater boundary is pinned on a real chain-built v69 file in
   * databaseService.schemaBaselineRefusal.test.ts — the off-by-one guard (the
   * wider 68/69/70/71 sweep was cut by founder ruling, 2026-08-30; see that
   * suite's scope note). The predicate's cases:
   *   - schema_version.version <  baseline → REFUSE (pre-reset)
   *   - schema_version.version == baseline → accept
   *   - schema_version.version >  baseline → accept, warn (a NEWER build
   *     wrote it; refusing would brick a downgrade with no upside)
   *   - user objects but NO schema_version table → REFUSE (pre-baseline
   *     relic — made explicit so a later refactor cannot silently turn a
   *     `?? 0` accident into "proceed")
   *   - empty database (no user objects) → accept (fresh install)
   *   - schema_version table present, row missing or non-numeric → REFUSE
   *     (deliberately inverts the old runner's "unreadable → migrate"
   *     default: the fence errs toward refusal)
   */
  private _evaluateSchemaBaseline(db: DatabaseType, via: "read-only" | "read-write"): void {
    const baseline = DatabaseService.BASELINE_VERSION;
    let refusal: string | null = null;
    let foundVersion: number | undefined;

    try {
      const svTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
        .get();
      if (!svTable) {
        const userObjects = (
          db
            .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
            .get() as { n: number }
        ).n;
        if (userObjects === 0) {
          return; // fresh/empty file — nothing to refuse
        }
        refusal =
          "This database has user tables but no schema_version table — it predates " +
          `the schema baseline (version ${baseline}) and cannot be upgraded.`;
      } else {
        const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
          | { version: unknown }
          | undefined;
        const version = row?.version;
        if (typeof version !== "number" || !Number.isFinite(version)) {
          refusal =
            "This database has a schema_version table but no readable version row — " +
            `it cannot be verified against the schema baseline (version ${baseline}).`;
        } else if (version < baseline) {
          foundVersion = version;
          refusal =
            `This database is at schema version ${version}, which predates the ` +
            `schema baseline (version ${baseline}). The migration chain that could ` +
            "have upgraded it no longer exists.";
        } else {
          if (version > baseline) {
            log.warn(
              `[BaselineFence] database schema_version ${version} is ABOVE this build's ` +
                `baseline ${baseline} — written by a newer build; proceeding.`,
            );
          }
          return;
        }
      }
    } catch (readError) {
      log.warn(
        `[BaselineFence] could not evaluate the baseline predicate via ${via} — ` +
          "neither refusing nor accepting; the existing open/migration pipeline decides:",
        readError instanceof Error ? readError.message : String(readError),
      );
      return;
    }

    throw new SchemaBaselineRefusalError(refusal, foundVersion);
  }

  private _openDatabase(): DatabaseType {
    if (!this.dbPath) throw new DatabaseError("Database path is not set");
    if (!this.encryptionKey) throw new DatabaseError("Encryption key is not set");

    const openedDb = new Database(this.dbPath);
    openedDb.pragma(`key = "x'${this.encryptionKey}'"`);
    openedDb.pragma("cipher_compatibility = 4");
    openedDb.pragma("foreign_keys = ON");

    // Performance tuning (S4, BACKLOG-1771). These pragmas were authored in
    // db/core/dbConnection.openDatabase() but that function is never invoked on
    // the real init path — databaseService._openDatabase() is the sole opener,
    // so the tuning sat dormant (written, never applied at open). Wire it in
    // here, in the exact order proven by dbConnection.openDatabase(), so the
    // encrypted production DB actually gets it.
    //
    //   busy_timeout: wait up to 5s on a locked DB (worker-thread reads racing
    //     the main-process writer) instead of failing immediately with
    //     SQLITE_BUSY.
    //   journal_mode = WAL: concurrent reader/writer access so worker threads
    //     can read while the main process writes (TASK-1956/1965).
    //   synchronous = NORMAL: durable under WAL (fsync deferred to checkpoint,
    //     not every commit) and improves write throughput (TASK-1965).
    openedDb.pragma("busy_timeout = 5000");
    const journalMode = openedDb.pragma("journal_mode = WAL") as Array<{
      journal_mode: string;
    }>;
    if (journalMode?.[0]?.journal_mode !== "wal") {
      // eslint-disable-next-line no-console
      console.warn("[DB] WAL mode not enabled, journal_mode returned:", journalMode);
    }
    openedDb.pragma("synchronous = NORMAL");

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
      // BACKLOG-2993: this build of better-sqlite3-multiple-ciphers compiles
      // with foreign_keys ON by default (verified: `pragma foreign_keys` on a
      // fresh connection returns 1). With enforcement on, this copy only works
      // if sqlite_master order happens to put every FK parent before its
      // children — true of the old hand-ordered schema.sql, NOT true of the
      // regenerated (name-ordered) one, and never guaranteed for a real file
      // whose tables were rebuilt by the old chain (DROP+CREATE moves a parent
      // to the end). A clone must reproduce the source byte-for-byte, orphans
      // included, not re-validate it mid-copy — so enforcement is off for the
      // duration. The next real open re-enables it (_openDatabase pragmas
      // foreign_keys = ON per session).
      newDb.pragma("foreign_keys = OFF");

      for (const { name: tableName } of tables) {
        const tableInfo = oldDb.prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
        ).get(tableName) as { sql: string } | undefined;

        if (tableInfo?.sql) {
          newDb.exec(tableInfo.sql);

          // BACKLOG-2630: the column list comes from `PRAGMA table_info`, NOT from
          // `SELECT *` + `Object.keys(rows[0])`.
          //
          // WHY, CONCRETELY. `PRAGMA table_info` OMITS stored generated columns;
          // `SELECT *` RETURNS them. The old code derived the INSERT's column list
          // from the shape of a returned row, so the moment any table gained a
          // `GENERATED ALWAYS AS (...) STORED` column the list named it and SQLite
          // refused the statement at PREPARE time with "cannot INSERT into
          // generated column". `contact_link_proposals.pair_key` and
          // `contact_link_verdicts.pair_key` (migration v69) are the first such
          // columns in this schema. The throw propagates out of the catch below —
          // which restores the plaintext backup — and out of `runMigrations()` in
          // `initialize()`, so the app would not start.
          //
          // A generated column is exactly what must NOT be copied: the destination
          // recomputes it from the values that ARE copied. Excluding it is correct,
          // not a workaround. Use `table_info`, never `table_xinfo` — the latter
          // includes generated columns and reintroduces the bug.
          const columns = (
            oldDb.pragma(`table_info("${tableName}")`) as { name: string }[]
          ).map((c) => c.name);

          // Empty-table short-circuit, preserved from the original. The column list
          // no longer depends on a row existing, so this is a cheap skip rather than
          // a correctness requirement — but keeping it means an empty table behaves
          // exactly as it did before this change.
          const rows =
            columns.length > 0
              ? oldDb
                  .prepare(
                    `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${tableName}"`
                  )
                  .all()
              : [];
          if (rows.length > 0) {
            const placeholders = columns.map(() => "?").join(", ");
            const insertStmt = newDb.prepare(
              `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`
            );
            // BY NAME, never positionally: the binder looks each column up on the
            // row object rather than trusting the order values came back in.
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
    autoRestoreStatus: AutoRestoreStatus;
    backupIntegrity: BackupIntegrity;
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

    // S5 (BACKLOG-1772): key pre-migration backups to migration EVENTS, not app
    // launches. Previously EVERY startup copied the DB and churned the 3-file
    // retention window, so a genuine pre-migration snapshot aged out after just
    // three launches — defeating the point of keeping it. Compute whether the
    // versioned runner will actually apply a migration this launch (the on-disk
    // DB version is behind the latest migration) and only create / prune the
    // rolling backup when it will. schema.sql is re-exec'd unconditionally below
    // but is fully IF NOT EXISTS (idempotent), so an up-to-date DB mutates
    // nothing and needs no snapshot.
    // BACKLOG-2993: guarded — with the chain empty the baseline is the latest
    // version. This line runs on EVERY open (fresh installs included), so an
    // unguarded last-element read would be a startup crash for every user.
    const latestMigrationVersion =
      DatabaseService.MIGRATIONS.length === 0
        ? DatabaseService.BASELINE_VERSION
        : DatabaseService.MIGRATIONS[DatabaseService.MIGRATIONS.length - 1].version;
    let willRunMigration = true;
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
          willRunMigration = dbVersion < latestMigrationVersion;
        }
        // No schema_version table on an existing DB file → the runner will build
        // the full chain from baseline, which IS a migration event, so leave
        // willRunMigration = true.
      } catch {
        // Version unreadable → err on the safe side and take the backup.
        willRunMigration = true;
      }
    }

    // Pre-migration backup (TASK-1969) — only when a migration will actually run
    // (S5, BACKLOG-1772: keyed to migration events, not app launches).
    if (willRunMigration && this.dbPath && fs.existsSync(this.dbPath)) {
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

    // Backup retention: keep last 3, delete older. Gated on willRunMigration so
    // the rolling window tracks the last 3 MIGRATION events (S5, BACKLOG-1772),
    // not the last 3 launches — nothing new is created otherwise, so there is
    // nothing to prune. Any pre-existing excess is trimmed on the next migration.
    if (willRunMigration && this.dbPath) {
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

  /**
   * BACKLOG-2993 — THE schema baseline: the version schema.sql seeds on a
   * fresh install, and the lowest version initialize() will open (the
   * schema-baseline fence refuses anything below it — those databases predate
   * the reset and the chain that could have upgraded them was deleted).
   *
   * THE RULE, NOT THE NUMBER: the baseline must be STRICTLY GREATER than any
   * version any existing database can hold. At the reset, both develop and
   * shipped main topped out at migration 69, so the baseline is 70 — 69 would
   * be a bug (it would accept exactly the chain-built databases the reset
   * exists to reject). Re-derive against the live artefacts if this is ever
   * changed; never copy it forward.
   */
  static readonly BASELINE_VERSION = 70;

  /**
   * BACKLOG-2993 — EMPTY BY DESIGN. The v30..v69 chain (40 migrations, ~3,500
   * lines) was deleted when schema.sql was regenerated as the full v69-shape
   * baseline, seeded at version 70. Every database the chain could have acted
   * on is refused by the schema-baseline fence in initialize(); fresh installs
   * get the complete shape from schema.sql alone.
   *
   * A FUTURE migration goes here only for versions ABOVE the baseline (71+),
   * and the preferred post-reset way to evolve the local schema is to edit
   * schema.sql directly and record the change in ALLOWED_EVOLUTION
   * (databaseService.schema-parity.test.ts) — see BACKLOG-2551 / BACKLOG-2807
   * for the pattern.
   */
  static readonly MIGRATIONS: MigrationEntry[] = [];

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

    // BACKLOG-1900 (P0.1): disable foreign_keys for the duration of the migration
    // loop, following the SQLite-documented "generalized ALTER TABLE" procedure
    // (https://sqlite.org/lang_altertable.html §7): step 1 is `PRAGMA foreign_keys=OFF`,
    // performed OUTSIDE any transaction. This is REQUIRED for table-rebuild migrations
    // on a parent table with children (e.g. v48 rebuilds `contacts`, which is the parent
    // of contact_emails / contact_phones / transaction_participants / transaction_contacts
    // / classification_feedback). With foreign_keys=ON, the `DROP TABLE contacts` step of
    // the rebuild fires ON DELETE CASCADE and silently wipes every child row — a data-loss
    // bug. `defer_foreign_keys` does NOT help: it defers constraint *checks* to COMMIT but
    // the CASCADE *action* still fires on DROP. `PRAGMA foreign_keys` is a no-op inside a
    // transaction, so it MUST be toggled here, around (not inside) the per-migration
    // transactions. FK enforcement is restored in the finally block. (This also
    // retroactively hardens the pre-existing v36 contacts rebuild.)
    //
    // NOTE: we intentionally do NOT run a strict `foreign_key_check` afterwards —
    // legacy installs may carry pre-existing orphan rows that were never validated at
    // migration time before, and failing the whole migration on them would be a
    // regression. The scope here is limited to preventing the rebuild from CREATING
    // new orphans via cascade.
    //
    // SIDE EFFECT on v43: turning foreign_keys OFF here makes v43's own
    // `defer_foreign_keys = ON` a no-op (deferred FK *validation* at COMMIT no longer
    // fires for a full 30→48 chain). This is strictly MORE permissive — it can only
    // skip a check, never create an orphan — so it is not a safety regression.
    const fkWasOn = (currentDb.pragma("foreign_keys", { simple: true }) as number) === 1;
    if (fkWasOn) {
      currentDb.pragma("foreign_keys = OFF");
    }
    try {
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
    } finally {
      // Always restore the original FK enforcement state, even if a migration threw.
      if (fkWasOn) {
        currentDb.pragma("foreign_keys = ON");
      }
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

  /**
   * BACKLOG-2496: `origin` is required and forwarded, not defaulted. A facade
   * that supplied a default here would re-open the exact hole the required
   * parameter closes — every caller would compile again, and the one that had
   * not thought about provenance would get a plausible-looking wrong answer.
   */
  async createContact(
    contactData: NewContact,
    origin: Parameters<typeof contactDb.createContact>[1],
  ): Promise<Contact> {
    return contactDb.createContact(contactData, origin);
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

  // BACKLOG-2617: the `findContactByName` delegate is gone with the function it
  // delegated to. Name-only identity is not a lookup this facade offers.

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

  async backfillContactEmails(
    contactId: string,
    emails: string[],
    source?: ContactInfoSource,
  ): Promise<number> {
    return contactDb.backfillContactEmails(contactId, emails, source);
  }

  async backfillContactPhones(
    contactId: string,
    phones: string[],
    source?: ContactInfoSource,
  ): Promise<number> {
    return contactDb.backfillContactPhones(contactId, phones, source);
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

  async updateContact(contactId: string, updates: ContactUpdateFields): Promise<void> {
    return contactDb.updateContact(contactId, updates);
  }

  /**
   * BACKLOG-2496: the synchronous core, for callers running inside a
   * `dbTransaction` — whose callback is synchronous, and which would COMMIT
   * over a rejected promise from the async wrapper above.
   */
  updateContactSync(contactId: string, updates: ContactUpdateFields): void {
    return contactDb.updateContactSync(contactId, updates);
  }

  async getTransactionsByContact(contactId: string): Promise<contactDb.TransactionWithRoles[]> {
    return contactDb.getTransactionsByContact(contactId);
  }

  // BACKLOG-1933: contact-scoped emails/texts (aggregated across ALL transactions).
  async getEmailsForContact(contactId: string): Promise<Communication[]> {
    return contactDb.getEmailsForContact(contactId);
  }

  async getMessagesForContact(contactId: string): Promise<ContactMessageThread[]> {
    return contactDb.getMessagesForContact(contactId);
  }

  async deleteContact(
    contactId: string,
    reason: contactDb.ContactRemovalReason = "user_deleted",
  ): Promise<void> {
    return contactDb.deleteContact(contactId, reason);
  }

  /** BACKLOG-2365: removed contacts, for the import picker's already-imported filter. */
  async getRemovedContactIdentifiers(userId: string) {
    return contactDb.getRemovedContactIdentifiers(userId);
  }

  /** BACKLOG-2367: removed contacts as list rows, for the Removed contacts section. */
  async getRemovedContacts(userId: string): Promise<contactDb.RemovedContactRow[]> {
    return contactDb.getRemovedContacts(userId);
  }

  /** BACKLOG-2367: clear a contact tombstone. False when there was nothing to restore. */
  async restoreContact(contactId: string): Promise<boolean> {
    return contactDb.restoreContact(contactId);
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

  /**
   * Create a deal AND attach every party in ONE transaction (BACKLOG-2538).
   * The composition lives in the db layer so it is testable there.
   */
  createTransactionWithContactsSync(
    transactionData: NewTransaction,
    assignments: transactionContactDb.TransactionContactData[],
  ): Transaction {
    return transactionDb.createTransactionWithContactsSync(transactionData, assignments);
  }

  async getTransactions(filters?: TransactionFilters): Promise<Transaction[]> {
    return transactionDb.getTransactions(filters);
  }

  getPendingTransactionCount(userId: string): number {
    return transactionDb.getPendingTransactionCount(userId);
  }

  async getTransactionById(transactionId: string): Promise<TransactionRow | null> {
    return transactionDb.getTransactionById(transactionId);
  }

  async getTransactionWithContacts(transactionId: string): Promise<TransactionWithContacts | null> {
    return transactionDb.getTransactionWithContacts(transactionId);
  }

  async updateTransaction(transactionId: string, updates: Partial<Transaction>): Promise<void> {
    return transactionDb.updateTransaction(transactionId, updates);
  }

  /**
   * BACKLOG-2013 — write-once stamp of the export-freeze marker. Enforced in SQL
   * (`WHERE first_exported_at IS NULL`); returns true only when this call set it.
   */
  stampFirstExportedAt(transactionId: string, timestamp: string): boolean {
    return transactionDb.stampFirstExportedAt(transactionId, timestamp);
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

  async createCommunication(communicationData: NewCommunication): Promise<CommunicationRow> {
    return communicationDb.createCommunication(communicationData);
  }

  async getCommunicationById(communicationId: string): Promise<CommunicationRow | null> {
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

  // BACKLOG-2571: `emailAltSentAt` is the second candidate timestamp for the
  // ignore-key transition bridge — see the note above the two matchers in
  // communicationDbService.
  async isEmailIgnoredForTransaction(transactionId: string, emailSender: string, emailSubject: string, emailSentAt: string, emailAltSentAt?: string | null): Promise<boolean> {
    return communicationDb.isEmailIgnoredForTransaction(transactionId, emailSender, emailSubject, emailSentAt, emailAltSentAt);
  }

  async isEmailIgnoredByUser(userId: string, emailSender: string, emailSubject: string, emailSentAt: string, emailAltSentAt?: string | null): Promise<boolean> {
    return communicationDb.isEmailIgnoredByUser(userId, emailSender, emailSubject, emailSentAt, emailAltSentAt);
  }

  async removeIgnoredCommunication(ignoredCommId: string): Promise<void> {
    return communicationDb.removeIgnoredCommunication(ignoredCommId);
  }

  /**
   * BACKLOG-3067: branded, because a facade that widens its parameters back to
   * `string` erases the whole guarantee for every caller that goes through it.
   */
  async linkCommunicationToTransaction(communicationId: CommunicationId, transactionId: TransactionId): Promise<void> {
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

  async unlinkContactFromTransaction(transactionId: string, contactId: string, reason?: string): Promise<void> {
    return transactionContactDb.unlinkContactFromTransaction(transactionId, contactId, reason);
  }

  async isContactAssignedToTransaction(transactionId: string, contactId: string): Promise<boolean> {
    return transactionContactDb.isContactAssignedToTransaction(transactionId, contactId);
  }

  /** BACKLOG-2367: parties tombstoned off this transaction, most recent first. */
  async getRemovedTransactionContacts(transactionId: string): Promise<transactionContactDb.TransactionContactResult[]> {
    return transactionContactDb.getRemovedTransactionContacts(transactionId);
  }

  /** BACKLOG-2367: clear a junction tombstone. False when there was nothing to restore. */
  async restoreContactToTransaction(transactionId: string, contactId: string): Promise<boolean> {
    return transactionContactDb.restoreContactToTransaction(transactionId, contactId);
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

  async getMessageContacts(userId: string): Promise<messageDb.MessageContactRow[]> {
    return messageDb.getMessageContacts(userId);
  }

  async getMessagesByContact(userId: string, contact: string): Promise<Message[]> {
    return messageDb.getMessagesByContact(userId, contact);
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

  getContactNamesByPhoneDigits(
    normalizedPhones: string[],
    scope?: attachmentDb.ContactResolutionScope
  ) {
    return attachmentDb.getContactNamesByPhoneDigits(normalizedPhones, scope);
  }

  getContactNamesByEmails(
    lowerEmails: string[],
    scope?: attachmentDb.ContactResolutionScope
  ) {
    return attachmentDb.getContactNamesByEmails(lowerEmails, scope);
  }

  getContactNameByAppleIdPrefix(
    appleIdLower: string,
    scope?: attachmentDb.ContactResolutionScope
  ) {
    return attachmentDb.getContactNameByAppleIdPrefix(appleIdLower, scope);
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

  // BACKLOG-1870: persist attachment metadata at sync (no bytes) + reconcile on download.
  upsertEmailAttachmentMetadata(
    params: Parameters<typeof attachmentDb.upsertEmailAttachmentMetadata>[0]
  ) {
    return attachmentDb.upsertEmailAttachmentMetadata(params);
  }

  getEmailAttachmentByFilename(emailId: string, filename: string) {
    return attachmentDb.getEmailAttachmentByFilename(emailId, filename);
  }

  setEmailAttachmentStorage(id: string, storagePath: string, fileSizeBytes: number) {
    return attachmentDb.setEmailAttachmentStorage(id, storagePath, fileSizeBytes);
  }

  // BACKLOG-2257: persist locally-extracted text_content onto an attachment row.
  setAttachmentTextContent(id: string, text: string) {
    return attachmentDb.setAttachmentTextContent(id, text);
  }

  getAttachmentTextExtractionRow(id: string) {
    return attachmentDb.getAttachmentTextExtractionRow(id);
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

  // BACKLOG-322 Phase A: unified email + text attachments for a transaction
  // (includes metadata-only rows whose bytes are not downloaded yet).
  getTransactionAllAttachments(
    transactionId: string,
    auditStartDate?: Date | null,
    auditEndDate?: Date | null,
  ) {
    return attachmentDb.getTransactionAllAttachments(transactionId, auditStartDate, auditEndDate);
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
