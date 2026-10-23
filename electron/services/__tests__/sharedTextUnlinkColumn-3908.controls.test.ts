/**
 * @jest-environment node
 *
 * BACKLOG-3908 PROPOSED CONTROLS (option b). Red against today's code by design. A text linked to deal A, then auto-linked to deal B,
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
      getMessagesByContact: async (u: string, c: string, t: string) => messageDb.getMessagesByContact(u, c, t),
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
  createCommunicationSync,
  createThreadCommunicationReference,
  isThreadLinkedToTransaction,
} from "../db/communicationDbService";
import { getMessagesByContact, REPOINT_MESSAGE_TRANSACTION_SQL } from "../db/messageDbService";
import { MESSAGE_ROSTER_SQL } from "../db/messageRosterDb";
import { candidateMessageThreadsSql } from "../db/autoLinkSql";
import { linkedTextMessageIdsForThreads } from "../db/transactionTextPagingMainDb";
import { getMessageTransactionIds } from "../dealLockState";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "5b0c2e71-9d34-4a86-b1f7-3e6a8c0d2f19"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_A = "9e3d1a40-7c26-4f85-a0b9-1d4e7f2c6a83"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_B = "c2f86b17-4e90-4d3a-8b25-6a1f0e9d7c54"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_C = "4a7e0d93-1b58-4c62-9f3a-e8d5c2b1a076"; // pii-allow-uuid: invented for this fixture, not from any live row
const OTHER_USER = "d81f4b26-6c03-4e97-a5b8-0f2e9c7d3a14"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_OTHER = "7b2c9e05-3d81-4fa6-b047-5e1a8d6c9f32"; // pii-allow-uuid: invented for this fixture, not from any live row
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
    [TX_C, "3 Example Way, Springfield"],
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
const picker = (tx: string): string[] => getMessagesByContact(USER, PHONE, tx).map((m) => m.id).sort();
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

const junction = (tx: string) =>
  realDb!.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?").get(tx) as { n: number };
const ignoredFor = (tx: string) =>
  realDb!.prepare("SELECT COUNT(*) AS n FROM ignored_communications WHERE transaction_id = ?").get(tx) as { n: number };

async function removeConversationFromB(): Promise<void> {
  const ids = linkedTextMessageIdsForThreads(TX_B, [THREAD]);
  expect(ids.sort()).toEqual(IDS);
  await transactionService.unlinkMessages(ids, TX_B);
}

describe("BACKLOG-3908 controls — unlink re-points the column to a remaining link", () => {
  it("C1 reported case: column names A, removed from B -> column stays A, hidden from picker and A-candidates", async () => {
    await transactionService.linkMessages(IDS, TX_A);
    await createThreadCommunicationReference(THREAD, TX_B, USER, "auto", 0.9);
    await removeConversationFromB();
    expect(column()).toEqual([TX_A, TX_A]);
    expect(perMessageLinksA()).toEqual(IDS);
    expect(picker(TX_A)).toEqual([]);
    expect(roster()).toEqual([]);
    expect(candidatesFor(TX_A)).toEqual([]);
  });

  it("C2 wrong-fix (a) catcher: column names B, A holds a thread row -> column re-points to A", async () => {
    await createThreadCommunicationReference(THREAD, TX_A, USER, "auto", 0.9);
    await transactionService.linkMessages(IDS, TX_B);
    expect(column()).toEqual([TX_B, TX_B]);
    await removeConversationFromB();
    expect(column()).toEqual([TX_A, TX_A]);
    expect(picker(TX_B)).toEqual([]);
  });

  it("C3 ordering: B holds per-message AND thread rows -> recompute must not see B's thread row", async () => {
    await transactionService.linkMessages(IDS, TX_A);
    await createThreadCommunicationReference(THREAD, TX_B, USER, "auto", 0.9);
    await transactionService.linkMessages(IDS, TX_B);
    expect(column()).toEqual([TX_B, TX_B]);
    await removeConversationFromB();
    expect(junction(TX_B).n).toBe(0);
    expect(column()).toEqual([TX_A, TX_A]);
  });

  it("C4 no remaining link: removed from the only deal -> column NULL, back in the picker", async () => {
    await transactionService.linkMessages(IDS, TX_B);
    await removeConversationFromB();
    expect(column()).toEqual([null, null]);
    expect(picker(TX_B)).toEqual(IDS);
  });

  it("C5 atomicity: a failed re-point rolls back every write of the unlink", async () => {
    await transactionService.linkMessages(IDS, TX_A);
    await createThreadCommunicationReference(THREAD, TX_B, USER, "auto", 0.9);
    const before = junction(TX_B).n;
    expect(before).toBeGreaterThan(0);
    realDb!.exec(`CREATE TEMP TRIGGER force_3908 BEFORE UPDATE OF transaction_id ON main.messages
      WHEN NEW.transaction_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced-3908'); END`);
    await expect(removeConversationFromB()).rejects.toThrow("Could not remove those messages");
    expect(junction(TX_B).n).toBe(before);
    expect(ignoredFor(TX_B).n).toBe(0);
    expect(column()).toEqual([TX_A, TX_A]);
  });

  // SR change 1: with TWO remaining deals the column must name the MOST RECENT
  // remaining link. The deal-lock check reads this column when no deal is named
  // (dealLockState.ts getMessageTransactionIds, MESSAGE_TRANSACTION_ID_SQL).
  // A's per-message rows are written first, C's thread row second, B last.
  // linked_at is CURRENT_TIMESTAMP (second resolution), so A is backdated to
  // keep the two orderings apart on linked_at as well as rowid.
  it("C6 three deals: removed from B while A and C remain -> column names C (most recent), not A (earliest)", async () => {
    await transactionService.linkMessages(IDS, TX_A);
    realDb!
      .prepare("UPDATE communications SET linked_at = '2026-01-01 09:00:00' WHERE transaction_id = ?")
      .run(TX_A);
    await createThreadCommunicationReference(THREAD, TX_C, USER, "auto", 0.9);
    await transactionService.linkMessages(IDS, TX_B);
    expect(column()).toEqual([TX_B, TX_B]);
    await removeConversationFromB();
    expect(perMessageLinksA()).toEqual(IDS);
    expect(junction(TX_C).n).toBe(1);
    expect(column()).toEqual([TX_C, TX_C]);
    expect(getMessageTransactionIds(IDS)).toEqual([TX_C, TX_C]);
  });

  // SR change 2: the thread arm of the re-point reads TEXT thread rows only.
  // An email link row carries message_id NULL and a thread_id (the provider's
  // conversation id); if that id ever equals a text thread id, it must not be
  // taken as a link of the text.
  it("C7 thread arm ignores email link rows: an email row with the same thread_id in C -> column NULL", async () => {
    realDb!
      .prepare("INSERT INTO emails (id, user_id, subject, thread_id) VALUES (?, ?, ?, ?)")
      .run("e-3908-1", USER, "subject", THREAD);
    createCommunicationSync({
      user_id: USER,
      transaction_id: TX_C,
      email_id: "e-3908-1",
      thread_id: THREAD,
      link_source: "manual",
    } as any);
    await transactionService.linkMessages(IDS, TX_B);
    await removeConversationFromB();
    expect(junction(TX_C).n).toBe(1);
    expect(column()).toEqual([null, null]);
  });

  // SR change 2: the thread arm of the re-point reads THIS user's rows only.
  it("C8 thread arm is scoped to the message's user: another user's thread row with the same thread_id -> column NULL", async () => {
    realDb!
      .prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)")
      .run(OTHER_USER, "other@example.com", "oauth-3908-other");
    realDb!
      .prepare(
        "INSERT INTO transactions (id, user_id, property_address, status, message_count) VALUES (?, ?, ?, 'active', 0)",
      )
      .run(TX_OTHER, OTHER_USER, "9 Example Way, Springfield");
    await createThreadCommunicationReference(THREAD, TX_OTHER, OTHER_USER, "auto", 0.9);
    await transactionService.linkMessages(IDS, TX_B);
    await removeConversationFromB();
    expect(junction(TX_OTHER).n).toBe(1);
    expect(column()).toEqual([null, null]);
  });

  // The re-point runs once per removed text. Both arms must be index probes:
  // a plan on idx_communications_user_id scans every link row the user has,
  // per text (measured ~2.3x slower on a 671k-message store).
  it("C9 plan: the re-point probes the message_id and thread_id indexes, never the user_id index", () => {
    const plan = (
      realDb!.prepare(`EXPLAIN QUERY PLAN ${REPOINT_MESSAGE_TRANSACTION_SQL}`).all("m-3908-1") as Array<{
        detail: string;
      }>
    ).map((r) => r.detail);
    expect(plan.some((d) => d.includes("USING INDEX idx_communications_message_id"))).toBe(true);
    expect(plan.some((d) => d.includes("USING INDEX idx_communications_thread_id"))).toBe(true);
    expect(plan.some((d) => d.includes("idx_communications_user_id"))).toBe(false);
    expect(plan.some((d) => /SCAN c\b/.test(d))).toBe(false);
  });
});
