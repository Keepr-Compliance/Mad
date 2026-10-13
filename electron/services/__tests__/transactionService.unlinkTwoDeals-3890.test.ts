/**
 * @jest-environment node
 *
 * BACKLOG-3890 — removing messages from deal A must not remove their links from deal B.
 *
 * The schema allows one message to be linked to several deals
 * (`idx_comm_msg_txn` is UNIQUE on (message_id, transaction_id), not on
 * message_id alone). `unlinkMessages(ids, A)` used to call
 * `deleteCommunicationByMessageIdSync(id)`, which ran
 * `DELETE FROM communications WHERE message_id = ?` with no transaction filter,
 * so deal B lost its per-message links too.
 *
 * Real `schema.sql`, real engine, junction rows written by the real producer
 * (`createCommunication`). Values are invented / reserved-for-documentation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";

let realDb: TestDb | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => realDb!,
  dbAll: (sql: string, params: unknown[] = []) =>
    realDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    realDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = realDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T,>(fn: () => T): T => realDb!.transaction(fn)(),
  dbExec: (sql: string) => realDb!.exec(sql),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../databaseService", () => {
  const messageDb = jest.requireActual(
    "../db/messageDbService",
  ) as typeof import("../db/messageDbService");
  const communicationDb = jest.requireActual(
    "../db/communicationDbService",
  ) as typeof import("../db/communicationDbService");
  const transactionDb = jest.requireActual(
    "../db/transactionDbService",
  ) as typeof import("../db/transactionDbService");
  const transactionContactDb = jest.requireActual(
    "../db/transactionContactDbService",
  ) as typeof import("../db/transactionContactDbService");
  return {
    __esModule: true,
    default: {
      getMessageById: async (id: string) => messageDb.getMessageById(id),
      getCommunicationsByTransaction: async (txId: string) =>
        communicationDb.getCommunicationsByTransaction(txId),
      updateTransaction: async (txId: string, updates: any) =>
        transactionDb.updateTransaction(txId, updates),
      getTransactionById: async (txId: string) => transactionDb.getTransactionById(txId),
      getTransactionContactsWithRoles: async (txId: string) =>
        transactionContactDb.getTransactionContactsWithRoles(txId),
    },
  };
});

jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");
jest.mock("../emailSyncService");
jest.mock("../messageMatchingService", () => ({
  __esModule: true,
  createCommunicationReference: jest.fn(),
}));
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

import transactionService from "../transactionService";
import {
  createCommunication,
  deleteCommunicationByMessageIdSync,
} from "../db/communicationDbService";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

const USER = "0d6e3b52-8a41-4f07-b2c9-5e1a7f3c9d80"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_A = "3a9f1c27-6d84-4b10-8e52-c7d0a4f6e193"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_B = "e14b7d90-2c35-4a68-9f71-0b8d6e2a5c47"; // pii-allow-uuid: invented for this fixture, not from any live row
const THREAD = "thread-3890";

/** In a thread — the thread-key path in unlinkMessages. */
const M_THREADED_1 = "m-3890-threaded-1";
const M_THREADED_2 = "m-3890-threaded-2";
/** No thread_id — the per-message suppression path. */
const M_THREADLESS = "m-3890-threadless";
/**
 * Seeded text_thread_count. No real recount produces it, so a deal still at the
 * sentinel was never recounted and a deal off it was.
 */
const SENTINEL_THREAD_COUNT = 99;

const SHARED = [M_THREADED_1, M_THREADED_2, M_THREADLESS];
/** Linked to B only — must be untouched by every call here. */
const M_B_ONLY = "m-3890-b-only";

function buildSchema(db: TestDb): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner@example.com", "oauth-3890");
}

