/**
 * @jest-environment node
 *
 * BACKLOG-4020 timing probe (skipped unless KEEPR_PERF_4020=1). Bulk delete of
 * 10 deals, each naming 504 texts that a kept deal also holds (5,040 re-points),
 * on a 671,105-message store in an ENCRYPTED file database (SQLCipher, WAL,
 * foreign keys ON), through the real bulk-delete handler. Values are invented.
 *
 *   KEEPR_PERF_4020=1 ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <this file>
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
jest.mock("../../services/logService", () => {
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
jest.mock("../../services/transactionSyncTrigger", () => ({
  triggerTransactionSyncInBackground: jest.fn(),
  isAutoSyncInFlight: jest.fn(() => false),
  ensureTransactionEmailsSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
jest.mock("../../services/messagesSyncTrigger", () => ({
  triggerMessagesSyncInBackground: jest.fn(),
  ensureTransactionMessagesSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
jest.mock("../../services/databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../services/contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { auditService, type AuditLogEntry } from "../../services/auditService";
import databaseService from "../../services/databaseService";
import transactionService from "../../services/transactionService";
import { registerTransactionCrudHandlers } from "../../handlers/transactionCrudHandlers";
import type { NewTransaction } from "../../types";
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { setDb } from "../../services/db/core/dbConnection";
import { realAuditDb, settle } from "../../services/db/__tests__/fixtures/auditTxProbe";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
const KEY_HEX = "4020".repeat(16);

const USER = "40200000-0000-4000-8000-0000000000a1"; // pii-allow-uuid: invented fixture id

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

const maybe = process.env.KEEPR_PERF_4020 === "1" ? describe : describe.skip;

maybe("BACKLOG-4020 bulk delete re-point timing, encrypted file database", () => {
  let dir: string;
  let db: DatabaseType;

  beforeAll(() => {
    registerTransactionCrudHandlers(null);
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-4020-probe-"));
    db = new Database(nodePath.join(dir, "mad.db")) as unknown as DatabaseType;
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "../../database/schema.sql"), "utf8"));
    setDb(db);
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
    ).run(USER, "owner-4020@example.test", "oauth-4020");
    auditService.setSupportAccessGate(null);
    auditService.initialize(realAuditDb as never, fakeCloud as never);
    auditService.stopSyncInterval();
  });

  afterAll(async () => {
    auditService.stopSyncInterval();
    await settle();
    db.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  });

  const deal = (addr: string): string =>
    databaseService.createTransactionWithContactsSync(
      { user_id: USER, property_address: addr, transaction_type: "purchase", status: "active" } as NewTransaction,
      [],
    ).id;

  test("P1 bulk delete of 10 deals x 504 shared texts on a 671,105-message store", async () => {
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
    // filler (raw rows, timing only): 34,630 per-message links and 40 thread links in 40 other deals
    const others = Array.from({ length: 40 }, (_, k) => deal(`${k} Other Way`));
    const insC = db.prepare(
      "INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source, linked_at) VALUES (?, ?, ?, ?, ?, 'auto', '2026-01-01 00:00:00')",
    );
    db.transaction(() => {
      for (let i = 0; i < 34_630; i++) insC.run(`f${i}`, USER, others[i % 40], `p${100_000 + i}`, null);
      for (let k = 0; k < 40; k++) insC.run(`ft${k}`, USER, others[k], null, `chat-${k}`);
    })();
    db.pragma("wal_checkpoint(TRUNCATE)");
    const cipher = db.pragma("cipher", { simple: true });
    const n = (db.prepare("SELECT count(*) AS n FROM communications").get() as any).n;
    const t0 = Date.now();
    const res = await invoke("transactions:bulk-delete", D);
    const ms = Date.now() - t0;
    const col = db.prepare(
      `SELECT transaction_id, count(*) AS n FROM messages WHERE id IN (${shared.map(() => "?").join(",")}) GROUP BY 1`,
    ).all(...shared) as Array<{ transaction_id: string | null; n: number }>;
    process.stderr.write(
      `PROBE-4020 cipher=${cipher} messages=${TOTAL} communications=${n} deleted=${res.deletedCount} shared=${shared.length} bulkDelete_ms=${ms} column=${JSON.stringify(col.map((r) => [r.transaction_id === B ? "B" : r.transaction_id, r.n]))}\n`,
    );
    expect(res.deletedCount).toBe(10);
  }, 900_000);
});
