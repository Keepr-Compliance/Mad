/**
 * @jest-environment node
 *
 * BACKLOG-4020 CONTROLS. Deleting a deal re-points each text whose
 * messages.transaction_id named it to the text's most recent remaining link
 * (or NULL), inside the transaction that holds the delete and its audit entry.
 * Runs against the production deleteTransactionSync: no variant switch, and no
 * module-scope assertion on the SQL under test (a mutation must never make
 * this suite run zero tests).
 *
 * Real driver, real schema.sql (FKs ON), REAL handlers (transactions:delete,
 * transactions:bulk-delete), real transactionService.linkMessages and
 * createThreadCommunicationReference, real dbTransaction. Harness = BACKLOG-3339's.
 * Values are invented.
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
// Fire-and-forget background work after a create / date change. Stubbed so a
// create cannot reach the network.
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
import transactionService from "../services/transactionService";
import { registerTransactionCrudHandlers } from "../handlers/transactionCrudHandlers";
import { createThreadCommunicationReference } from "../services/db/communicationDbService";
import * as messageDb from "../services/db/messageDbService";
import * as dbConnection from "../services/db/core/dbConnection";
import { MESSAGES_NAMING_DEAL_SQL } from "../services/db/transactionDbService";
import { getMessageTransactionIds } from "../services/dealLockState";
import type { NewTransaction } from "../types";
import { openAuditProbeDb, realAuditDb, settle } from "../services/db/__tests__/fixtures/auditTxProbe";

const USER = "40200000-0000-4000-8000-0000000000a1"; // pii-allow-uuid: invented fixture id
const PHONE = "+15550101";
const THREAD = "thread-4020";
const IDS = ["m-4020-1", "m-4020-2"];

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

beforeAll(() => registerTransactionCrudHandlers(null));

beforeEach(() => {
  db = openAuditProbeDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner-4020@example.test", "oauth-4020");
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = []; svc.syncInProgress = false; svc.currentSync = null;
  svc.cloudSyncFailing = false; svc.localInsertFailing = false; svc.initialized = false;
  svc.pendingLocalWrites = []; svc.kickScheduled = false;
  auditService.setSupportAccessGate(null);
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
  IDS.forEach((id, i) => {
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at)
       VALUES (?, ?, 'sms', 'inbound', ?, ?, '15550101', ?, ?)`,
    ).run(id, USER, `body ${id}`, JSON.stringify({ from: PHONE, to: ["me"] }), THREAD, `2026-01-0${i + 5}T10:00:00Z`);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  auditService.stopSyncInterval();
  await settle();
  db.close();
});

function deal(addr: string): string {
  return databaseService.createTransactionWithContactsSync(
    { user_id: USER, property_address: addr, transaction_type: "purchase", status: "active" } as NewTransaction,
    [],
  ).id;
}
const column = (): Array<string | null> =>
  IDS.map((id) => (db.prepare("SELECT transaction_id FROM messages WHERE id = ?").get(id) as any).transaction_id);
const links = (tx: string): string[] =>
  (db.prepare(
    "SELECT coalesce(message_id, 'thread:' || thread_id) AS k FROM communications WHERE transaction_id = ? ORDER BY k",
  ).all(tx) as Array<{ k: string }>).map((r) => r.k);
const picker = (tx: string): string[] => messageDb.getMessagesByContact(USER, PHONE, tx).map((m) => m.id).sort();
const deletes = (): number =>
  (db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'TRANSACTION_DELETE' AND success = 1").get() as any).n;

/** B first, then A: the column names A (linkMessages overwrites). */
async function sharedPerMessage(): Promise<{ A: string; B: string }> {
  const A = deal("1 Fixture Way"); const B = deal("2 Fixture Way");
  await transactionService.linkMessages(IDS, B);
  await transactionService.linkMessages(IDS, A);
  return { A, B };
}

