/**
 * @jest-environment node
 *
 * BACKLOG-3339 slice 1 — deal create / edit / delete write their audit entry
 * in the same database transaction as the change, through the REAL handlers.
 *
 * REAL driver (better-sqlite3-multiple-ciphers), REAL shipped schema (CHECK,
 * foreign keys, the audit immutability triggers), REAL handlers
 * (`transactionCrudHandlers`), REAL `transactionService`, REAL
 * `databaseService`, REAL `transactionDbService`, REAL `auditService` and
 * `auditLogDbService`. Mocked: the IPC registry, Sentry, the application log,
 * the background sync triggers, and the cloud (a fake that records exactly
 * what `batchInsertAuditLogs` would send).
 *
 * Per site (create-audited, update, delete, bulk-delete, bulk-update-status):
 *   K0  success: the change and exactly one success entry.
 *   K1  the audit INSERT fails (a real BEFORE INSERT trigger, success rows
 *       only): the change is absent, ONE failure entry with a fixed code, and
 *       the user gets the fixed "not saved" message.
 *   K2  a crash between the change and its entry (the entry call throws after
 *       the change was written): both absent.
 *   K3  the change itself fails (a real trigger on `transactions`): no change,
 *       one failure entry with no raw error text, the original error.
 *   C1  the committed entry reaches the cloud with the 60 s interval off.
 *   Bulk: the middle deal's entry fails; the other two commit with entries.
 *
 * Mutations run against this suite (each proven applied; see the PR's
 * pm_comment): WRONG_A (entry written after the transaction), WRONG_B (an
 * async insert inside the transaction), no post-commit send.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/jest/bin/jest.js \
 *     electron/__tests__/dealAuditInTransaction-3339.test.ts
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
import { getAuditLogs } from "../services/db/auditLogDbService";
import databaseService from "../services/databaseService";
import { registerTransactionCrudHandlers } from "../handlers/transactionCrudHandlers";
import { DEAL_AUDIT_NOT_SAVED_MESSAGE } from "../services/dealChangeAudit";
import type { NewTransaction } from "../types";
import { openAuditProbeDb, realAuditDb, settle } from "../services/db/__tests__/fixtures/auditTxProbe";

// Real UUIDs: the handlers' validators reject anything else. Invented.
const USER = "33390000-0000-4000-8000-0000000000a1"; // pii-allow-uuid: invented fixture id
const ADDRESS = "1 Fixture Way, Testville, WA 98000";

let db: DatabaseType;
let uploads: AuditLogEntry[][];

const fakeCloud = {
  getAuthSession: async () => ({ userId: USER }),
  async batchInsertAuditLogs(entries: AuditLogEntry[]): Promise<void> {
    uploads.push(entries.map((e) => ({ ...e })));
  },
};

const evt = {} as IpcMainInvokeEvent;
const invoke = (channel: string, ...args: unknown[]): Promise<any> => {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, ...args);
};

beforeAll(() => {
  registerTransactionCrudHandlers(null);
});

beforeEach(() => {
  db = openAuditProbeDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner-3339@example.test", "oauth-3339-s1");
  uploads = [];
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.syncInProgress = false;
  svc.currentSync = null;
  svc.cloudSyncFailing = false;
  svc.localInsertFailing = false;
  svc.initialized = false;
  svc.pendingLocalWrites = [];
  svc.kickScheduled = false;
  auditService.setSupportAccessGate(null);
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
});

afterEach(async () => {
  jest.restoreAllMocks();
  auditService.stopSyncInterval();
  await settle();
  db.close();
});

// ---------------------------------------------------------------------------
// helpers — every read is raw SQL, never the code under test
// ---------------------------------------------------------------------------

/** A deal written straight through the db layer (no audit), for edit/delete. */
function seedDeal(address = ADDRESS): string {
  const t = databaseService.createTransactionWithContactsSync(
    {
      user_id: USER,
      property_address: address,
      transaction_type: "purchase",
      status: "active",
    } as NewTransaction,
    [],
  );
  return t.id;
}

function deals(): Array<{ id: string; status: string; property_address: string }> {
  return db
    .prepare("SELECT id, status, property_address FROM transactions ORDER BY property_address")
    .all() as Array<{ id: string; status: string; property_address: string }>;
}

type Row = { action: string; resource_id: string | null; user_id: string; success: number; error_message: string | null };
function entries(): Row[] {
  return db
    .prepare(
      "SELECT action, resource_id, user_id, success, error_message FROM audit_logs ORDER BY timestamp, rowid",
    )
    .all() as Row[];
}

