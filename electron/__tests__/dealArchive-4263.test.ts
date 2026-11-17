/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-4c — the deal archive behind the two delete handlers (plan §14 F2), through the REAL handlers
 * (transactions:delete, transactions:bulk-delete), the REAL databaseService / transactionDbService delete, the REAL
 * dbTransaction and the REAL auditService on the shipped schema (harness: BACKLOG-3339's auditTxProbe).
 *
 *   A1  a Keepr Cloud user's delete archives the deal, in the same transaction as the delete and its audit entry
 *   A2  the audit entry failing cancels the delete AND writes no archive row
 *   A3  a never-on user's delete leaves the database exactly as a delete without the archive step (Q7, W34)
 *   A4  bulk delete: per deal owner (two local users on one profile)
 *   A5  every caller of deleteTransactionSync: only the two handlers archive; the async seam does not
 *   A6  the restore's audit entry (TRANSACTION_CREATE, restored_from_archive) commits with the restore
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Database as DatabaseType } from "better-sqlite3";
import type { IpcMainInvokeEvent } from "electron";

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data"), getVersion: jest.fn(() => "0.0.0-test") },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../services/transactionSyncTrigger", () => ({
  triggerTransactionSyncInBackground: jest.fn(),
  isAutoSyncInFlight: jest.fn(() => false),
  ensureTransactionEmailsSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
jest.mock("../services/messagesSyncTrigger", () => ({
  triggerMessagesSyncInBackground: jest.fn(),
  ensureTransactionMessagesSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
jest.mock("../services/databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../services/contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { auditService, type AuditLogEntry } from "../services/auditService";
import databaseService from "../services/databaseService";
import { registerTransactionCrudHandlers } from "../handlers/transactionCrudHandlers";
import { openAuditProbeDb, realAuditDb, settle, forceAuditInsertFailure } from "../services/db/__tests__/fixtures/auditTxProbe";
import { seedFullDeal, fz } from "../services/cloudSync/__tests__/helpers/dealArchiveFixtures";
import * as archive from "../services/db/cloudSyncDealArchive";
import { recordDealRestoreAuditSync } from "../services/cloudSync/restoreAudit";
import { getRawDatabase } from "../services/db/core/dbConnection";
import type { SqlDb } from "../services/db/cloudSyncSqlDb";
import { REPOINT_MESSAGE_TRANSACTION_SQL } from "../services/db/messageDbService";

const USER = "user-a-4263c";
const USER_B = "user-b-4263c";
const PROJECT = "test-project.supabase.co";

let db: DatabaseType;
const fakeCloud = {
  getAuthSession: async () => ({ userId: USER }),
  async batchInsertAuditLogs(_e: AuditLogEntry[]): Promise<void> {},
};
const evt = {} as IpcMainInvokeEvent;
const invoke = (channel: string, ...args: unknown[]): Promise<any> => {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, ...args);
};
const n = (sql: string, ...p: unknown[]): number => (db.prepare(sql).get(...p) as any).n;
const archived = (): string[] =>
  (db.prepare(`SELECT transaction_id FROM ${archive.DEAL_ARCHIVE_TABLE} ORDER BY transaction_id`).all() as any[]).map((r) => r.transaction_id);
const cloudOn = (user: string) =>
  db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, local_confirmed_at) VALUES (?, ?, 1, '2026-11-01T00:00:00.000Z')").run(PROJECT, user);

/** Every table except the audit log, as text (what "the database is the same" means here). */
function dump(d: DatabaseType): string {
  const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('audit_logs', 'sqlite_sequence') ORDER BY name").all() as any[]).map((r) => r.name);
  return JSON.stringify(tables.map((t) => [t, d.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
}

function fresh(): void {
  db = openAuditProbeDb();
  db.exec("PRAGMA foreign_keys = ON");
  for (const [id, email] of [[USER, "a-4263c@example.test"], [USER_B, "b-4263c@example.test"]]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(id, email, id);
  }
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = []; svc.syncInProgress = false; svc.currentSync = null;
  svc.cloudSyncFailing = false; svc.localInsertFailing = false; svc.initialized = false;
  svc.pendingLocalWrites = []; svc.kickScheduled = false;
  auditService.setSupportAccessGate(null);
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
}

beforeAll(() => registerTransactionCrudHandlers());
beforeEach(() => fresh());
afterEach(async () => {
  jest.restoreAllMocks();
  auditService.stopSyncInterval();
  await settle();
  db.close();
});

const D1 = fz(80, 1);
const D2 = fz(80, 2);
const D3 = fz(80, 3);

describe("A1-A2 the archive is written in the delete's own transaction", () => {
  test("A1 a Keepr Cloud user's delete: the deal is gone, one archive row holds it, one TRANSACTION_DELETE entry", async () => {
    seedFullDeal(db as unknown as SqlDb, USER, D1);
    cloudOn(USER);
    expect((await invoke("transactions:delete", D1)).success).toBe(true);
    expect(n("SELECT COUNT(*) AS n FROM transactions WHERE id = ?", D1)).toBe(0);
    expect(archived()).toEqual([D1]);
    expect(n("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'TRANSACTION_DELETE' AND success = 1 AND resource_id = ?", D1)).toBe(1);
  });

  test("A2 the audit entry failing: the deal stays and NO archive row is written", async () => {
    seedFullDeal(db as unknown as SqlDb, USER, D1);
    cloudOn(USER);
    forceAuditInsertFailure(db);
    const res = await invoke("transactions:delete", D1).catch((e: unknown) => ({ success: false, error: e }));
    expect(res.success).toBe(false);
    expect(n("SELECT COUNT(*) AS n FROM transactions WHERE id = ?", D1)).toBe(1);
    expect(archived()).toEqual([]);
  });
});

describe("A3 never-on users: the delete is exactly today's (Q7, W34)", () => {
  test("the database after the handler's delete equals the database after a delete with no archive step", async () => {
    seedFullDeal(db as unknown as SqlDb, USER, D1);
    expect((await invoke("transactions:delete", D1)).success).toBe(true);
    expect(archived()).toEqual([]);
    const viaHandler = dump(db);
    await settle();
    db.close();
    fresh();
    seedFullDeal(db as unknown as SqlDb, USER, D1);
    // Today's delete (4ab45f396 transactionDbService.ts deleteTransactionSync), statement for statement, with no
    // archive step: the texts naming the deal, the DELETE, each text re-pointed.
    db.transaction(() => {
      const named = db.prepare("SELECT id FROM messages WHERE transaction_id = ?").all(D1) as Array<{ id: string }>;
      db.prepare("DELETE FROM transactions WHERE id = ?").run(D1);
      for (const { id } of named) db.prepare(REPOINT_MESSAGE_TRANSACTION_SQL as unknown as string).run(id);
    })();
    expect(dump(db)).toBe(viaHandler);
  });
});

describe("A4 bulk delete, two local users on one profile", () => {
  test("the Keepr Cloud user's deals are archived, the never-on user's deal is not", async () => {
    seedFullDeal(db as unknown as SqlDb, USER, D1, 1);
    seedFullDeal(db as unknown as SqlDb, USER, D2, 2);
    seedFullDeal(db as unknown as SqlDb, USER_B, D3, 3);
    cloudOn(USER);
    const res = await invoke("transactions:bulk-delete", [D1, D3, D2]);
    expect(res.deletedCount).toBe(3);
    expect(archived()).toEqual([D1, D2].sort());
    expect(n("SELECT COUNT(*) AS n FROM cloud_sync_deal_archive WHERE owner_user_id = ?", USER_B)).toBe(0);
  });
});

describe("A5 the callers of deleteTransactionSync", () => {
  test("transactions:delete and transactions:bulk-delete archive; databaseService.deleteTransaction (the async seam) and an unflagged deleteTransactionSync do not, and erase a stale row for that id", async () => {
    seedFullDeal(db as unknown as SqlDb, USER, D1, 1);
    seedFullDeal(db as unknown as SqlDb, USER, D2, 2);
    cloudOn(USER);
    await databaseService.deleteTransaction(D1);
    expect(archived()).toEqual([]);
    databaseService.deleteTransactionSync(D2);
    expect(archived()).toEqual([]);
    // a stale row for an id that is on this computer again goes with an unflagged delete of that id
    seedFullDeal(db as unknown as SqlDb, USER, D3, 3);
    expect((await invoke("transactions:delete", D3)).success).toBe(true);
    expect(archived()).toEqual([D3]);
    db.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, 'Back', 'active', 'confirmed')").run(D3, USER);
    await databaseService.deleteTransaction(D3);
    expect(archived()).toEqual([]);
  });
});

describe("A6 the restore's audit entry", () => {
  test("TRANSACTION_CREATE with restored_from_archive commits with the restore; a failing entry cancels it", async () => {
    seedFullDeal(db as unknown as SqlDb, USER, D1);
    cloudOn(USER);
    await invoke("transactions:delete", D1);
    const raw = getRawDatabase() as unknown as SqlDb;
    forceAuditInsertFailure(db);
    expect(archive.restoreArchivedDeal(raw, { userId: USER, transactionId: D1, now: new Date(), audit: recordDealRestoreAuditSync })).toEqual({ ok: false, code: "restore_failed" });
    expect(n("SELECT COUNT(*) AS n FROM transactions WHERE id = ?", D1)).toBe(0);
    expect(archived()).toEqual([D1]);
    db.exec("DROP TRIGGER probe_fail_audit");
    expect(archive.restoreArchivedDeal(raw, { userId: USER, transactionId: D1, now: new Date(), audit: recordDealRestoreAuditSync })).toMatchObject({ ok: true });
    const row = db.prepare("SELECT action, resource_id, metadata FROM audit_logs WHERE action = 'TRANSACTION_CREATE' AND resource_id = ?").get(D1) as any;
    expect(row.action).toBe("TRANSACTION_CREATE");
    expect(JSON.parse(row.metadata)).toMatchObject({ restored_from_archive: true, restored_from: "computer" });
    expect(archived()).toEqual([]);
  });
});
