/**
 * @jest-environment node
 *
 * BACKLOG-3987 — audit rows left unsynced by a previous run are sent, and only
 * the signed-in user's rows are sent. REAL driver, REAL shipped schema, REAL
 * `auditLogDbService` functions and the REAL `auditService.syncToCloud`. Only
 * the cloud is faked, and it enforces the one rule the cloud enforces here:
 * the insert policy accepts a row only when its user_id is the session user,
 * and one rejected row fails the whole batch.
 *
 * A "restart" is a database that already holds unsynced rows while the
 * service's in-memory queue is empty — the state every launch starts in.
 *
 * Mutations that make it red (run at adoption):
 *   - restore the empty-queue early return in syncToCloud    -> R1, R2
 *   - drop `AND user_id = ?` from getUnsyncedAuditLogs       -> R2
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/db/__tests__/auditLogResendAfterRestart-3987.test.ts
 */

import * as nodePath from "path";
import * as fs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

// The driver is moduleNameMapper'd to a mock for the rest of the suite, so the
// real one has to be reached by absolute path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));

import { setDb } from "../core/dbConnection";
import {
  getUnsyncedAuditLogs,
  insertAuditLog,
  markAuditLogsSynced,
} from "../auditLogDbService";
import { auditService, type AuditLogEntry } from "../../auditService";

const SCHEMA_PATH = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");

const SIGNED_IN = "user-fixture-1";
const OTHER = "user-fixture-2";

let db: DatabaseType;
let uploads: string[][];
let rejectedBatches: number;

const fakeCloud = {
  getAuthSession: async () => ({ userId: SIGNED_IN }),
  async batchInsertAuditLogs(entries: AuditLogEntry[]): Promise<void> {
    // The cloud insert policy: WITH CHECK (user_id = auth.uid()). One foreign
    // row and the statement fails, so nothing in the batch lands.
    if (entries.some((e) => e.userId !== SIGNED_IN)) {
      rejectedBatches++;
      throw new Error("new row violates row-level security policy");
    }
    uploads.push(entries.map((e) => e.id));
  },
};

const realDb = {
  insertAuditLog,
  getUnsyncedAuditLogs,
  markAuditLogsSynced,
  isInitialized: () => true,
};

/** Rows written by a previous run, never synced. Oldest first. */
function seedPreviousRun(rows: Array<{ id: string; userId: string; ts: string }>): void {
  const insert = db.prepare(
    "INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, timestamp) " +
      "VALUES (?, ?, 'LOGIN', 'SESSION', NULL, ?)",
  );
  for (const r of rows) insert.run(r.id, r.userId, r.ts);
}

function unsyncedIds(): string[] {
  return (
    db.prepare("SELECT id FROM audit_logs WHERE synced_at IS NULL ORDER BY id").all() as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const insertUser = db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  );
  insertUser.run(SIGNED_IN, "fixture-1@example.test", "oauth-1");
  insertUser.run(OTHER, "fixture-2@example.test", "oauth-2");
  setDb(db);

  uploads = [];
  rejectedBatches = 0;

  // A fresh launch: no queue, nothing in flight.
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.syncInProgress = false;
  svc.currentSync = null;
  svc.cloudSyncFailing = false;
  svc.initialized = false;
  svc.pendingLocalWrites = [];
  auditService.initialize(realDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
});

afterEach(() => {
  auditService.stopSyncInterval();
  db.close();
});

test("R0 the real driver is under test", () => {
  const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  expect(row.v).toMatch(/^3\.\d+/);
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'prevent_audit_update'").get()).toEqual({ n: 1 });
});

test("R1 rows left unsynced by a previous run are sent after a restart", async () => {
  seedPreviousRun([
    { id: "prev-1", userId: SIGNED_IN, ts: "2026-10-01T00:00:00.000Z" },
    { id: "prev-2", userId: SIGNED_IN, ts: "2026-10-02T00:00:00.000Z" },
  ]);
  expect(auditService.getPendingSyncCount()).toBe(0);

  await auditService.syncToCloud();

  expect(uploads).toEqual([["prev-1", "prev-2"]]);
  expect(unsyncedIds()).toEqual([]);
});

test("R2 another account's older row does not block the signed-in user's rows, and is never sent", async () => {
  seedPreviousRun([
    // Oldest row in the table, belonging to a different local account.
    { id: "a-other", userId: OTHER, ts: "2026-09-01T00:00:00.000Z" },
    { id: "b-mine", userId: SIGNED_IN, ts: "2026-10-01T00:00:00.000Z" },
  ]);

  await auditService.syncToCloud();
  await auditService.syncToCloud();

  expect(rejectedBatches).toBe(0);
  expect(uploads).toEqual([["b-mine"]]);
  // The other account's row stays local and unsynced for that account.
  expect(unsyncedIds()).toEqual(["a-other"]);
});

test("R3 flushPendingLogs drains the table across batches and stops", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: `row-${String(i).padStart(3, "0")}`,
    userId: SIGNED_IN,
    ts: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
  }));
  seedPreviousRun(rows);

  await auditService.flushPendingLogs();

  expect(uploads.map((b) => b.length)).toEqual([100, 50]);
  expect(unsyncedIds()).toEqual([]);
});