/** The audit INSERT fails for success entries (optionally one resource only). */
function failSuccessEntries(resourceId?: string): void {
  const only = resourceId ? ` AND NEW.resource_id = '${resourceId}'` : "";
  db.exec(
    `CREATE TRIGGER k1_fail_entry BEFORE INSERT ON audit_logs WHEN NEW.success = 1${only}
     BEGIN SELECT RAISE(ABORT, 'forced audit insert failure'); END`,
  );
}

/** The change itself fails: a real driver error on the deal row. */
function failDealWrites(): void {
  db.exec(
    `CREATE TRIGGER k3_fail_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT, 'forced change failure at 1 Fixture Way'); END;
     CREATE TRIGGER k3_fail_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT, 'forced change failure at 1 Fixture Way'); END;
     CREATE TRIGGER k3_fail_insert BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'forced change failure at 1 Fixture Way'); END;`,
  );
}

/** A crash between the change and its entry: the entry call throws. */
function crashAtEntry(): void {
  jest.spyOn(auditService, "recordInTransaction").mockImplementation(() => {
    throw new Error("simulated crash between change and audit entry");
  });
}

// ---------------------------------------------------------------------------

test("R0 the real driver and the shipped schema are under test", () => {
  const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  expect(row.v).toMatch(/^3\.\d+/);
  expect(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'prevent_audit_update'").get(),
  ).toEqual({ n: 1 });
  expect(registeredHandlers.has("transactions:create-audited")).toBe(true);
});

// ===========================================================================
describe("transactions:create-audited", () => {
  const create = () => invoke("transactions:create-audited", USER, { property_address: ADDRESS, transaction_type: "purchase" });

  test("K0 the deal and exactly one success entry", async () => {
    const res = await create();
    expect(res.success).toBe(true);
    const id = res.transaction.id;
    expect(deals().map((d) => d.id)).toEqual([id]);
    expect(entries()).toEqual([
      { action: "TRANSACTION_CREATE", resource_id: id, user_id: USER, success: 1, error_message: null },
    ]);
    // Moved from the 2563 suite: the export's own query sees the entry, with its reason.
    const exported = await getAuditLogs({ userId: USER, limit: 50000 });
    expect(exported.map((e) => [e.action, (e.metadata as any)?.reason, (e.metadata as any)?.propertyAddress])).toEqual([
      ["TRANSACTION_CREATE", "audited_create", ADDRESS],
    ]);
  });

  test("K0 the entry exists before the background syncs are fired", async () => {
    const { triggerTransactionSyncInBackground } = jest.requireMock("../services/transactionSyncTrigger");
    let atTrigger: Row[] | null = null;
    (triggerTransactionSyncInBackground as jest.Mock).mockImplementationOnce(() => {
      atTrigger = entries();
    });
    const res = await create();
    expect(atTrigger).toEqual([
      { action: "TRANSACTION_CREATE", resource_id: res.transaction.id, user_id: USER, success: 1, error_message: null },
    ]);
  });

  test("K1 a failed entry cancels the create, records the attempt, and says so", async () => {
    failSuccessEntries();
    const res = await create();
    expect(res).toEqual({ success: false, error: DEAL_AUDIT_NOT_SAVED_MESSAGE.create });
    expect(deals()).toEqual([]);
    await settle();
    expect(entries()).toEqual([
      { action: "TRANSACTION_CREATE", resource_id: null, user_id: USER, success: 0, error_message: "audit_entry_not_written" },
    ]);
  });

  test("K2 a crash between the deal and its entry leaves neither", async () => {
    crashAtEntry();
    const res = await create();
    expect(res.success).toBe(false);
    expect(deals()).toEqual([]);
    await settle();
    expect(entries().filter((e) => e.success === 1)).toEqual([]);
  });

  test("K3 a failed create writes no deal and one failure entry with no raw error text", async () => {
    failDealWrites();
    const res = await create();
    expect(res.success).toBe(false);
    expect(res.error).toContain("forced change failure");
    expect(deals()).toEqual([]);
    await settle();
    expect(entries()).toEqual([
      { action: "TRANSACTION_CREATE", resource_id: null, user_id: USER, success: 0, error_message: "change_failed:SqliteError" },
    ]);
  });

  test("C1 the committed entry reaches the cloud with no interval running", async () => {
    const res = await create();
    await settle();
    expect(uploads.flat().map((e) => [e.action, e.resourceId])).toEqual([["TRANSACTION_CREATE", res.transaction.id]]);
  });
});

