/**
 * @jest-environment node
 *
 * BACKLOG-3785 — LINKING MANY MESSAGES MUST NOT HOLD THE MAIN PROCESS.
 *
 * Linking 150 chats (30,703 messages) into a deal that already held 76k ran
 * `transactions:link-messages` for 26.9 s without a single yield; on Windows a
 * main process that long without pumping messages turns the window "Not
 * Responding". `linkMessages` now writes in chunks of LINK_MESSAGES_CHUNK_SIZE,
 * one SQLite transaction per chunk, and yields to the event loop between chunks.
 *
 * What this suite pins (real schema.sql, real engine, real writers):
 *   1. every id is linked exactly as before — pointer + junction row, skips for
 *      already-linked and missing ids, message_count += newly linked;
 *   2. the event loop runs BETWEEN chunks (a setImmediate armed at the call
 *      fires before the last chunk executes);
 *   3. a failure inside a chunk rolls back that chunk whole — earlier chunks
 *      stay fully linked and no message is left with a pointer but no junction
 *      row (the BACKLOG-2550 half-link).
 *
 * Ids and values are invented (reserved-fictional phone range, example.com).
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
});

describe("linkMessages — chunked, yielding, atomic per chunk (BACKLOG-3785)", () => {
  it("links every id exactly as before: pointer + junction, skips, count += newly linked", async () => {
    await transactionService.linkMessages([...ids, ALREADY_LINKED, MISSING], TX);

    expect(linkedPointers()).toEqual([...ids, ALREADY_LINKED].sort());
    expect(junctionIds()).toEqual([...ids, ALREADY_LINKED].sort());
    expect(messageCount()).toBe(SEEDED_COUNT + N);
    const sources = realDb!
      .prepare(
        "SELECT DISTINCT link_source, link_confidence FROM communications WHERE transaction_id = ? AND id != 'c-already'",
      )
      .all(TX);
    expect(sources).toEqual([{ link_source: "manual", link_confidence: 1 }]);
  });

  it("runs the event loop between chunks", async () => {
    const call = transactionService.linkMessages(ids, TX);
    setImmediate(() => events.push("tick"));
    await call;

    const chunks = events.filter((e) => e === "chunk").length;
    expect(chunks).toBe(Math.ceil(N / LINK_MESSAGES_CHUNK_SIZE));
    const firstTick = events.indexOf("tick");
    const lastChunk = events.lastIndexOf("chunk");
    // The tick must land after the first chunk and before the last one.
    expect(firstTick).toBeGreaterThan(events.indexOf("chunk"));
    expect(firstTick).toBeLessThan(lastChunk);
  });

  it("a failure inside a chunk rolls that chunk back whole; earlier chunks stay linked", async () => {
    // Chunk 1 = CHUNK rows x 2 writes (pointer UPDATE, junction INSERT) + 1 count
    // UPDATE. Crash a few writes into chunk 2.
    crashAt = LINK_MESSAGES_CHUNK_SIZE * 2 + 1 + 9;
    await expect(transactionService.linkMessages(ids, TX)).rejects.toThrow("INJECTED CRASH");

    const firstChunk = ids.slice(0, LINK_MESSAGES_CHUNK_SIZE);
    expect(linkedPointers()).toEqual([...firstChunk, ALREADY_LINKED].sort());
    expect(junctionIds()).toEqual([...firstChunk, ALREADY_LINKED].sort());
    expect(messageCount()).toBe(SEEDED_COUNT + LINK_MESSAGES_CHUNK_SIZE);
    // No half-link: no pointer without a junction row.
    const half = realDb!
      .prepare(
        `SELECT m.id FROM messages m WHERE m.transaction_id = ?
           AND NOT EXISTS (SELECT 1 FROM communications c WHERE c.message_id = m.id AND c.transaction_id = m.transaction_id)`,
      )
      .all(TX);
    expect(half).toEqual([]);
  });
});
