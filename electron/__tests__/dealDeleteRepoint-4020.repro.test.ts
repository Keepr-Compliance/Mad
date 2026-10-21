/**
 * @jest-environment node
 *
 * BACKLOG-4020 REPRO. Deleting a deal used to leave a shared text's
 * messages.transaction_id NULL while another deal still held the text. R1/R2
 * were written against the bug and inverted with the fix: they now assert the
 * column re-points to the remaining deal. M2/M3 pin the schema mechanism.
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
import { getMessagesByContact } from "../services/db/messageDbService";
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
const picker = (tx: string): string[] => getMessagesByContact(USER, PHONE, tx).map((m) => m.id).sort();
const deletes = (): number =>
  (db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'TRANSACTION_DELETE' AND success = 1").get() as any).n;

/** B first, then A: the column names A (linkMessages overwrites). */
async function sharedPerMessage(): Promise<{ A: string; B: string }> {
  const A = deal("1 Fixture Way"); const B = deal("2 Fixture Way");
  await transactionService.linkMessages(IDS, B);
  await transactionService.linkMessages(IDS, A);
  return { A, B };
}

describe("R1 per-message links in A and B, column names A", () => {
  test("baseline before the delete", async () => {
    const { A, B } = await sharedPerMessage();
    expect(column()).toEqual([A, A]);
    expect(links(B)).toEqual(IDS);
    expect(picker(B)).toEqual([]);
  });
  test("single delete of A: column re-points to B, which still holds both texts", async () => {
    const { A, B } = await sharedPerMessage();
    expect((await invoke("transactions:delete", A)).success).toBe(true);
    expect(column()).toEqual([B, B]);
    expect(links(B)).toEqual(IDS);
    expect(links(A)).toEqual([]);
    expect(picker(B)).toEqual([]);
    expect(getMessageTransactionIds(IDS)).toEqual([B, B]);
    expect(deletes()).toBe(1);
  });
  test("bulk delete of [other, A]: same", async () => {
    const { A, B } = await sharedPerMessage();
    const other = deal("3 Fixture Way");
    const res = await invoke("transactions:bulk-delete", [other, A]);
    expect(res.deletedCount).toBe(2);
    expect(column()).toEqual([B, B]);
    expect(links(B)).toEqual(IDS);
    expect(picker(B)).toEqual([]);
    expect(deletes()).toBe(2);
  });
  test("deleting B (the column names A) leaves the column at A", async () => {
    const { A, B } = await sharedPerMessage();
    await invoke("transactions:delete", B);
    expect(column()).toEqual([A, A]);
  });
  test("bulk delete of A and B: column NULL, no link left", async () => {
    const { A, B } = await sharedPerMessage();
    await invoke("transactions:bulk-delete", [A, B]);
    expect(column()).toEqual([null, null]);
    expect(db.prepare("SELECT count(*) AS n FROM communications").get()).toEqual({ n: 0 });
  });
});

describe("R2 A per-message, B holds the thread (auto-link)", () => {
  test("single delete of A: column re-points to B, which holds the thread row", async () => {
    const A = deal("1 Fixture Way"); const B = deal("2 Fixture Way");
    await transactionService.linkMessages(IDS, A);
    await createThreadCommunicationReference(THREAD, B, USER);
    expect(column()).toEqual([A, A]);
    await invoke("transactions:delete", A);
    expect(column()).toEqual([B, B]);
    expect(links(B)).toEqual([`thread:${THREAD}`]);
  });
});

describe("M mechanism", () => {
  // Before the fix this asserted [A, A]: with FKs OFF nothing on the delete path
  // wrote the column, so the FK action was its only clearer. With the fix the
  // re-point writes it, and skips A's links (left by the missing cascade)
  // because A no longer exists.
  test("FKs OFF: no cascade; the re-point skips the deleted deal's leftover links", async () => {
    const { A, B } = await sharedPerMessage();
    db.exec("PRAGMA foreign_keys = OFF");
    await invoke("transactions:delete", A);
    expect(column()).toEqual([B, B]);
    expect(links(A)).toEqual(IDS); // no cascade
  });
  test("schema declares messages.transaction_id ON DELETE SET NULL and communications CASCADE", () => {
    const fk = (t: string) =>
      (db.prepare(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list('${t}') WHERE "table" = 'transactions'`).all() as any[]);
    expect(fk("messages")).toEqual([{ table: "transactions", from: "transaction_id", on_delete: "SET NULL" }]);
    expect(fk("communications")).toEqual([{ table: "transactions", from: "transaction_id", on_delete: "CASCADE" }]);
  });
  test("an AFTER UPDATE OF transaction_id trigger fires on the FK action", async () => {
    const { A } = await sharedPerMessage();
    db.exec("CREATE TABLE fired (id TEXT, old TEXT, new TEXT)");
    db.exec(`CREATE TEMP TRIGGER t4020 AFTER UPDATE OF transaction_id ON main.messages
             BEGIN INSERT INTO fired VALUES (NEW.id, OLD.transaction_id, NEW.transaction_id); END`);
    await invoke("transactions:delete", A);
    expect((db.prepare("SELECT count(*) AS n FROM fired WHERE old IS NOT NULL AND new IS NULL").get() as any).n).toBe(2);
  });
});