// ===========================================================================
describe("transactions:update", () => {
  test("K0 the edit and exactly one success entry", async () => {
    const id = seedDeal();
    const res = await invoke("transactions:update", id, { status: "closed" });
    expect(res).toEqual({ success: true });
    expect(deals()).toEqual([{ id, status: "closed", property_address: ADDRESS }]);
    expect(entries()).toEqual([
      { action: "TRANSACTION_UPDATE", resource_id: id, user_id: USER, success: 1, error_message: null },
    ]);
  });

  test("K1 a failed entry cancels the edit, records the attempt, and says so", async () => {
    const id = seedDeal();
    failSuccessEntries();
    const res = await invoke("transactions:update", id, { status: "closed" });
    expect(res).toEqual({ success: false, error: DEAL_AUDIT_NOT_SAVED_MESSAGE.update });
    expect(deals()).toEqual([{ id, status: "active", property_address: ADDRESS }]);
    await settle();
    expect(entries()).toEqual([
      { action: "TRANSACTION_UPDATE", resource_id: id, user_id: USER, success: 0, error_message: "audit_entry_not_written" },
    ]);
  });

  test("K2 a crash between the edit and its entry leaves neither", async () => {
    const id = seedDeal();
    crashAtEntry();
    const res = await invoke("transactions:update", id, { status: "closed" });
    expect(res.success).toBe(false);
    expect(deals()).toEqual([{ id, status: "active", property_address: ADDRESS }]);
    await settle();
    expect(entries().filter((e) => e.success === 1)).toEqual([]);
  });

  test("K3 a failed edit changes nothing and writes one failure entry with no raw error text", async () => {
    const id = seedDeal();
    failDealWrites();
    const res = await invoke("transactions:update", id, { status: "closed" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("forced change failure");
    expect(deals()).toEqual([{ id, status: "active", property_address: ADDRESS }]);
    await settle();
    expect(entries()).toEqual([
      { action: "TRANSACTION_UPDATE", resource_id: id, user_id: USER, success: 0, error_message: "change_failed:SqliteError" },
    ]);
  });

  test("a deal that no longer exists: nothing written, no 'unknown' entry", async () => {
    const res = await invoke("transactions:update", "33390000-0000-4000-8000-0000000000ff", { status: "closed" }); // pii-allow-uuid: invented fixture id
    expect(res).toEqual({ success: false, error: "This deal no longer exists." });
    expect(entries()).toEqual([]);
  });

  test("C1 the committed entry reaches the cloud with no interval running", async () => {
    const id = seedDeal();
    await invoke("transactions:update", id, { status: "closed" });
    await settle();
    expect(uploads.flat().map((e) => [e.action, e.resourceId])).toEqual([["TRANSACTION_UPDATE", id]]);
  });
});

// ===========================================================================
describe("transactions:delete", () => {
  test("K0 the delete and exactly one success entry", async () => {
    const id = seedDeal();
    const res = await invoke("transactions:delete", id);
    expect(res).toEqual({ success: true });
    expect(deals()).toEqual([]);
    expect(entries()).toEqual([
      { action: "TRANSACTION_DELETE", resource_id: id, user_id: USER, success: 1, error_message: null },
    ]);
  });

  test("K1 a failed entry cancels the delete (the deal stays), records the attempt, and says so", async () => {
    const id = seedDeal();
    failSuccessEntries();
    const res = await invoke("transactions:delete", id);
    expect(res).toEqual({ success: false, error: DEAL_AUDIT_NOT_SAVED_MESSAGE.delete });
    expect(deals()).toEqual([{ id, status: "active", property_address: ADDRESS }]);
    await settle();
    expect(entries()).toEqual([
      { action: "TRANSACTION_DELETE", resource_id: id, user_id: USER, success: 0, error_message: "audit_entry_not_written" },
    ]);
  });

  test("K2 a crash between the delete and its entry leaves the deal and no entry", async () => {
    const id = seedDeal();
    crashAtEntry();
    const res = await invoke("transactions:delete", id);
    expect(res.success).toBe(false);
    expect(deals()).toEqual([{ id, status: "active", property_address: ADDRESS }]);
    await settle();
    expect(entries().filter((e) => e.success === 1)).toEqual([]);
  });

  test("K3 a failed delete keeps the deal and writes one failure entry with no raw error text", async () => {
    const id = seedDeal();
    failDealWrites();
    const res = await invoke("transactions:delete", id);
    expect(res.success).toBe(false);
    expect(res.error).toContain("forced change failure");
    expect(deals()).toEqual([{ id, status: "active", property_address: ADDRESS }]);
    await settle();
    expect(entries()).toEqual([
      { action: "TRANSACTION_DELETE", resource_id: id, user_id: USER, success: 0, error_message: "change_failed:SqliteError" },
    ]);
  });

  test("C1 the committed entry reaches the cloud with no interval running", async () => {
    const id = seedDeal();
    await invoke("transactions:delete", id);
    await settle();
    expect(uploads.flat().map((e) => [e.action, e.resourceId])).toEqual([["TRANSACTION_DELETE", id]]);
  });
});

// ===========================================================================
describe("transactions:bulk-delete", () => {
  test("K0 every deal deleted, one success entry each", async () => {
    const ids = [seedDeal("1 A St"), seedDeal("2 B St"), seedDeal("3 C St")];
    const res = await invoke("transactions:bulk-delete", ids);
    expect(res).toMatchObject({ success: true, deletedCount: 3 });
    expect(deals()).toEqual([]);
    expect(entries().map((e) => [e.action, e.resource_id, e.success])).toEqual(
      ids.map((id) => ["TRANSACTION_DELETE", id, 1]),
    );
  });

  test("K1 the middle deal's entry fails: it stays, the other two are deleted with entries", async () => {
    const [a, b, c] = [seedDeal("1 A St"), seedDeal("2 B St"), seedDeal("3 C St")];
    failSuccessEntries(b);
    const res = await invoke("transactions:bulk-delete", [a, b, c]);
    expect(res.success).toBe(false);
    expect(res.deletedCount).toBe(2);
    expect(res.error).toBe(
      "1 deal was not deleted because the audit record could not be saved. Those deals are unchanged. Please try again.",
    );
    expect(deals().map((d) => d.id)).toEqual([b]);
    await settle();
    expect(entries().map((e) => [e.resource_id, e.success, e.error_message])).toEqual([
      [a, 1, null],
      [b, 0, "audit_entry_not_written"],
      [c, 1, null],
    ]);
  });

  test("K2 a crash at every entry deletes nothing", async () => {
    const ids = [seedDeal("1 A St"), seedDeal("2 B St")];
    crashAtEntry();
    const res = await invoke("transactions:bulk-delete", ids);
    expect(res).toMatchObject({ success: false, deletedCount: 0 });
    expect(deals().map((d) => d.id).sort()).toEqual([...ids].sort());
    await settle();
    expect(entries().filter((e) => e.success === 1)).toEqual([]);
  });
});

// ===========================================================================
describe("transactions:bulk-update-status", () => {
  test("K0 every deal changed, one success entry each", async () => {
    const ids = [seedDeal("1 A St"), seedDeal("2 B St"), seedDeal("3 C St")];
    const res = await invoke("transactions:bulk-update-status", ids, "closed");
    expect(res).toMatchObject({ success: true, updatedCount: 3 });
    expect(deals().map((d) => d.status)).toEqual(["closed", "closed", "closed"]);
    expect(entries().map((e) => [e.action, e.resource_id, e.success])).toEqual(
      ids.map((id) => ["TRANSACTION_UPDATE", id, 1]),
    );
  });

  test("K1 the middle deal's entry fails: it keeps its status, the other two change with entries", async () => {
    const [a, b, c] = [seedDeal("1 A St"), seedDeal("2 B St"), seedDeal("3 C St")];
    failSuccessEntries(b);
    const res = await invoke("transactions:bulk-update-status", [a, b, c], "closed");
    expect(res.success).toBe(false);
    expect(res.updatedCount).toBe(2);
    expect(res.error).toBe(
      "1 deal was not changed because the audit record could not be saved. Those deals are unchanged. Please try again.",
    );
    expect(deals().map((d) => [d.id, d.status])).toEqual([
      [a, "closed"],
      [b, "active"],
      [c, "closed"],
    ]);
    await settle();
    expect(entries().map((e) => [e.resource_id, e.success, e.error_message])).toEqual([
      [a, 1, null],
      [b, 0, "audit_entry_not_written"],
      [c, 1, null],
    ]);
  });

  test("K2 a crash at every entry changes nothing", async () => {
    const ids = [seedDeal("1 A St"), seedDeal("2 B St")];
    crashAtEntry();
    const res = await invoke("transactions:bulk-update-status", ids, "closed");
    expect(res).toMatchObject({ success: false, updatedCount: 0 });
    expect(deals().map((d) => d.status)).toEqual(["active", "active"]);
    await settle();
    expect(entries().filter((e) => e.success === 1)).toEqual([]);
  });
});