/** A text auto-linked to B only (thread row, column NULL): pre-existing picker state. */
async function autoOnly(B: string): Promise<void> {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at)
     VALUES ('m-4020-x', ?, 'sms', 'inbound', 'x', ?, '15550101', 'thread-4020-x', '2026-01-09T10:00:00Z')`,
  ).run(USER, JSON.stringify({ from: PHONE, to: ["me"] }));
  await createThreadCommunicationReference("thread-4020-x", B, USER);
}
const colX = (): string | null =>
  (db.prepare("SELECT transaction_id FROM messages WHERE id = 'm-4020-x'").get() as any).transaction_id;
const dealExists = (tx: string): boolean =>
  (db.prepare("SELECT count(*) AS n FROM transactions WHERE id = ?").get(tx) as any).n === 1;

/** Throw from the production re-point on the given 1-based calls (all calls when empty). */
function crashRepoint(onCalls: number[] = []): jest.SpyInstance {
  const real = messageDb.repointMessageTransaction;
  let n = 0;
  return jest.spyOn(messageDb, "repointMessageTransaction").mockImplementation((id: string) => {
    n++;
    if (onCalls.length === 0 || onCalls.includes(n)) throw new Error(`simulated crash at re-point ${n}`);
    real(id);
  });
}

test("C1 single delete of A: column re-points to B", async () => {
  const { A, B } = await sharedPerMessage();
  const spy = jest.spyOn(messageDb, "repointMessageTransaction");
  expect((await invoke("transactions:delete", A)).success).toBe(true);
  expect(spy).toHaveBeenCalledTimes(2); // the spy seam reaches the production call site
  expect(column()).toEqual([B, B]);
  expect(getMessageTransactionIds(IDS)).toEqual([B, B]);
  expect(picker(B)).toEqual([]);
  expect(links(B)).toEqual(IDS);
  expect(deletes()).toBe(1);
});
test("C2 bulk delete [other, A]: column re-points to B", async () => {
  const { A, B } = await sharedPerMessage();
  const other = deal("3 Fixture Way");
  const res = await invoke("transactions:bulk-delete", [other, A]);
  expect(res.deletedCount).toBe(2);
  expect(column()).toEqual([B, B]);
  expect(picker(B)).toEqual([]);
  expect(deletes()).toBe(2);
});
test("C3 B holds only the thread row: column re-points to B", async () => {
  const A = deal("1 Fixture Way"); const B = deal("2 Fixture Way");
  await transactionService.linkMessages(IDS, A);
  await createThreadCommunicationReference(THREAD, B, USER);
  await invoke("transactions:delete", A);
  expect(column()).toEqual([B, B]);
});
test("C4 most recent remaining link wins (B older, C newer)", async () => {
  const A = deal("1 Fixture Way"); const B = deal("2 Fixture Way"); const C = deal("3 Fixture Way");
  await transactionService.linkMessages(IDS, B);
  await transactionService.linkMessages(IDS, C);
  await transactionService.linkMessages(IDS, A);
  db.prepare("UPDATE communications SET linked_at = '2026-01-01 00:00:00' WHERE transaction_id = ?").run(B);
  db.prepare("UPDATE communications SET linked_at = '2026-02-01 00:00:00' WHERE transaction_id = ?").run(C);
  await invoke("transactions:delete", A);
  expect(column()).toEqual([C, C]);
});
test("C5 deleting a deal the column does not name changes nothing; deleting the last holder -> NULL", async () => {
  const { A, B } = await sharedPerMessage();
  await invoke("transactions:delete", B);
  expect(column()).toEqual([A, A]);
  await invoke("transactions:delete", A);
  expect(column()).toEqual([null, null]);
});
test("C6 a text auto-linked to B only keeps column NULL (out of B's picker, in any other deal's)", async () => {
  const { A, B } = await sharedPerMessage();
  await autoOnly(B);
  expect(colX()).toBeNull();
  await invoke("transactions:delete", A);
  expect(colX()).toBeNull();
  // BACKLOG-4017 (inverted): B's picker leaves out a chat linked to B; another deal's offers it.
  expect(picker(B)).not.toContain("m-4020-x");
  expect(picker(deal("4 Fixture Way"))).toContain("m-4020-x");
});

describe("C7 crash sweep, single delete: nothing changes", () => {
  const points = [
    "captureFails", "deleteFails", "firstRepoint", "secondRepoint", "repointSqlFails", "auditFails", "auditThrows",
  ];
  for (const p of points) {
    test(p, async () => {
      const { A, B } = await sharedPerMessage();
      if (p === "captureFails") {
        const real = dbConnection.dbAll;
        jest.spyOn(dbConnection, "dbAll").mockImplementation(((s: any, params?: unknown[]) => {
          if (s === MESSAGES_NAMING_DEAL_SQL) throw new Error("simulated capture failure");
          return real(s, params);
        }) as typeof dbConnection.dbAll);
      } else if (p === "deleteFails") {
        db.exec(`CREATE TRIGGER k3 BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END`);
      } else if (p === "firstRepoint") crashRepoint([1]);
      else if (p === "secondRepoint") crashRepoint([2]);
      else if (p === "repointSqlFails") {
        db.exec(`CREATE TRIGGER k_rp BEFORE UPDATE OF transaction_id ON messages WHEN NEW.transaction_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced repoint failure'); END`);
      } else if (p === "auditFails") {
        db.exec(`CREATE TRIGGER k1 BEFORE INSERT ON audit_logs WHEN NEW.success = 1 BEGIN SELECT RAISE(ABORT, 'forced'); END`);
      } else if (p === "auditThrows") {
        jest.spyOn(auditService, "recordInTransaction").mockImplementation(() => { throw new Error("crash"); });
      }
      const res = await invoke("transactions:delete", A).catch((e: Error) => ({ success: false, thrown: e.message }));
      expect(res.success).toBe(false);
      expect(dealExists(A)).toBe(true);
      expect(column()).toEqual([A, A]);
      expect(links(A)).toEqual(IDS);
      expect(links(B)).toEqual(IDS);
      expect(deletes()).toBe(0);
    });
  }
});

