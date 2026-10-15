/**
 * @jest-environment node
 *
 * BACKLOG-2819 -- attachments:open and attachments:get-data write a DATA_ACCESS /
 * COMMUNICATION audit row under the real acting user.
 *
 * They used to pass userId "system". audit_logs.user_id is a FK to users_local(id) and
 * foreign_keys is ON, so that insert failed on every install and nothing was recorded.
 * Every existing handler test mocks auditService, which cannot see that.
 *
 * Here auditService and auditLogDbService are REAL. Only the connection is swapped for a
 * real in-memory SQLite (foreign_keys = ON) holding the audit_logs DDL read out of
 * schema.sql. The assertion is a SELECT on the table, not on a mock call.
 *
 *   A1  get-data: session user in users_local -> row exists, user_id = session user
 *   A2  open:     same
 *   A3  no session: no row, success, WARN
 *   A4  attachment with no linked transaction and no session: no row, success, WARN
 *   A5  a session user absent from users_local: no row, success, WARN (no owner fallback)
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

import { createIpcHandlerRegistry, type IpcHandlerRegistry } from "../../tests/support/ipcHandlerRegistry";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

const registeredHandlers: IpcHandlerRegistry = createIpcHandlerRegistry();
let mockDb: DatabaseType;
let mockSession: { user: { id: string } } | null = null;

jest.mock("electron", () => ({
  ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp"), on: jest.fn() },
  shell: { openPath: jest.fn(async () => "") },
  net: { fetch: jest.fn() },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: () => mockDb, isInitialized: jest.fn(() => true) },
}));
jest.mock("../services/db/core/dbConnection", () => ({
  dbRun: (stmt: string, params: unknown[] = []) => {
    const r = mockDb.prepare(stmt).run(...params);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
  },
  dbAll: (stmt: string, params: unknown[] = []) => mockDb.prepare(stmt).all(...params),
  ensureDb: () => mockDb,
}));
jest.mock("../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: jest.fn(async () => mockSession) },
}));
jest.mock("../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../services/emailAttachmentService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/emailAttachmentBackfillService", () => ({ backfillAttachmentMetadata: jest.fn() }));
jest.mock("../services/attachmentTextExtractionBackfillService", () => ({ backfillAttachmentTextContent: jest.fn() }));
jest.mock("../services/gmailFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/outlookFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/featureGateService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/supabaseService", () => ({ __esModule: true, default: { getClient: jest.fn() } }));
jest.mock("../services/db/emailDbService", () => ({ getEmailById: jest.fn() }));

import { registerAttachmentHandlers, resetOpenTempCleanupForTests } from "../handlers/attachmentHandlers";
import { setAttachmentReaderDepsForTests } from "../services/atRest/attachmentReader";
import { createFileCrypto, type KeyResolver } from "../services/atRest/fileCrypto";
import { createMarkerStore } from "../services/atRest/markers";
import auditService from "../services/auditService";
import logService from "../services/logService";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.randomBytes(16).toString("hex");
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
  keyFor: async () => KEY,
};
const files = createFileCrypto(resolver, { chunkSize: 64 });

const SESSION_USER = "user-session";
const TXN_OWNER = "user-txn-owner";
const STORED = "abc123.jpg";

/** The audit_logs DDL exactly as schema.sql declares it. */
function auditLogsDdl(): string {
  const schema = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
  const m = schema.match(/CREATE TABLE IF NOT EXISTS "audit_logs" \([\s\S]*?\n\s*\);/);
  if (!m) throw new Error("audit_logs DDL not found in schema.sql");
  return m[0];
}

let root: string;
let userData: string;
let encPath: string;

