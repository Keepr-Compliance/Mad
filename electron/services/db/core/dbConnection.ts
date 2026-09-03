/**
 * Database Connection Module
 * Manages the shared SQLite database connection for all database services.
 *
 * This module provides:
 * - Database initialization and connection management
 * - Helper methods for executing queries (_get, _all, _run)
 * - Access to the raw database instance for bulk operations
 *
 * SECURITY: Database is encrypted at rest using SQLCipher (AES-256)
 */

import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType } from "better-sqlite3";
import path from "path";
import fs from "fs";
import { app } from "electron";
import { DatabaseError, QueryResult } from "../../../types";
import type { SafeSql } from "./sqlText";
import { databaseEncryptionService } from "../../databaseEncryptionService";
import logService from "../../logService";

/**
 * Database connection state - shared across all services
 */
let db: DatabaseType | null = null;
let dbPath: string | null = null;
let encryptionKey: string | null = null;

/**
 * Check if database is initialized
 */
export function isInitialized(): boolean {
  return db !== null;
}

/**
 * Get the database path
 */
export function getDbPath(): string | null {
  return dbPath;
}

/**
 * Get the encryption key.
 * BACKLOG-1123: Delegates to databaseEncryptionService's cached key to reduce duplication.
 * The local `encryptionKey` variable is kept as a synchronous fallback for openDb().
 */
export function getEncryptionKey(): string | null {
  // Prefer the canonical source (encryption service cache) when available
  const serviceKey = databaseEncryptionService.getCachedKey();
  return serviceKey ?? encryptionKey;
}

/**
 * Ensure database is initialized and return it
 * @throws {DatabaseError} If database is not initialized
 */
export function ensureDb(): DatabaseType {
  if (!db) {
    throw new DatabaseError(
      "Database is not initialized. Call initialize() first.",
    );
  }
  return db;
}

/**
 * Get raw database instance for bulk operations.
 * Use with caution - prefer using service methods when possible.
 *
 * This is exposed for performance-critical bulk operations like
 * iPhone sync which need direct transaction control.
 *
 * @returns The underlying better-sqlite3 database instance
 * @throws {DatabaseError} If database is not initialized
 */
export function getRawDatabase(): DatabaseType {
  return ensureDb();
}

/**
 * Open database connection with encryption
 */
export function openDatabase(): DatabaseType {
  if (!dbPath) {
    throw new DatabaseError("Database path is not set");
  }
  if (!encryptionKey) {
    throw new DatabaseError("Encryption key is not set");
  }

  const database = new Database(dbPath);

  // Configure SQLCipher encryption
  database.pragma(`key = "x'${encryptionKey}'"`);
  database.pragma("cipher_compatibility = 4");

  // Enable foreign keys
  database.pragma("foreign_keys = ON");

  // Set busy timeout to prevent hangs on concurrent access
  // 5 seconds is sufficient for most operations while still detecting true deadlocks
  database.pragma("busy_timeout = 5000");

  // TASK-1956/1965: Enable WAL mode for concurrent reader/writer access.
  // This allows worker threads to read while the main process writes,
  // preventing SQLITE_BUSY errors during contact query offloading.
  const journalMode = database.pragma("journal_mode = WAL") as Array<{
    journal_mode: string;
  }>;
  if (journalMode?.[0]?.journal_mode !== "wal") {
    console.warn(
      "[DB] WAL mode not enabled, journal_mode returned:",
      journalMode,
    );
  }

  // TASK-1965: NORMAL synchronous is safe with WAL mode — data is still
  // durable after a crash, but fsync is deferred to checkpoint rather than
  // every transaction commit, improving write throughput.
  database.pragma("synchronous = NORMAL");

  // Verify database is accessible (will throw if key is wrong)
  try {
    database.pragma("cipher_integrity_check");
  } catch (error) {
    throw new DatabaseError(
      "Failed to decrypt database. Encryption key may be invalid.",
    );
  }

  return database;
}

/**
 * Set the database instance (used during initialization)
 */
export function setDb(database: DatabaseType): void {
  db = database;
}

/**
 * Set database path (used during initialization)
 */
export function setDbPath(path: string): void {
  dbPath = path;
}

/**
 * Set encryption key (used during initialization)
 */
export function setEncryptionKey(key: string): void {
  encryptionKey = key;
}

/**
 * Initialize the database path and encryption key
 * Does NOT open the database - that's done by initialize() in databaseService
 */
export async function initializePaths(): Promise<void> {
  // Get user data path
  const userDataPath = app.getPath("userData");
  dbPath = path.join(userDataPath, "mad.db");

  await logService.info("Initializing database paths", "DbConnection", {
    path: dbPath,
  });

  // Ensure directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Initialize encryption service and get key
  await databaseEncryptionService.initialize();
  encryptionKey = await databaseEncryptionService.getEncryptionKey();
}

/**
 * Close the database connection
 */
export async function closeDb(): Promise<void> {
  if (db) {
    db.close();
    db = null;
    await logService.info("Database connection closed", "DbConnection");
  }
}

/**
 * Vacuum the database to reclaim space
 */
export async function vacuumDb(): Promise<void> {
  const database = ensureDb();
  database.exec("VACUUM");
  await logService.info("Database vacuumed", "DbConnection");
}

// ============================================
// QUERY HELPERS
// ============================================

/**
 * Helper: Run a query that returns a single row
 * Uses better-sqlite3's synchronous API
 */
export function dbGet<T = unknown>(
  sql: SafeSql,
  params: unknown[] = [],
): T | undefined {
  const database = ensureDb();
  const stmt = database.prepare(sql);
  return stmt.get(...params) as T | undefined;
}

/**
 * Helper: Run a query that returns multiple rows
 * Uses better-sqlite3's synchronous API
 */
export function dbAll<T = unknown>(sql: SafeSql, params: unknown[] = []): T[] {
  const database = ensureDb();
  const stmt = database.prepare(sql);
  return stmt.all(...params) as T[];
}

/**
 * Helper: Run a query that modifies data (INSERT, UPDATE, DELETE)
 * Uses better-sqlite3's synchronous API
 */
export function dbRun(sql: SafeSql, params: unknown[] = []): QueryResult {
  const database = ensureDb();
  const stmt = database.prepare(sql);
  const result = stmt.run(...params);
  return {
    lastInsertRowid: result.lastInsertRowid as number,
    changes: result.changes,
  };
}

/**
 * Helper: Execute raw SQL (for migrations, schema changes)
 */
export function dbExec(sql: SafeSql): void {
  const database = ensureDb();
  database.exec(sql);
}

/**
 * Helper: Run a transaction
 */
export function dbTransaction<T>(fn: () => T): T {
  const database = ensureDb();
  return database.transaction(fn)();
}