test("C8 bulk: the middle deal's re-point crashes; it stays, the others are deleted", async () => {
  const { A, B } = await sharedPerMessage();
  const before = deal("0 Fixture Way"); const after = deal("9 Fixture Way");
  crashRepoint(); // only A names texts, so only A's delete re-points
  const res = await invoke("transactions:bulk-delete", [before, A, after]);
  expect(res.deletedCount).toBe(2);
  expect(db.prepare("SELECT id FROM transactions WHERE id IN (?, ?, ?)").all(before, A, after)).toEqual([{ id: A }]);
  expect(column()).toEqual([A, A]);
  expect(links(A)).toEqual(IDS);
  expect(links(B)).toEqual(IDS);
});

test("C9 a legacy orphan link newer than B's does not block the delete", async () => {
  const { A, B } = await sharedPerMessage();
  // Transcribed state, not executed: a link whose deal row is gone (FK-off period).
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, linked_at)
     VALUES ('c-orphan', ?, 'tx-GONE', 'm-4020-1', 'manual', '2099-01-01 00:00:00')`,
  ).run(USER);
  db.exec("PRAGMA foreign_keys = ON");
  const res = await invoke("transactions:delete", A).catch((e: Error) => ({ success: false, thrown: e.message }));
  expect(res.success).toBe(true);
  expect(dealExists(A)).toBe(false);
  // The re-point skips links to missing deals (BACKLOG-3908 follow-up), so the
  // orphan-newest text falls back to B, its newest link to a deal that exists.
  expect(column()).toEqual([B, B]);
  expect(links(B)).toEqual(IDS);
});

test("C10 direct call, no outer transaction: a re-point crash leaves the deal and the column", async () => {
  const { A, B } = await sharedPerMessage();
  crashRepoint([2]);
  expect(() => databaseService.deleteTransactionSync(A)).toThrow("simulated crash at re-point 2");
  expect(dealExists(A)).toBe(true);
  expect(column()).toEqual([A, A]);
  expect(links(A)).toEqual(IDS);
  expect(links(B)).toEqual(IDS);
});