function createSchema(db: DatabaseType): void {
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);
    ${auditLogsDdl()}
    CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE emails (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, email_id TEXT,
      filename TEXT NOT NULL, storage_path TEXT
    );
    CREATE TABLE communications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, transaction_id TEXT,
      message_id TEXT, email_id TEXT
    );
  `);
  db.prepare(`INSERT INTO users_local (id, email) VALUES (?, ?)`).run(SESSION_USER, "s@example.test");
  db.prepare(`INSERT INTO users_local (id, email) VALUES (?, ?)`).run(TXN_OWNER, "t@example.test");
  db.prepare(`INSERT INTO transactions (id, user_id) VALUES ('t1', ?)`).run(TXN_OWNER);
  db.prepare(`INSERT INTO emails (id, user_id) VALUES ('e1', ?)`).run(TXN_OWNER);
  db.prepare(`INSERT INTO attachments (id, email_id, filename, storage_path) VALUES ('a1','e1','Doc.jpg',?)`).run(encPath);
  db.prepare(`INSERT INTO communications (id, user_id, transaction_id, email_id) VALUES ('c1',?,'t1','e1')`).run(TXN_OWNER);
}

async function invoke(channel: string, ...args: unknown[]): Promise<{ success: boolean }> {
  const fn = registeredHandlers.get(channel);
  if (!fn) throw new Error(`no handler ${channel}`);
  return fn({} as never, ...args);
}

function auditRows(): Array<{ user_id: string; action: string; resource_type: string; metadata: string }> {
  return mockDb
    .prepare(`SELECT user_id, action, resource_type, metadata FROM audit_logs WHERE action = 'DATA_ACCESS'`)
    .all() as never;
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a2819-")));
  userData = path.join(root, "keepr");
  fs.mkdirSync(path.join(userData, "message-attachments"), { recursive: true });
  fs.mkdirSync(path.join(userData, "attachments"), { recursive: true });
  encPath = path.join(userData, "message-attachments", STORED);
  await files.encryptStreamToFile(Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])]), encPath);
  setAttachmentReaderDepsForTests({
    files: () => files,
    markers: () => createMarkerStore({ userData: () => userData }),
    userData: () => userData,
  });
  mockDb = new Database(":memory:");
  createSchema(mockDb);
  mockSession = { user: { id: SESSION_USER } };
  registeredHandlers.clear();
  resetOpenTempCleanupForTests();
  registerAttachmentHandlers(null);
  jest.clearAllMocks();
});

afterEach(() => {
  mockDb.close();
  setAttachmentReaderDepsForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

beforeAll(() => {
  // The real service, wired to the real insertAuditLog over the in-memory connection.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { insertAuditLog } = require("../services/db/auditLogDbService");
  auditService.initialize(
    {
      insertAuditLog,
      getUnsyncedAuditLogs: async () => [],
      markAuditLogsSynced: async () => undefined,
      isInitialized: () => true,
    },
    { batchInsertAuditLogs: async () => undefined } as never,
  );
});

afterAll(() => {
  auditService.stopSyncInterval(); // initialize() starts a setInterval that would hold the process open
});

describe("fixture sanity", () => {
  it("a made-up user id is refused by the FK (the defect's own mechanism)", () => {
    expect(() =>
      mockDb.prepare(`INSERT INTO audit_logs (id, user_id, action) VALUES ('x','system','DATA_ACCESS')`).run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("DATA_ACCESS row lands under a real user", () => {
  it("A1 attachments:get-data", async () => {
    const res = await invoke("attachments:get-data", encPath, "image/jpeg");
    expect(res.success).toBe(true);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: SESSION_USER, action: "DATA_ACCESS", resource_type: "COMMUNICATION" });
    expect(rows[0].metadata).toContain("attachment_get_data");
  });

  it("A2 attachments:open", async () => {
    const res = await invoke("attachments:open", encPath);
    expect(res.success).toBe(true);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: SESSION_USER, action: "DATA_ACCESS", resource_type: "COMMUNICATION" });
    expect(rows[0].metadata).toContain("attachment_open");
  });

  it("A3 no session: no row, no failure, a WARN (no owner fallback)", async () => {
    mockSession = null;
    const res = await invoke("attachments:get-data", encPath, "image/jpeg");
    expect(res.success).toBe(true);
    expect(auditRows()).toHaveLength(0);
    expect(logService.warn).toHaveBeenCalledWith(expect.stringContaining("not audited"), "Transactions");
  });

  it("A5 a session user missing from users_local: no row, a WARN, never the transaction owner", async () => {
    mockSession = { user: { id: "not-a-local-user" } };
    const res = await invoke("attachments:open", encPath);
    expect(res.success).toBe(true);
    expect(auditRows()).toHaveLength(0);
    expect(logService.warn).toHaveBeenCalledWith(expect.stringContaining("not audited"), "Transactions");
  });

  it("A4 nothing resolves: no row, no failure, a WARN", async () => {
    mockSession = null;
    mockDb.prepare(`DELETE FROM communications`).run();
    const res = await invoke("attachments:get-data", encPath, "image/jpeg");
    expect(res.success).toBe(true);
    expect(auditRows()).toHaveLength(0);
    expect(logService.warn).toHaveBeenCalledWith(expect.stringContaining("not audited"), "Transactions");
    expect(logService.error).not.toHaveBeenCalled();
  });
});
