/**
 * @jest-environment node
 *
 * BACKLOG-3785 — A QUIT REQUEST MUST NOT LAND BETWEEN LINK CHUNKS.
 *
 * linkMessages yields between chunks, so Cmd-Q / Quit / close-to-quit / update
 * install can arrive mid-link. The before-quit handler (electron/main.ts) defers
 * the quit while a link runs (electron/utils/linkInFlight.ts), bounded by a max
 * wait, using the same deferral as the iPhone backup (BACKLOG-3598). Real
 * schema.sql, real engine, real linkMessages.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";

let realDb: TestDb | null = null;
/** Ordered record of chunk transactions and event-loop ticks. */
let events: string[] = [];
let writeCount = 0;
let crashAt = 0;
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

const instrumented: TestDb = {
  prepare(sql: string) {
    const stmt = realDb!.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        if (IS_WRITE.test(sql)) {
          writeCount += 1;
          if (crashAt !== 0 && writeCount === crashAt) {
            throw new Error(`INJECTED CRASH at write ${writeCount}`);
          }
        }
        return stmt.run(...params);
      },
      get: (...params: unknown[]) => stmt.get(...params),
      all: (...params: unknown[]) => stmt.all(...params),
    };
  },
  exec: (sql: string) => realDb!.exec(sql),
  close: () => realDb!.close(),
  transaction: <T,>(fn: () => T) => realDb!.transaction(fn),
} as unknown as TestDb;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => instrumented,
  dbAll: (sql: string, params: unknown[] = []) =>
    instrumented.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    instrumented.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = instrumented.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  // A REAL transaction (never `(fn) => fn()`), recorded so the order of chunks
  // against event-loop ticks is observable.
  dbTransaction: <T,>(fn: () => T): T => {
    events.push("chunk");
    return instrumented.transaction(fn)();
  },
  dbExec: () => {
    throw new Error("unexpected dbExec on the link write path");
  },
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../databaseService", () => {
  const transactionDb = jest.requireActual(
    "../db/transactionDbService",
  ) as typeof import("../db/transactionDbService");
  return {
    __esModule: true,
    default: {
      getTransactionById: async (txId: string) => transactionDb.getTransactionById(txId),
      updateTransaction: async (txId: string, updates: any) =>
        transactionDb.updateTransaction(txId, updates),
    },
  };
});

// Import-graph ballast — not on the link path.
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");
jest.mock("../emailSyncService");
jest.mock("../autoLinkService", () => ({
  __esModule: true,
  autoLinkCommunicationsForContact: jest.fn(),
}));
jest.mock("../contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(),
}));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logTransactionAction: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
  isTextPeopleEnabled: jest.fn().mockResolvedValue(true),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

import transactionService, {
  LINK_MESSAGES_CHUNK_SIZE,
} from "../transactionService/transactionService";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "0d7c3e21-6a4b-4f19-8e52-1b9a7c4d2e60"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX = "5e2a9b14-7c3d-4e81-a6f0-3d8b1c5e7a92"; // pii-allow-uuid: invented for this fixture, not from any live row
const SEEDED_COUNT = 7;
const ALREADY_LINKED = "m-already";
const MISSING = "m-missing-row";
/** Two full chunks and a partial third: every chunk boundary is crossed. */
const N = LINK_MESSAGES_CHUNK_SIZE * 2 + 3;
const ids = Array.from({ length: N }, (_, i) => `m-${String(i).padStart(5, "0")}`);

