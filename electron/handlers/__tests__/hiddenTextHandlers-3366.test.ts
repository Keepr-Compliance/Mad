/**
 * @jest-environment node
 */
/*
 * BACKLOG-3366 C9 / C10 / C11 — the two hide-from-export channels.
 *
 *   C9   hide is refused when hiding is not allowed, and writes nothing;
 *        unhide never consults the check and always works.
 *   C10  hide refuses anything that is not a linked, non-reaction text of
 *        this transaction.
 *   C11  one audit row per real change, with `metadata.reason`; a repeat
 *        writes none.
 *
 * Real `schema.sql`, the real service, the real `auditService` down to the
 * `audit_logs` INSERT and its CHECK (the harness of
 * `auditTrail.createAuditedAndResubmit-2563.test.ts`). Every outcome is read
 * back from the tables, never from the handler's own verdict.
 *
 * THE GATE. `isHideFromExportAllowed` is wrapped so each test can choose, and
 * by DEFAULT it runs the REAL, SHIPPED gate — BACKLOG-3365 replaced the
 * stand-in module with `featureGateHandlers.isHideFromExportAllowed`, and the
 * `requireActual` below reaches that function, not a copy of it.
 *
 * Which means this file must say what the real gate is allowed to talk to.
 * `jest.requireActual` bypasses the mock for the module it names, NOT for that
 * module's dependencies — so the real gate runs its real chain down to
 * `supabaseService.getClient().auth.getSession()`. Left unmocked that is a live
 * outbound connection: the net guard would red the suite in `afterEach` naming
 * a HOST rather than this line, or the call would throw before any socket, the
 * gate's own `catch` would answer "unknown", and every assertion in C9 would
 * still pass while meaning nothing at all.
 *
 * So `supabaseService` is mocked to a signed-OUT session below. The default
 * then means something stronger than it used to: THE REAL GATE REFUSES HIDING
 * WHEN THE PLAN CANNOT BE READ. `blocked` and `unknown` are both refusals here,
 * which is the property that matters — `featureGateHandlers.hideFromExport-3365`
 * is where the two are told apart.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";
import { openTestDb, type TestDb } from "../../services/__tests__/helpers/syncSqliteDriver";

// `validateTransactionId` requires a UUID shape. Generated per run: no
// fixed record id is committed to the repository.
const USER: string = randomUUID();
const TRANSACTION: string = randomUUID();
const OTHER_TRANSACTION: string = randomUUID();
const THREAD = "macos-chat-3366";

let mockDb: TestDb | null = null;
const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

// The real db services reach the database through this module.
jest.mock("../../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbExec: (sql: string) => mockDb!.exec(sql),
  dbTransaction: <T,>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
  isInitialized: () => true,
}));

// `databaseService` is a heavy module; its one method the handler uses is
// delegated to the real db-layer read over the redirected connection.
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getTransactionById: (id: string) =>
      jest.requireActual("../../services/db/transactionDbService").getTransactionById(id),
  },
}));

// The boundary the REAL gate bottoms out at. Signed out, so `resolveOrgOutcome`
// answers `no_session`, the strict reader answers `unknown` and the gate answers
// false — offline, with no socket opened. `auditService` is unaffected: it takes
// its Supabase client by injection in `beforeAll`, never by import.
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    }),
  },
}));

const mockGate = jest.fn();
jest.mock("../featureGateHandlers", () => ({
  isHideFromExportAllowed: (...args: unknown[]) => mockGate(...args),
}));

import auditService from "../../services/auditService";
import * as auditLogDb from "../../services/db/auditLogDbService";
import {
  HIDE_FROM_EXPORT_NOT_ALLOWED_ERROR,
  HIDE_FROM_EXPORT_NOT_ELIGIBLE_ERROR,
  registerHiddenTextHandlers,
} from "../hiddenTextHandlers";

const SHIPPED_GATE = jest.requireActual("../featureGateHandlers") as {
  isHideFromExportAllowed: () => Promise<boolean>;
};

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

function buildDb(): TestDb {
  const db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner-3366@example.com", "oauth-3366");
  for (const t of [TRANSACTION, OTHER_TRANSACTION]) {
    db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)").run(
      t,
      USER,
      "3 Test Street",
    );
  }
  const text = db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at,
                           associated_message_type, associated_message_guid)
     VALUES (?, ?, 'imessage', ?, 'inbound', ?, '{"from":"+15550100","to":["me"]}', ?, ?, ?, ?)`,
  );
  // Linked to TRANSACTION through a thread link.
  text.run("m-linked", USER, "guid-linked", "see you at closing", THREAD, "2026-03-01T10:00:00Z", null, null);
  // A tapback on it: same thread, empty body, type in the [2000,3005] band.
  text.run("m-reaction", USER, "guid-reaction", "", THREAD, "2026-03-01T10:01:00Z", 2000, "guid-linked");
  // A text on a thread nobody linked.
  text.run("m-unlinked", USER, "guid-unlinked", "unrelated", "macos-chat-other", "2026-03-02T10:00:00Z", null, null);
  // A text linked only to OTHER_TRANSACTION, per message.
  text.run("m-other-deal", USER, "guid-other-deal", "other deal", "macos-chat-od", "2026-03-03T10:00:00Z", null, null);

  db.prepare(
    "INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('c-thread', ?, ?, ?)",
  ).run(USER, TRANSACTION, THREAD);
  db.prepare(
    "INSERT INTO communications (id, user_id, transaction_id, message_id) VALUES ('c-other', ?, ?, 'm-other-deal')",
  ).run(USER, OTHER_TRANSACTION);

  db.prepare(
    "INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES ('e-linked', ?, 'Offer', 'attached', '2026-03-04T10:00:00Z')",
  ).run(USER);
  db.prepare(
    "INSERT INTO communications (id, user_id, transaction_id, email_id) VALUES ('c-email', ?, ?, 'e-linked')",
  ).run(USER, TRANSACTION);
  return db;
}

function hiddenRows(): Array<Record<string, unknown>> {
  return mockDb!
    .prepare(
      "SELECT transaction_id, message_id, message_external_id, hidden_by FROM transaction_hidden_texts ORDER BY rowid",
    )
    .all() as Array<Record<string, unknown>>;
}

function auditRows(): Array<Record<string, unknown>> {
  return mockDb!
    .prepare(
      `SELECT action, resource_type, resource_id, user_id,
              json_extract(metadata, '$.reason') AS reason,
              json_extract(metadata, '$.messageId') AS messageId
         FROM audit_logs ORDER BY timestamp, rowid`,
    )
    .all() as Array<Record<string, unknown>>;
}

beforeAll(() => {
  // `auditService.writeToLocal` buffers (writes nothing) unless the database
  // reports initialized. This stub is production's own delegation.
  auditService.initialize(
    {
      isInitialized: () => true,
      insertAuditLog: (entry: any) => auditLogDb.insertAuditLog(entry),
      getUnsyncedAuditLogs: async () => [],
      markAuditLogsSynced: async () => undefined,
    } as any,
    { batchInsertAuditLogs: async () => undefined } as any,
  );
  registerHiddenTextHandlers();
});

afterAll(() => {
  auditService.stopSyncInterval();
});

beforeEach(() => {
  mockDb = buildDb();
  mockGate.mockReset();
  // Default: the real, shipped gate decides.
  mockGate.mockImplementation(() => SHIPPED_GATE.isHideFromExportAllowed());
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

const evt = {} as IpcMainInvokeEvent;
const invoke = (channel: string, ...args: unknown[]) => {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, ...args);
};
const hide = (messageId: string, transactionId = TRANSACTION) =>
  invoke("transactions:hide-text-from-export", transactionId, messageId);
const unhide = (messageId: string, transactionId = TRANSACTION) =>
  invoke("transactions:unhide-text-from-export", transactionId, messageId);

describe("BACKLOG-3366 C9 — hide is gated, unhide is not", () => {
  it("the REAL gate refuses hide when the plan cannot be read: failure, no hidden row, no audit row", async () => {
    const result = await hide("m-linked");

    expect(result).toEqual({ success: false, error: HIDE_FROM_EXPORT_NOT_ALLOWED_ERROR });
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(hiddenRows()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it("when hiding is allowed, hide succeeds and stores the provider id read from the message", async () => {
    mockGate.mockResolvedValue(true);

    const result = await hide("m-linked");

    expect(result).toEqual({ success: true, hidden: true });
    expect(hiddenRows()).toEqual([
      {
        transaction_id: TRANSACTION,
        message_id: "m-linked",
        message_external_id: "guid-linked",
        hidden_by: USER,
      },
    ]);
  });

  it("unhide works while hiding is refused, and never consults the check", async () => {
    mockGate.mockResolvedValue(true);
    await hide("m-linked");
    mockGate.mockReset();
    mockGate.mockImplementation(() => SHIPPED_GATE.isHideFromExportAllowed());

    const result = await unhide("m-linked");

    expect(result).toEqual({ success: true, hidden: false });
    expect(hiddenRows()).toEqual([]);
    expect(mockGate).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3366 C10 — hide refuses anything that is not a linked text of this transaction", () => {
  const cases: Array<[string, string]> = [
    ["an email id", "e-linked"],
    ["a tapback reaction row", "m-reaction"],
    ["a text on a thread nobody linked", "m-unlinked"],
    ["a text linked only to another transaction", "m-other-deal"],
    ["an id that does not exist", "m-missing"],
  ];
  for (const [label, messageId] of cases) {
    it(`${label}: failure, no hidden row, no audit row`, async () => {
      mockGate.mockResolvedValue(true);

      const result = await hide(messageId);

      expect(result).toEqual({ success: false, hidden: false, error: HIDE_FROM_EXPORT_NOT_ELIGIBLE_ERROR });
      expect(hiddenRows()).toEqual([]);
      expect(auditRows()).toEqual([]);
    });
  }

  it("rejects a transaction id that is not a UUID before doing anything", async () => {
    mockGate.mockResolvedValue(true);
    const result = await hide("m-linked", "txn-3366");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Validation error:/);
    expect(mockGate).not.toHaveBeenCalled();
    expect(hiddenRows()).toEqual([]);
  });
});

describe("BACKLOG-3366 C11 — one audit row per real change", () => {
  it("hide twice, unhide twice: exactly one hide row and one unhide row, named by metadata.reason", async () => {
    mockGate.mockResolvedValue(true);

    expect(await hide("m-linked")).toEqual({ success: true, hidden: true });
    expect(await hide("m-linked")).toEqual({ success: true, hidden: true });
    expect(await unhide("m-linked")).toEqual({ success: true, hidden: false });
    expect(await unhide("m-linked")).toEqual({ success: true, hidden: false });

    expect(auditRows()).toEqual([
      {
        action: "TRANSACTION_UPDATE",
        resource_type: "TRANSACTION",
        resource_id: TRANSACTION,
        user_id: USER,
        reason: "text_hidden_from_export",
        messageId: "m-linked",
      },
      {
        action: "TRANSACTION_UPDATE",
        resource_type: "TRANSACTION",
        resource_id: TRANSACTION,
        user_id: USER,
        reason: "text_unhidden_from_export",
        messageId: "m-linked",
      },
    ]);
  });
});
