/**
 * @jest-environment node
 *
 * BACKLOG-3339 PR 0 — the audit foundation, on the REAL driver.
 *
 * REAL better-sqlite3 (multiple-ciphers), REAL shipped schema, REAL
 * `auditLogDbService`, REAL `auditService`. Only the cloud is faked; it records
 * exactly the entries `batchInsertAuditLogs` would map and send.
 *
 *   T1  recordInTransaction outside a transaction throws and writes nothing.
 *   K0  inside a transaction: the change and its entry both commit.
 *   K1  the audit INSERT fails: the change is rolled back.
 *   WB  the likely-wrong build (an ASYNC insert inside the transaction): the
 *       change COMMITS over the failed insert. Kept as a standing exhibit of
 *       the trap K1 exists to catch; slices reuse the probe (fixtures/auditTxProbe).
 *   K2  the change throws after the entry: both roll back, and nothing is sent.
 *   C1  the entry reaches the cloud through the post-commit send, with the
 *       60 s interval off (without it: next tick or next launch, BACKLOG-3987).
 *
 * Mutations run at adoption (each proven applied, see the PR's pm_comment):
 *   recordInTransaction uses `void db.insertAuditLog(...)`   -> K1 red
 *   remove `this.scheduleKickAfterCommit()`                  -> C1 red
 *   drop the inTransaction assert                            -> T1 red
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/jest/bin/jest.js \
 *     electron/services/db/__tests__/auditInTransaction-3339.test.ts
 */

import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));

import { dbTransaction } from "../core/dbConnection";
import { auditService, type AuditLogEntry } from "../../auditService";
import {
  PROBE_USER,
  auditRows,
  forceAuditInsertFailure,
  openAuditProbeDb,
  probeChangeIds,
  realAuditDb,
  settle,
  writeProbeChange,
} from "./fixtures/auditTxProbe";

let db: DatabaseType;
let uploads: AuditLogEntry[][];

const fakeCloud = {
  getAuthSession: async () => ({ userId: PROBE_USER }),
  async batchInsertAuditLogs(entries: AuditLogEntry[]): Promise<void> {
    uploads.push(entries.map((e) => ({ ...e })));
  },
};

const uploadedIds = (): string[] => uploads.flat().map((e) => e.id);

beforeEach(() => {
  db = openAuditProbeDb();
  uploads = [];
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.syncInProgress = false;
  svc.currentSync = null;
  svc.cloudSyncFailing = false;
  svc.initialized = false;
  svc.pendingLocalWrites = [];
  svc.kickScheduled = false;
  auditService.setSupportAccessGate(null);
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
});

afterEach(async () => {
  auditService.stopSyncInterval();
  await settle();
  db.close();
});

test("R0 the real driver is under test", () => {
  const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  expect(row.v).toMatch(/^3\.\d+/);
  expect(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'prevent_audit_update'").get(),
  ).toEqual({ n: 1 });
});

const entry = (resourceId: string) => ({
  userId: PROBE_USER,
  action: "TRANSACTION_CREATE" as const,
  resourceType: "TRANSACTION" as const,
  resourceId,
});

describe("recordInTransaction", () => {
  test("T1 throws outside a transaction and writes nothing", () => {
    expect(() => auditService.recordInTransaction(entry("p1"))).toThrow(
      "must be called inside a database transaction",
    );
    expect(auditRows(db)).toEqual([]);
  });

  test("K0 the change and its entry commit together", () => {
    const written = dbTransaction(() => {
      writeProbeChange(db, "p1");
      return auditService.recordInTransaction(entry("p1"));
    });
    expect(probeChangeIds(db)).toEqual(["p1"]);
    expect(auditRows(db)).toEqual([
      { id: written.id, action: "TRANSACTION_CREATE", resource_id: "p1", success: 1, error_message: null },
    ]);
  });

  test("K1 a failed audit INSERT rolls the change back", () => {
    forceAuditInsertFailure(db);
    expect(() =>
      dbTransaction(() => {
        writeProbeChange(db, "p1");
        auditService.recordInTransaction(entry("p1"));
      }),
    ).toThrow("forced audit insert failure");
    expect(probeChangeIds(db)).toEqual([]);
    expect(auditRows(db)).toEqual([]);
  });

  test("WB the likely-wrong build — an async insert inside the transaction — commits the change over a failed insert", async () => {
    forceAuditInsertFailure(db);
    let rejected: unknown = null;
    dbTransaction(() => {
      writeProbeChange(db, "p1");
      // The WRONG composition: the throw becomes a rejection after COMMIT.
      realAuditDb
        .insertAuditLog({ ...entry("p1"), id: "wb-1", timestamp: new Date(), success: true })
        .catch((e: unknown) => {
          rejected = e;
        });
    });
    await settle(1);
    expect(probeChangeIds(db)).toEqual(["p1"]);
    expect(auditRows(db)).toEqual([]);
    expect(String(rejected)).toContain("forced audit insert failure");
  });

  test("K2 the change throws after the entry: both roll back, and nothing reaches the cloud", async () => {
    expect(() =>
      dbTransaction(() => {
        auditService.recordInTransaction(entry("p1"));
        writeProbeChange(db, "p1");
        throw new Error("change failed");
      }),
    ).toThrow("change failed");
    await settle();
    expect(probeChangeIds(db)).toEqual([]);
    expect(auditRows(db)).toEqual([]);
    expect(uploads).toEqual([]);
    expect(auditService.getPendingSyncCount()).toBe(0);
  });

  test("C1 the committed entry reaches the cloud with no interval running", async () => {
    const written = dbTransaction(() => {
      writeProbeChange(db, "p1");
      return auditService.recordInTransaction(entry("p1"));
    });
    // Nothing is queued in memory: the row is the outbox.
    expect(auditService.getPendingSyncCount()).toBe(0);
    await settle();
    expect(uploadedIds()).toEqual([written.id]);
    expect(
      db.prepare("SELECT count(*) AS n FROM audit_logs WHERE synced_at IS NULL").get(),
    ).toEqual({ n: 0 });
  });
});
