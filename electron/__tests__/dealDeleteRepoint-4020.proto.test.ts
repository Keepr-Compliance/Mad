/**
 * @jest-environment node
 *
 * BACKLOG-4020 PLAN PROTOTYPE (not a deliverable). Candidate fixes are installed
 * as a spy on databaseService.deleteTransactionSync / logService.info, so no
 * production file changes. V4020 selects the variant:
 *   NONE (today) | FIX | EARLIEST | AFTER_CAPTURE | BROAD | OUTSIDE
 */

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
const picker = (): string[] => getMessagesByContact(USER, PHONE).map((m) => m.id).sort();
const deletes = (): number =>
  (db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'TRANSACTION_DELETE' AND success = 1").get() as any).n;

/** B first, then A: the column names A (linkMessages overwrites). */

async function sharedPerMessage(): Promise<{ A: string; B: string }> {
  const A = deal("1 Fixture Way"); const B = deal("2 Fixture Way");
  await transactionService.linkMessages(IDS, B);
  await transactionService.linkMessages(IDS, A);
  return { A, B };
}

import logService from "../services/logService";
import * as transactionDb from "../services/db/transactionDbService";
import { repointMessageTransaction, REPOINT_MESSAGE_TRANSACTION_SQL } from "../services/db/messageDbService";

const VARIANT = process.env.V4020 ?? "FIX";
let crashAt: string | null = null;
const hit = (p: string): void => { if (crashAt === p) throw new Error(`simulated crash at ${p}`); };
const DESC = "ORDER BY c.linked_at DESC, c.rowid DESC";
const ASC_SQL = (() => {
  const s = String(REPOINT_MESSAGE_TRANSACTION_SQL);
  if (s.split(DESC).length !== 2) throw new Error("EARLIEST mutation did not apply");
  return s.replace(DESC, "ORDER BY c.linked_at ASC, c.rowid ASC");
})();
const named = (tx: string): string[] =>
  (db.prepare("SELECT id FROM messages WHERE transaction_id = ?").all(tx) as Array<{ id: string }>).map((r) => r.id);
const repointAll = (ids: string[], earliest = false): void =>
  ids.forEach((m, i) => {
    if (i === 1) hit("midRepoint");
    if (earliest) db.prepare(ASC_SQL).run(m);
    else if (VARIANT === "FIX_GUARDED" || VARIANT === "GUARD_CATCHALL") {
      try { db.transaction(() => repointMessageTransaction(m))(); }
      catch (e: any) { if (VARIANT === "FIX_GUARDED" && e?.code !== "SQLITE_CONSTRAINT_FOREIGNKEY") throw e; guardedSkips++; }
    } else repointMessageTransaction(m);
  });
let pending: string[] = [];
let guardedSkips = 0;
let inBulk = false;

beforeEach(() => {
  crashAt = null; pending = []; guardedSkips = 0; inBulk = false;
  if (VARIANT === "NONE") return;
  const orig = transactionDb.deleteTransactionSync;
  jest.spyOn(databaseService, "deleteTransactionSync").mockImplementation((tx: string) => {
    if (VARIANT === "AFTER_CAPTURE") { orig(tx); hit("afterDelete"); repointAll(named(tx)); return; }
    if (VARIANT === "BROAD") {
      orig(tx); hit("afterDelete");
      repointAll((db.prepare("SELECT id FROM messages WHERE transaction_id IS NULL").all() as any[]).map((r) => r.id));
      return;
    }
    if (VARIANT === "SINGLE_ONLY" && inBulk) { orig(tx); return; }
    const ids = named(tx);
    hit("beforeDelete");
    orig(tx);
    hit("afterDelete");
    if (VARIANT === "OUTSIDE") { pending.push(...ids); return; }
    repointAll(ids, VARIANT === "EARLIEST");
  });
  if (VARIANT === "SINGLE_ONLY") {
    (logService.info as jest.Mock).mockImplementation(async (msg: string) => { if (msg === "Starting bulk delete") inBulk = true; });
  }
  if (VARIANT === "OUTSIDE") {
    (logService.info as jest.Mock).mockImplementation(async (msg: string) => {
      if (msg === "Transaction deleted" || msg === "Bulk delete completed") {
        const ids = pending; pending = []; repointAll(ids);
      }
    });
  }
});

/** A text auto-linked to B only (thread row, column NULL): pre-existing picker state. */
async function autoOnly(B: string): Promise<void> {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at)
     VALUES ('m-4020-x', ?, 'sms', 'inbound', 'x', ?, '15550101', 'thread-4020-x', '2026-01-09T10:00:00Z')`,
  ).run(USER, JSON.stringify({ from: PHONE, to: ["me"] }));
  await createThreadCommunicationReference("thread-4020-x", B, USER);
}
const colX = (): string | null => (db.prepare("SELECT transaction_id FROM messages WHERE id = 'm-4020-x'").get() as any).transaction_id;

test(`C1 single delete of A: column re-points to B [${VARIANT}]`, async () => {
  const { A, B } = await sharedPerMessage();
  expect((await invoke("transactions:delete", A)).success).toBe(true);
  expect(column()).toEqual([B, B]);
  expect(getMessageTransactionIds(IDS)).toEqual([B, B]);
  expect(picker()).toEqual([]);
  expect(deletes()).toBe(1);
});
test(`C2 bulk delete [other, A]: column re-points to B [${VARIANT}]`, async () => {
  const { A, B } = await sharedPerMessage();
  const other = deal("3 Fixture Way");
  const res = await invoke("transactions:bulk-delete", [other, A]);
  expect(res.deletedCount).toBe(2);
  expect(column()).toEqual([B, B]);
  expect(picker()).toEqual([]);
});
test(`C3 B holds only the thread row: column re-points to B [${VARIANT}]`, async () => {
  const A = deal("1 Fixture Way"); const B = deal("2 Fixture Way");
  await transactionService.linkMessages(IDS, A);
  await createThreadCommunicationReference(THREAD, B, USER);
  await invoke("transactions:delete", A);
  expect(column()).toEqual([B, B]);
});
test(`C4 most recent remaining link wins (B older, C newer) [${VARIANT}]`, async () => {
  const A = deal("1 Fixture Way"); const B = deal("2 Fixture Way"); const C = deal("3 Fixture Way");
  await transactionService.linkMessages(IDS, B);
  await transactionService.linkMessages(IDS, C);
  await transactionService.linkMessages(IDS, A);
  db.prepare("UPDATE communications SET linked_at = '2026-01-01 00:00:00' WHERE transaction_id = ?").run(B);
  db.prepare("UPDATE communications SET linked_at = '2026-02-01 00:00:00' WHERE transaction_id = ?").run(C);
  await invoke("transactions:delete", A);
  expect(column()).toEqual([C, C]);
});
test(`C5 no link left -> NULL; deleting a deal the column does not name changes nothing [${VARIANT}]`, async () => {
  const { A, B } = await sharedPerMessage();
  await invoke("transactions:delete", B);
  expect(column()).toEqual([A, A]);
  await invoke("transactions:delete", A);
  expect(column()).toEqual([null, null]);
});
test(`C6 a text auto-linked to B only keeps column NULL (stays in the picker) [${VARIANT}]`, async () => {
  const { A, B } = await sharedPerMessage();
  await autoOnly(B);
  expect(colX()).toBeNull();
  await invoke("transactions:delete", A);
  expect(colX()).toBeNull();
  expect(picker()).toContain("m-4020-x");
});

describe("C7 crash sweep, single delete: nothing changes", () => {
  for (const p of ["beforeDelete", "afterDelete", "midRepoint", "repointSqlFails", "auditFails", "auditThrows"]) {
    test(`${p} [${VARIANT}]`, async () => {
      const { A, B } = await sharedPerMessage();
      if (p === "auditFails") db.exec(`CREATE TRIGGER k1 BEFORE INSERT ON audit_logs WHEN NEW.success = 1 BEGIN SELECT RAISE(ABORT, 'forced'); END`);
      else if (p === "repointSqlFails") db.exec(`CREATE TRIGGER k_rp BEFORE UPDATE OF transaction_id ON messages WHEN NEW.transaction_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced repoint failure'); END`);
      else if (p === "auditThrows") jest.spyOn(auditService, "recordInTransaction").mockImplementation(() => { throw new Error("crash"); });
      else crashAt = p;
      const res = await invoke("transactions:delete", A).catch((e: Error) => ({ success: false, thrown: e.message }));
      expect(res.success).toBe(false);
      expect(db.prepare("SELECT count(*) AS n FROM transactions WHERE id = ?").get(A)).toEqual({ n: 1 });
      expect(column()).toEqual([A, A]);
      expect(links(A)).toEqual(IDS);
      expect(links(B)).toEqual(IDS);
      expect(deletes()).toBe(0);
    });
  }
});
test(`C8 bulk: the middle deal's re-point crashes; it stays, the others are deleted and re-pointed [${VARIANT}]`, async () => {
  const { A, B } = await sharedPerMessage();
  const before = deal("0 Fixture Way"); const after = deal("9 Fixture Way");
  const real = (databaseService.deleteTransactionSync as jest.Mock).getMockImplementation?.();
  if (real) {
    (databaseService.deleteTransactionSync as jest.Mock).mockImplementation((tx: string) => {
      crashAt = tx === A ? "midRepoint" : null;
      return real(tx);
    });
  }
  const res = await invoke("transactions:bulk-delete", [before, A, after]);
  expect(res.deletedCount).toBe(2);
  expect(db.prepare("SELECT id FROM transactions WHERE id IN (?, ?, ?) ").all(before, A, after)).toEqual([{ id: A }]);
  expect(column()).toEqual([A, A]);
  expect(links(B)).toEqual(IDS);
});
test(`C9 a legacy orphan link newer than B's does not block the delete [${VARIANT}]`, async () => {
  const { A, B } = await sharedPerMessage();
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, linked_at)
     VALUES ('c-orphan', ?, 'tx-GONE', 'm-4020-1', 'manual', '2099-01-01 00:00:00')`,
  ).run(USER);
  db.exec("PRAGMA foreign_keys = ON");
  const res = await invoke("transactions:delete", A).catch((e: Error) => ({ success: false, thrown: e.message }));
  process.stderr.write(`H1 [${VARIANT}] ${JSON.stringify(res)} deal=${JSON.stringify(db.prepare("SELECT count(*) n FROM transactions WHERE id=?").get(A))} column=${JSON.stringify(column())} B=${links(B).length} skips=${guardedSkips}\n`);
  // C9 (guarded fix): the delete still succeeds; the orphan-newest text falls back to NULL, the other re-points.
  expect(res.success).toBe(true);
  expect(column()).toEqual([null, B]);
  expect(links(B)).toEqual(IDS);
});

const perf = process.env.KEEPR_PERF_4020 === "1" ? test : test.skip;
perf(`P1 bulk delete of 10 deals x 504 shared texts on a 671,105-message store [${VARIANT}]`, async () => {
  const TOTAL = 671_105, THREADS = 4_000;
  const ins = db.prepare(
    `INSERT INTO messages (id, user_id, external_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at, message_type)
     VALUES (?, ?, ?, 'imessage', 'inbound', ?, '{"from":"+12005550100","to":["me"]}', '12005550100', ?, ?, 'text')`,
  );
  db.transaction(() => {
    for (let i = 0; i < TOTAL; i++) {
      ins.run(`p${i}`, USER, `g-${i}`, `message body ${i} about the closing and the inspection`, `chat-${i % THREADS}`,
        new Date(Date.UTC(2019, 0, 1) + (i % 2000) * 86400000).toISOString());
    }
  })();
  const B = deal("KEEP Fixture Way");
  const D = Array.from({ length: 10 }, (_, k) => deal(`${k} Delete Way`));
  const shared = Array.from({ length: 5_040 }, (_, i) => `p${i * 7}`);
  await transactionService.linkMessages(shared, B);
  for (let k = 0; k < 10; k++) await transactionService.linkMessages(shared.slice(k * 504, (k + 1) * 504), D[k]);
  // filler (raw rows, perf only): 34,630 per-message links and 40 thread links in 40 other deals
  const others = Array.from({ length: 40 }, (_, k) => deal(`${k} Other Way`));
  const insC = db.prepare(
    "INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source, linked_at) VALUES (?, ?, ?, ?, ?, 'auto', '2026-01-01 00:00:00')",
  );
  db.transaction(() => {
    for (let i = 0; i < 34_630; i++) insC.run(`f${i}`, USER, others[i % 40], `p${100_000 + i}`, null);
    for (let k = 0; k < 40; k++) insC.run(`ft${k}`, USER, others[k], null, `chat-${k}`);
  })();
  const n = (db.prepare("SELECT count(*) AS n FROM communications").get() as any).n;
  const t0 = Date.now();
  const res = await invoke("transactions:bulk-delete", D);
  const ms = Date.now() - t0;
  const col = db.prepare(`SELECT transaction_id, count(*) AS n FROM messages WHERE id IN (${shared.map(() => "?").join(",")}) GROUP BY 1`).all(...shared);
  process.stderr.write(`PROBE-4020 [${VARIANT}] messages=${TOTAL + 2} communications=${n} deleted=${res.deletedCount} shared=${shared.length} bulkDelete_ms=${ms} column=${JSON.stringify(col)}\n`);
  expect(res.deletedCount).toBe(10);
}, 900_000);
