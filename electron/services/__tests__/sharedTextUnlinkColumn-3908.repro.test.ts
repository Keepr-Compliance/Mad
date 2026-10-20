/**
 * @jest-environment node
 *
 * BACKLOG-3908 REPRO (no fix). A text linked to deal A, then auto-linked to deal B,
 * then removed from deal B: does it reappear in A's attach picker and A's auto-link
 * candidates?
 *
 * Real schema.sql, real engine, every write through the real producer:
 *   1. transactionService.linkMessages(ids, A)        - the attach modal's write
 *   2. createThreadCommunicationReference(T, B, ...)  - autoLinkService.ts:1231's write
 *   3. linkedTextMessageIdsForThreads(B, [T]) + transactionService.unlinkMessages(ids, B)
 *                                                     - transactionTextThreadsService.unlinkTextThreads
 * Reads are the real picker / roster / candidate statements.
 * Values are invented / reserved-for-documentation.
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
  const messageDb = jest.requireActual("../db/messageDbService") as typeof import("../db/messageDbService");
  const communicationDb = jest.requireActual(
    "../db/communicationDbService",
  ) as typeof import("../db/communicationDbService");
  const transactionDb = jest.requireActual(
    "../db/transactionDbService",
  ) as typeof import("../db/transactionDbService");
  return {
    __esModule: true,
    default: {
      getMessageById: async (id: string) => messageDb.getMessageById(id),
      getMessagesByContact: async (u: string, c: string) => messageDb.getMessagesByContact(u, c),
      getCommunicationsByTransaction: async (txId: string) =>
        communicationDb.getCommunicationsByTransaction(txId),
      updateTransaction: async (txId: string, updates: any) => transactionDb.updateTransaction(txId, updates),
      getTransactionById: async (txId: string) => transactionDb.getTransactionById(txId),
      getTransactionContactsWithRoles: async () => [],
    },
  };
});

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
jest.mock("../contactsService", () => ({ __esModule: true, getContactNames: jest.fn() }));
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

import transactionService from "../transactionService";
import {
  createThreadCommunicationReference,
  isThreadLinkedToTransaction,
} from "../db/communicationDbService";
import { getMessagesByContact } from "../db/messageDbService";
import { MESSAGE_ROSTER_SQL } from "../db/messageRosterDb";
import { candidateMessageThreadsSql } from "../db/autoLinkSql";
import { linkedTextMessageIdsForThreads } from "../db/transactionTextPagingMainDb";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "5b0c2e71-9d34-4a86-b1f7-3e6a8c0d2f19"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_A = "9e3d1a40-7c26-4f85-a0b9-1d4e7f2c6a83"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_B = "c2f86b17-4e90-4d3a-8b25-6a1f0e9d7c54"; // pii-allow-uuid: invented for this fixture, not from any live row
const THREAD = "thread-3908";
const PHONE = "+15550101";
const IDS = ["m-3908-1", "m-3908-2"];

function seed(db: TestDb): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner@example.com", "oauth-3908");
  for (const [tx, addr] of [
    [TX_A, "1 Example Way, Springfield"],
    [TX_B, "2 Example Way, Springfield"],
  ]) {
    db.prepare(
      "INSERT INTO transactions (id, user_id, property_address, status, message_count) VALUES (?, ?, ?, 'active', 0)",
    ).run(tx, USER, addr);
  }
  IDS.forEach((id, i) => {
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat,
                             thread_id, sent_at)
       VALUES (?, ?, 'sms', 'inbound', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      USER,
      `body ${id}`,
      JSON.stringify({ from: PHONE, to: ["me"] }),
      "15550101",
      THREAD,
      `2026-01-0${i + 5}T10:00:00Z`,
    );
  });
}

const column = (): Array<string | null> =>
  IDS.map(
    (id) =>
      (realDb!.prepare("SELECT transaction_id FROM messages WHERE id = ?").get(id) as {
        transaction_id: string | null;
      }).transaction_id,
  );
const perMessageLinksA = (): string[] =>
  (
    realDb!
      .prepare(
        "SELECT message_id FROM communications WHERE transaction_id = ? AND message_id IS NOT NULL ORDER BY message_id",
      )
      .all(TX_A) as Array<{ message_id: string }>
  ).map((r) => r.message_id);
const picker = (): string[] => getMessagesByContact(USER, PHONE).map((m) => m.id).sort();
const roster = (): string[] =>
  (realDb!.prepare(MESSAGE_ROSTER_SQL).all(USER) as Array<{ contact: string }>).map((r) => r.contact);
const candidatesFor = (tx: string): string[] =>
  (
    realDb!
      .prepare(candidateMessageThreadsSql(1))
      .all(USER, tx, tx, tx, "%5550101%", "2025-01-01T00:00:00Z", "2027-01-01T00:00:00Z") as Array<{
      thread_id: string;
    }>
  ).map((r) => r.thread_id);

async function linkAThenAutoLinkB(): Promise<void> {
  await transactionService.linkMessages(IDS, TX_A);
  await createThreadCommunicationReference(THREAD, TX_B, USER, "auto", 0.9);
}

beforeEach(() => {
  realDb = openTestDb();
  seed(realDb);
});
afterEach(() => {
  realDb?.close();
  realDb = null;
});

describe("BACKLOG-3908 repro — shared text removed from deal B", () => {
  it("BASELINE before the unlink: column names A, A is hidden from picker/roster/A-candidates", async () => {
    await linkAThenAutoLinkB();
    expect(column()).toEqual([TX_A, TX_A]);
    expect(perMessageLinksA()).toEqual(IDS);
    expect(picker()).toEqual([]);
    expect(roster()).toEqual([]);
    expect(candidatesFor(TX_A)).toEqual([]);
    // Per-message rows carry no thread_id, so the auto-link thread guard is false for
    // A even BEFORE the unlink: the column arm of the candidate read did all the exclusion.
    expect(await isThreadLinkedToTransaction(THREAD, TX_A)).toBe(false);
    // And that column arm is what let B's auto-link pick up A's thread in the first place.
    expect(candidatesFor(TX_B)).toEqual([]); // already thread-linked to B here
  });

  it("REACH: after linkMessages(A) alone, B's auto-link candidate read returns A's thread", async () => {
    await transactionService.linkMessages(IDS, TX_A);
    expect(candidatesFor(TX_B)).toEqual([THREAD]);
  });

  it("PRE-EXISTING: a thread linked to A only by auto-link (thread row) never sets the column", async () => {
    await createThreadCommunicationReference(THREAD, TX_A, USER, "auto", 0.9);
    expect(column()).toEqual([null, null]);
    expect(picker()).toEqual(IDS);
    expect(candidatesFor(TX_A)).toEqual([]); // the thread-row arm excludes it here
  });

  it("AFTER unlink from B (fixed): A keeps its links, the column still names A, the text stays hidden", async () => {
    await linkAThenAutoLinkB();
    const ids = linkedTextMessageIdsForThreads(TX_B, [THREAD]);
    expect(ids.sort()).toEqual(IDS);
    await transactionService.unlinkMessages(ids, TX_B);

    // A still holds both per-message links, and the column is re-pointed at A
    // (BACKLOG-3908) instead of cleared.
    expect(perMessageLinksA()).toEqual(IDS);
    expect(column()).toEqual([TX_A, TX_A]);
    // Attach picker, roster and A's auto-link candidates do not offer them.
    expect(picker()).toEqual([]);
    expect(roster()).toEqual([]);
    expect(candidatesFor(TX_A)).toEqual([]);
    // The thread guard still does not see per-message rows; the column is
    // what excludes A, as before the unlink.
    expect(await isThreadLinkedToTransaction(THREAD, TX_A)).toBe(false);
    // B: suppressed, not a candidate.
    expect(candidatesFor(TX_B)).toEqual([]);
  });
});
