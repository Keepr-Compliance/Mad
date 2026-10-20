/**
 * @jest-environment node
 *
 * BACKLOG-3908 follow-up controls: removing texts from a deal when one text has
 * a link to a deal that no longer exists (no `transactions` row).
 *
 * Before the fix the re-point (REPOINT_MESSAGE_TRANSACTION_SQL) picked that
 * link when it was the newest, the UPDATE failed the messages -> transactions
 * foreign key, and the whole unlink rolled back ("Nothing was changed").
 *
 * Real schema.sql, real engine, foreign keys ON, every link written through the
 * real producers (transactionService.linkMessages, createThreadCommunicationReference)
 * EXCEPT the orphan row.
 *
 * ORPHAN ROW: TRANSCRIBED, NOT EXECUTED. No current writer can create a link
 * to a missing deal with foreign keys ON (SR trace, pm_comments d20ce0d1 on
 * BACKLOG-3908: writer UNTRACED, prevalence unmeasured). The row is inserted
 * with foreign_keys OFF to stand in for that state; its columns are the ones a
 * per-message link written by linkMessages carries.
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
import { createThreadCommunicationReference } from "../db/communicationDbService";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "5b0c2e71-9d34-4a86-b1f7-3e6a8c0d2f19"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_A = "9e3d1a40-7c26-4f85-a0b9-1d4e7f2c6a83"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_B = "c2f86b17-4e90-4d3a-8b25-6a1f0e9d7c54"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX_GONE = "tx-3908-gone";
const THREAD = "thread-3908";
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
      JSON.stringify({ from: "+15550101", to: ["me"] }),
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
const perMessageLinks = (tx: string): string[] =>
  (
    realDb!
      .prepare(
        "SELECT message_id FROM communications WHERE transaction_id = ? AND message_id IS NOT NULL ORDER BY message_id",
      )
      .all(tx) as Array<{ message_id: string }>
  ).map((r) => r.message_id);
const linkCount = (tx: string): number =>
  (realDb!.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?").get(tx) as { n: number }).n;

/** Transcribed state (see header): a per-message link on m-3908-1 to a deal with no row. */
function insertOrphanLink(linkedAt: string): void {
  realDb!.exec("PRAGMA foreign_keys = OFF");
  realDb!
    .prepare(
      `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, linked_at)
       VALUES ('c-3908-orphan', ?, ?, 'm-3908-1', 'manual', ?)`,
    )
    .run(USER, TX_GONE, linkedAt);
  realDb!.exec("PRAGMA foreign_keys = ON");
  expect(
    (realDb!.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id = ?").get(TX_GONE) as { n: number }).n,
  ).toBe(0);
}

beforeEach(() => {
  realDb = openTestDb();
  seed(realDb);
});
afterEach(() => {
  realDb?.close();
  realDb = null;
});

describe("BACKLOG-3908 follow-up — the re-point skips links to deals that no longer exist", () => {
  it("O1 per-message links to A then B, orphan link NEWEST on one text, remove both from B -> succeeds, both name A", async () => {
    await transactionService.linkMessages(IDS, TX_A);
    await transactionService.linkMessages(IDS, TX_B);
    insertOrphanLink("2099-01-01 00:00:00");
    expect(column()).toEqual([TX_B, TX_B]);

    await transactionService.unlinkMessages(IDS, TX_B); // threw "Nothing was changed" before the fix

    expect(perMessageLinks(TX_B)).toEqual([]);
    expect(perMessageLinks(TX_A)).toEqual(IDS);
    expect(column()).toEqual([TX_A, TX_A]);
    // the orphan row itself is left alone
    expect(linkCount(TX_GONE)).toBe(1);
  });

  it("O2 batch: A per-message, B by thread auto-link, orphan NEWEST on one text, remove both from A -> succeeds, both name B", async () => {
    await transactionService.linkMessages(IDS, TX_A);
    await createThreadCommunicationReference(THREAD, TX_B, USER, "auto", 0.9);
    insertOrphanLink("2099-01-01 00:00:00");

    await transactionService.unlinkMessages(IDS, TX_A); // threw "Nothing was changed" before the fix

    expect(perMessageLinks(TX_A)).toEqual([]);
    expect(linkCount(TX_B)).toBe(1);
    expect(column()).toEqual([TX_B, TX_B]);
  });

  it("O3 orphan is the ONLY remaining link -> succeeds, column NULL (not the missing deal)", async () => {
    await transactionService.linkMessages(IDS, TX_B);
    insertOrphanLink("2099-01-01 00:00:00");

    await transactionService.unlinkMessages(IDS, TX_B); // threw "Nothing was changed" before the fix

    expect(perMessageLinks(TX_B)).toEqual([]);
    expect(column()).toEqual([null, null]);
  });

  it("O4 orphan link OLDEST -> unchanged behaviour, both name A", async () => {
    await transactionService.linkMessages(IDS, TX_A);
    await transactionService.linkMessages(IDS, TX_B);
    insertOrphanLink("2000-01-01 00:00:00");

    await transactionService.unlinkMessages(IDS, TX_B);

    expect(column()).toEqual([TX_A, TX_A]);
  });
});
