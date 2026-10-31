/**
 * @jest-environment node
 *
 * BACKLOG-4017: the real "transactions:get-messages-by-contact" handler, real
 * schema.sql, real driver. Pins the response the picker's empty state reads:
 *   - messages empty because every chat is linked to THIS deal -> linkedToDealThreadCount > 0
 *   - a contact with no texts at all                           -> linkedToDealThreadCount 0
 *   - texts offered                                            -> linkedToDealThreadCount 0
 *   - the deal id is required (no silent unscoped read)
 *
 * Real driver: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <file>
 */
import path from "path";
import { readFileSync } from "fs";
import type { Database as DatabaseType } from "better-sqlite3";
import type { IpcMainInvokeEvent } from "electron";

const registeredHandlers = new Map<string, (...a: unknown[]) => Promise<unknown>>();
jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data"), getVersion: jest.fn(() => "0.0.0-test") },
}));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  const m = { info: noop, warn: noop, error: noop, debug: noop };
  return { __esModule: true, default: m, logService: m };
});

import { setDb } from "../db/core/dbConnection";
import { createThreadCommunicationReference } from "../db/communicationDbService";
import { registerEmailLinkingHandlers } from "../../handlers/emailLinkingHandlers";

const DRIVER = path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[4017] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const USER = "40170000-0000-4000-8000-0000000001aa"; // pii-allow-uuid: invented, not from any live row
const TXN = "40170000-0000-4000-8000-0000000001bb"; // pii-allow-uuid: invented, not from any live row
const TXN_B = "40170000-0000-4000-8000-0000000001cc"; // pii-allow-uuid: invented, not from any live row
const PHONE = "+12065550118";
const THREAD = "ios-chat-4017-h";

let db: DatabaseType;
const invoke = (...args: unknown[]): Promise<{ success: boolean; messages?: Array<{ id: string }>; linkedToDealThreadCount?: number; hasTextsAttachedToDeal?: boolean; error?: string }> => {
  const h = registeredHandlers.get("transactions:get-messages-by-contact");
  if (!h) throw new Error("handler not registered");
  return h({} as IpcMainInvokeEvent, ...args) as never;
};

maybe("BACKLOG-4017 get-messages-by-contact handler", () => {
  beforeAll(() => registerEmailLinkingHandlers());
  beforeEach(() => {
    db = new (Database as NonNullable<typeof Database>)(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
    for (const [id, addr] of [[TXN, "1 Probe Way"], [TXN_B, "2 Probe Way"]]) {
      db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, ?, 'active', '2020-01-01T00:00:00Z')").run(id, USER, addr);
    }
    for (const [id, sent] of [["m-4017-h1", "2025-01-01T10:00:00Z"], ["m-4017-h2", "2025-01-02T10:00:00Z"]]) {
      db.prepare(
        `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
         VALUES (?, ?, ?, 'imessage', 'inbound', ?, ?, ?, ?, 'text', 'b')`,
      ).run(id, USER, `g-${id}`, JSON.stringify({ from: PHONE, to: ["me"] }), PHONE.slice(1), THREAD, sent);
    }
    setDb(db);
  });
  afterEach(() => db.close());

  it("H1 every chat linked to this deal -> no messages, linkedToDealThreadCount 1", async () => {
    await createThreadCommunicationReference(THREAD, TXN, USER, "auto", 0.9);
    const res = await invoke(USER, PHONE, TXN);
    expect(res.success).toBe(true);
    expect(res.messages).toEqual([]);
    expect(res.linkedToDealThreadCount).toBe(1);
  });

  it("H2 a contact with no texts at all -> no messages, linkedToDealThreadCount 0", async () => {
    const res = await invoke(USER, "+12065550199", TXN);
    expect(res.success).toBe(true);
    expect(res.messages).toEqual([]);
    expect(res.linkedToDealThreadCount).toBe(0);
  });

  it("H3 the same chat from another deal -> offered, linkedToDealThreadCount 0", async () => {
    await createThreadCommunicationReference(THREAD, TXN, USER, "auto", 0.9);
    const res = await invoke(USER, PHONE, TXN_B);
    expect(res.messages?.map((m) => m.id).sort()).toEqual(["m-4017-h1", "m-4017-h2"]);
    expect(res.linkedToDealThreadCount).toBe(0);
  });

  it("H5 texts attached to this deal one by one -> no messages, hasTextsAttachedToDeal true; no texts at all -> false", async () => {
    db.prepare("UPDATE messages SET transaction_id = ? WHERE user_id = ?").run(TXN, USER);
    const res = await invoke(USER, PHONE, TXN);
    expect(res.messages).toEqual([]);
    expect(res.hasTextsAttachedToDeal).toBe(true);
    expect((await invoke(USER, "+12065550199", TXN)).hasTextsAttachedToDeal).toBe(false);
  });

  it("H4 a missing deal id is refused, not read unscoped", async () => {
    const res = await invoke(USER, PHONE).catch((e: Error) => ({ success: false, error: e.message }));
    expect(res.success).toBe(false);
  });
});
