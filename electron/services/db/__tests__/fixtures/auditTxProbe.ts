/**
 * BACKLOG-3339 — real-driver harness for "the audit entry commits with its
 * change, or neither does". Built for PR 0's controls and meant to be reused
 * by every conversion slice: drive the real handler against `openAuditProbeDb`,
 * then `forceAuditInsertFailure` and assert the change is absent (K1).
 *
 * The REAL driver, the REAL shipped schema (`schema.sql`, with its CHECK and
 * foreign keys and the immutability triggers), the REAL `auditLogDbService`.
 * Callers must run under ELECTRON_RUN_AS_NODE (the moduleNameMapper sends the
 * bare driver name to a mock for the rest of the suite):
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/jest/bin/jest.js <file>
 */

import * as nodePath from "path";
import * as fs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

import { getRawDatabase, setDb } from "../../core/dbConnection";
import {
  getUnsyncedAuditLogs,
  insertAuditLog,
  markAuditLogsSynced,
} from "../../auditLogDbService";
import type { AuditLogEntry } from "../../../auditService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const SCHEMA_PATH = nodePath.join(__dirname, "..", "..", "..", "..", "database", "schema.sql");

export const PROBE_USER = "user-fixture-3339";

/** In-memory database with the shipped schema, one local user and a probe table. */
export function openAuditProbeDb(): DatabaseType {
  const db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(PROBE_USER, "fixture-3339@example.test", "oauth-3339");
  // The "change" an audit entry records. Any write on the shared connection.
  db.exec("CREATE TABLE probe_change (id TEXT PRIMARY KEY)");
  setDb(db);
  return db;
}

/** The change half of a probe composition. */
export function writeProbeChange(db: DatabaseType, id: string): void {
  db.prepare("INSERT INTO probe_change (id) VALUES (?)").run(id);
}

export function probeChangeIds(db: DatabaseType): string[] {
  return (db.prepare("SELECT id FROM probe_change ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/** Every audit row, as the fields the controls compare. */
export function auditRows(
  db: DatabaseType,
): Array<{ id: string; action: string; resource_id: string | null; success: number; error_message: string | null }> {
  return db
    .prepare("SELECT id, action, resource_id, success, error_message FROM audit_logs ORDER BY timestamp, id")
    .all() as Array<{ id: string; action: string; resource_id: string | null; success: number; error_message: string | null }>;
}

/** Every audit INSERT fails from now on, the way a real constraint failure does. */
export function forceAuditInsertFailure(db: DatabaseType): void {
  db.exec(
    "CREATE TRIGGER probe_fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'forced audit insert failure'); END",
  );
}

/**
 * The database dependency `auditService` is initialised with, backed by the
 * real functions. `insertAuditLog` is `async`, exactly like the
 * `databaseService` facade — that is what makes the WRONG_B composition
 * (an async insert inside a transaction) commit over a failed insert.
 */
export const realAuditDb = {
  insertAuditLog: async (entry: AuditLogEntry): Promise<void> => {
    await insertAuditLog(entry);
  },
  getUnsyncedAuditLogs,
  markAuditLogsSynced,
  isInitialized: () => true,
  isInTransaction: () => getRawDatabase().inTransaction,
};

/** Wait for timers and the send they kick to finish. */
export async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