function seed(db: TestDb): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner@example.com", "oauth-3785");
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, message_count)
     VALUES (?, ?, ?, 'active', ?)`,
  ).run(TX, USER, "1 Example Way, Springfield", SEEDED_COUNT);
  const insert = db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat,
                           thread_id, sent_at, transaction_id)
     VALUES (?, ?, 'sms', 'inbound', ?, '5550142', 'thread-3785', '2026-01-05T10:00:00Z', ?)`,
  );
  for (const id of ids) insert.run(id, USER, `body ${id}`, null);
  insert.run(ALREADY_LINKED, USER, "body already", TX);
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, link_confidence)
     VALUES ('c-already', ?, ?, ?, 'manual', 1.0)`,
  ).run(USER, TX, ALREADY_LINKED);
}

const linkedPointers = (): string[] =>
  (realDb!
    .prepare("SELECT id FROM messages WHERE transaction_id = ? ORDER BY id")
    .all(TX) as Array<{ id: string }>).map((r) => r.id);
const junctionIds = (): string[] =>
  (realDb!
    .prepare("SELECT message_id FROM communications WHERE transaction_id = ? ORDER BY message_id")
    .all(TX) as Array<{ message_id: string }>).map((r) => r.message_id);
const messageCount = (): number =>
  (realDb!.prepare("SELECT message_count FROM transactions WHERE id = ?").get(TX) as {
    message_count: number;
  }).message_count;

import { createBackupStopOnQuit } from "../../utils/backupStopOnQuit";
import {
  beginLink,
  linkInFlightCount,
  waitForLinksToFinish,
} from "../../utils/linkInFlight";

/** The exact wiring electron/main.ts uses. */
function makeQuitHandler(maxWaitMs?: number, onTimeout?: () => void) {
  const app = { quit: jest.fn() };
  const handler = createBackupStopOnQuit(app, () => waitForLinksToFinish(maxWaitMs, onTimeout));
  return { app, handler };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  realDb = openTestDb();
  seed(realDb);
  events = [];
  writeCount = 0;
  crashAt = 0;
});

afterEach(() => {
  realDb?.close();
  realDb = null;
  jest.useRealTimers();
});

describe("quit during linkMessages (BACKLOG-3785)", () => {
  it("quit requested mid-link: the link finishes every chunk, then the quit proceeds", async () => {
    const { app, handler } = makeQuitHandler();
    const event = { preventDefault: jest.fn() };
    let deferred: boolean | null = null;
    let quitCallsAtDeferral = -1;

    const call = transactionService.linkMessages(ids, TX);
    // Fires during the first yield: chunk 1 is committed, chunks 2 and 3 are not.
    setImmediate(() => {
      expect(events.filter((e) => e === "chunk").length).toBe(1);
      deferred = handler(event);
      quitCallsAtDeferral = app.quit.mock.calls.length;
    });
    await call;
    await flush();

    expect(deferred).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(quitCallsAtDeferral).toBe(0);
    // Every chunk ran before the quit was re-issued.
    expect(events.filter((e) => e === "chunk").length).toBe(
      Math.ceil(N / LINK_MESSAGES_CHUNK_SIZE),
    );
    expect(messageCount()).toBe(SEEDED_COUNT + N);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(linkInFlightCount()).toBe(0);
  });

  it("the counter is released when a chunk throws, so a failed link cannot hold the quit", async () => {
    const { app, handler } = makeQuitHandler();
    crashAt = 5;
    const call = transactionService.linkMessages(ids, TX);
    const result = expect(call).rejects.toThrow("INJECTED CRASH");
    await result;
    expect(linkInFlightCount()).toBe(0);
    expect(handler({ preventDefault: jest.fn() })).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("no link running: the quit is not deferred", () => {
    const { app, handler } = makeQuitHandler();
    const event = { preventDefault: jest.fn() };
    expect(handler(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("max-wait path: a link that never ends is abandoned after the bound; the quit proceeds and is logged", async () => {
    jest.useFakeTimers();
    const onTimeout = jest.fn();
    const { app, handler } = makeQuitHandler(60_000, onTimeout);
    const endStuck = beginLink(); // a link that never finishes
    const event = { preventDefault: jest.fn() };

    expect(handler(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(59_999);
    await flush();
    expect(app.quit).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flush();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // The re-quit is not deferred a second time.
    expect(handler({ preventDefault: jest.fn() })).toBe(false);
    endStuck();
  });
});