function seedMessage(db: TestDb, id: string, threadId: string | null, txId: string | null): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat,
                           thread_id, sent_at, transaction_id)
     VALUES (?, ?, 'sms', 'inbound', ?, ?, ?, '2026-01-05T10:00:00Z', ?)`,
  ).run(id, USER, `body ${id}`, "+15550101", threadId, txId);
}

function link(txId: string, messageId: string): void {
  void createCommunication({
    user_id: USER,
    transaction_id: txId,
    message_id: messageId,
    link_source: "manual",
    link_confidence: 1.0,
  } as any);
}

function seedFixture(db: TestDb): void {
  for (const [tx, addr] of [
    [TX_A, "1 Example Way, Springfield"],
    [TX_B, "2 Example Way, Springfield"],
  ]) {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, status, message_count, text_thread_count)
       VALUES (?, ?, ?, 'active', 4, ?)`,
    ).run(tx, USER, addr, SENTINEL_THREAD_COUNT);
  }
  // messages.transaction_id is a single legacy column; point it at A.
  seedMessage(db, M_THREADED_1, THREAD, TX_A);
  seedMessage(db, M_THREADED_2, THREAD, TX_A);
  seedMessage(db, M_THREADLESS, null, TX_A);
  seedMessage(db, M_B_ONLY, THREAD, TX_B);

  for (const id of SHARED) {
    link(TX_A, id);
    link(TX_B, id);
  }
  link(TX_B, M_B_ONLY);
  // createCommunication recounts on every text link, so the sentinel is set
  // after seeding, not before.
  db.prepare("UPDATE transactions SET text_thread_count = ?").run(SENTINEL_THREAD_COUNT);
}

function perMessageLinks(db: TestDb, txId: string): string[] {
  return (
    db
      .prepare(
        "SELECT message_id FROM communications WHERE transaction_id = ? AND message_id IS NOT NULL ORDER BY message_id",
      )
      .all(txId) as Array<{ message_id: string }>
  ).map((r) => r.message_id);
}

function threadCount(db: TestDb, txId: string): number {
  return (
    db.prepare("SELECT text_thread_count FROM transactions WHERE id = ?").get(txId) as {
      text_thread_count: number;
    }
  ).text_thread_count;
}

beforeEach(() => {
  realDb = openTestDb();
  buildSchema(realDb);
  seedFixture(realDb);
});

afterEach(() => {
  realDb?.close();
  realDb = null;
});

describe("BACKLOG-3890 — unlink from one deal leaves the other deal's links", () => {
  it("PRECONDITION: both deals hold per-message links to the shared messages", () => {
    expect(perMessageLinks(realDb!, TX_A)).toEqual([...SHARED].sort());
    expect(perMessageLinks(realDb!, TX_B)).toEqual([M_B_ONLY, ...SHARED].sort());
  });

  it("unlinkMessages(shared, A) removes A's links and keeps every B link", async () => {
    await transactionService.unlinkMessages(SHARED, TX_A);

    expect(perMessageLinks(realDb!, TX_A)).toEqual([]);
    expect(perMessageLinks(realDb!, TX_B)).toEqual([M_B_ONLY, ...SHARED].sort());
  });

  it("unlinkMessages(shared, B) — the deal NOT named by messages.transaction_id — keeps every A link", async () => {
    await transactionService.unlinkMessages(SHARED, TX_B);

    expect(perMessageLinks(realDb!, TX_B)).toEqual([M_B_ONLY]);
    expect(perMessageLinks(realDb!, TX_A)).toEqual([...SHARED].sort());
  });

  it("deleteCommunicationByMessageIdSync(id, B) recounts B's threads and never A's", () => {
    // A's row for this message is the first one written, so an unscoped
    // pre-read would pick A and recount the wrong deal.
    deleteCommunicationByMessageIdSync(M_THREADLESS, TX_B);

    expect(threadCount(realDb!, TX_A)).toBe(SENTINEL_THREAD_COUNT);
    expect(threadCount(realDb!, TX_B)).not.toBe(SENTINEL_THREAD_COUNT);
  });

  it("deleteCommunicationByMessageIdSync(id, A) deletes only A's row", () => {
    deleteCommunicationByMessageIdSync(M_THREADLESS, TX_A);

    expect(perMessageLinks(realDb!, TX_A)).toEqual([M_THREADED_1, M_THREADED_2]);
    expect(perMessageLinks(realDb!, TX_B)).toEqual([M_B_ONLY, ...SHARED].sort());
  });

  it("deleteCommunicationByMessageIdSync(id) with no deal keeps the all-deal delete", () => {
    deleteCommunicationByMessageIdSync(M_THREADLESS);

    expect(perMessageLinks(realDb!, TX_A)).toEqual([M_THREADED_1, M_THREADED_2]);
    expect(perMessageLinks(realDb!, TX_B)).toEqual([M_B_ONLY, M_THREADED_1, M_THREADED_2]);
  });
});
