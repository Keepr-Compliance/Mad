/**
 * @jest-environment node
 */
/*
 * BACKLOG-3366 — the shared conversation read MARKS hidden texts and never
 * filters them, and its content de-dup keeps the hidden copy.
 *
 * Real SQLite over the production `schema.sql` (same harness as
 * `communicationDbService.rowLimit-3102.test.ts`). Links are created with the
 * real producers (`createCommunicationReference`,
 * `createThreadCommunicationReference`) and hides with the real service
 * (`hideTextFromExport`), so the stored `message_external_id` is whatever the
 * service copies from the message row, never a value the test chose.
 *
 * Run under Electron's node (the shared native module is Electron-ABI at rest):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 *
 * What each block holds, and the wrong build it catches:
 *   C1a/C1b/C1c  filtering in the read (rows vanish); a marker keyed on
 *                c.message_id (C1c is the only case that separates it: a
 *                thread-linked text with no external_id)
 *   C2           a hide keyed on the message without the transaction
 *   C3           a hide keyed on the thread
 *   C5           the old first-wins content de-dup (swept over both copies,
 *                both link orders and both message orders)
 *   C6           a LEFT JOIN marker instead of EXISTS (visible only with LIMIT)
 *   C7           hiding by unlinking or deleting
 *   C8           hiding by recounting or decrementing the stored counts
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  require("path").join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../core/dbConnection";
import {
  createCommunicationReference,
  createThreadCommunicationReference,
  getCommunicationsWithMessages,
} from "../communicationDbService";
import { hideTextFromExport, unhideTextFromExport } from "../hiddenTextDbService";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-3366";
const T1 = "txn-3366-1";
const T2 = "txn-3366-2";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "user-3366@example.test", "oauth-3366");
  for (const t of [T1, T2]) {
    db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)").run(
      t,
      USER,
      "1 Test Street",
    );
  }
  setDb(db);
});

afterEach(() => {
  db?.close();
});

/** A text row in the shape the macOS importer writes (guid as external_id). */
function insertText(
  id: string,
  thread: string,
  body: string,
  sentAt: string,
  externalId: string | null = `guid-${id}`,
): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at)
     VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?, ?, ?)`,
  ).run(id, USER, externalId, body, JSON.stringify({ from: "+15550100", to: ["me"] }), thread, sentAt);
}

const linkMessage = (txn: string, id: string) =>
  createCommunicationReference({ user_id: USER, message_id: id, transaction_id: txn, link_source: "manual" });
const linkThread = (txn: string, thread: string) =>
  createThreadCommunicationReference(thread, txn, USER, "manual");
const hide = (txn: string, id: string) =>
  hideTextFromExport({ transactionId: txn, messageId: id, userId: USER });

async function markers(txn: string, filter?: "text", limit?: number): Promise<Record<string, unknown>> {
  const rows = (await getCommunicationsWithMessages(txn, filter, limit)) as unknown as Array<{
    id: string;
    hidden_from_export: unknown;
  }>;
  return Object.fromEntries(rows.map((r) => [r.id, r.hidden_from_export]));
}

function threeTexts(thread = "macos-chat-1"): void {
  insertText("m1", thread, "one", "2026-01-01T10:00:00Z");
  insertText("m2", thread, "two", "2026-01-02T10:00:00Z");
  insertText("m3", thread, "three", "2026-01-03T10:00:00Z");
}

describe("BACKLOG-3366 C1 — the read marks a hidden text and still returns it", () => {
  it("C1a per-message links: all 3 rows returned, exactly the hidden one marked with the NUMBER 1", async () => {
    threeTexts();
    for (const id of ["m1", "m2", "m3"]) await linkMessage(T1, id);
    expect(await hide(T1, "m2")).toBe(true);

    const m = await markers(T1, "text");
    expect(m).toEqual({ m1: 0, m2: 1, m3: 0 });
    // SQLite's EXISTS yields a number. The renderer type is `0 | 1`.
    expect(typeof m.m2).toBe("number");
    // The export read (no channel filter) returns the same rows.
    expect(await markers(T1)).toEqual({ m1: 0, m2: 1, m3: 0 });
  });

  it("C1b thread link: all 3 rows returned, exactly the hidden one marked", async () => {
    threeTexts();
    await linkThread(T1, "macos-chat-1");
    expect(await hide(T1, "m2")).toBe(true);

    expect(await markers(T1, "text")).toEqual({ m1: 0, m2: 1, m3: 0 });
    expect(await markers(T1)).toEqual({ m1: 0, m2: 1, m3: 0 });
  });

  it("C1c thread link, texts with NO external_id: exactly the hidden one marked (the message-id arm alone)", async () => {
    insertText("m1", "chat-null-ext", "one", "2026-01-01T10:00:00Z", null);
    insertText("m2", "chat-null-ext", "two", "2026-01-02T10:00:00Z", null);
    await linkThread(T1, "chat-null-ext");
    expect(await hide(T1, "m2")).toBe(true);

    const stored = db
      .prepare("SELECT message_id, message_external_id FROM transaction_hidden_texts")
      .all();
    expect(stored).toEqual([{ message_id: "m2", message_external_id: null }]);
    expect(await markers(T1, "text")).toEqual({ m1: 0, m2: 1 });
  });

  it("an email in the same transaction carries the marker 0", async () => {
    threeTexts();
    await linkThread(T1, "macos-chat-1");
    db.prepare(
      `INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES ('e1', ?, 'Offer', 'see attached', '2026-01-04T10:00:00Z')`,
    ).run(USER);
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, email_id) VALUES ('c-e1', ?, ?, 'e1')`,
    ).run(USER, T1);
    await hide(T1, "m2");

    expect(await markers(T1)).toEqual({ e1: 0, m1: 0, m2: 1, m3: 0 });
  });
});

describe("BACKLOG-3366 C2/C3 — a hide belongs to one transaction and one message", () => {
  it("C2 the same thread linked to two transactions: hidden in T1 is not hidden in T2", async () => {
    threeTexts();
    await linkThread(T1, "macos-chat-1");
    await linkThread(T2, "macos-chat-1");
    expect(await hide(T1, "m2")).toBe(true);

    expect(await markers(T1, "text")).toEqual({ m1: 0, m2: 1, m3: 0 });
    expect(await markers(T2, "text")).toEqual({ m1: 0, m2: 0, m3: 0 });
  });

  it("C3 a message that arrives on the thread after the hide is not hidden; the hidden one still is", async () => {
    threeTexts();
    await linkThread(T1, "macos-chat-1");
    await hide(T1, "m2");

    insertText("m4", "macos-chat-1", "four", "2026-01-04T10:00:00Z");
    expect(await markers(T1, "text")).toEqual({ m1: 0, m2: 1, m3: 0, m4: 0 });
  });
});

describe("BACKLOG-3366 C5 — within identical copies, the hidden copy is the one both reads keep", () => {
  const orders: Array<[string, [string, string]]> = [
    ["A first", ["A", "B"]],
    ["B first", ["B", "A"]],
  ];

  // Proves the sweep reaches both first-wins outcomes: with nothing hidden the
  // survivor follows insertion order, so for every shape one of the two hide
  // cases below is the copy the old rule would have DROPPED.
  it("precondition: with nothing hidden, the survivor follows insertion order in both shapes", async () => {
    const survivors: string[] = [];
    for (const [, order] of orders) {
      db.exec("DELETE FROM communications; DELETE FROM messages;");
      for (const id of order) insertText(id, "chat-dup", "DUP", "2026-01-05T10:00:00Z");
      await linkThread(T1, "chat-dup");
      survivors.push(Object.keys(await markers(T1, "text")).join(","));
    }
    for (const [, order] of orders) {
      db.exec("DELETE FROM communications; DELETE FROM messages;");
      insertText("A", "chat-a", "DUP", "2026-01-05T10:00:00Z");
      insertText("B", "chat-b", "DUP", "2026-01-05T10:00:00Z");
      for (const id of order) await linkMessage(T1, id);
      survivors.push(Object.keys(await markers(T1, "text")).join(","));
    }
    expect(survivors).toEqual(["A", "B", "A", "B"]);
  });

  for (const [name, order] of orders) {
    for (const hidden of ["A", "B"]) {
      it(`one thread link, messages inserted ${name}, hide ${hidden}: both reads keep ${hidden}, marked`, async () => {
        for (const id of order) insertText(id, "chat-dup", "DUP", "2026-01-05T10:00:00Z");
        await linkThread(T1, "chat-dup");
        expect(await hide(T1, hidden)).toBe(true);

        expect(await markers(T1, "text")).toEqual({ [hidden]: 1 });
        expect(await markers(T1)).toEqual({ [hidden]: 1 });
      });

      it(`two per-message links, linked ${name}, hide ${hidden}: both reads keep ${hidden}, marked`, async () => {
        insertText("A", "chat-a", "DUP", "2026-01-05T10:00:00Z");
        insertText("B", "chat-b", "DUP", "2026-01-05T10:00:00Z");
        for (const id of order) await linkMessage(T1, id);
        expect(await hide(T1, hidden)).toBe(true);

        expect(await markers(T1, "text")).toEqual({ [hidden]: 1 });
        expect(await markers(T1)).toEqual({ [hidden]: 1 });
      });
    }
  }
});

describe("BACKLOG-3366 C6 — two hides sharing a provider id do not duplicate the row before LIMIT", () => {
  it("returns N distinct rows for limit N", async () => {
    // After a re-import (new id n2, same guid) and an older duplicate hide, two
    // stored rows match n2 through the external-id arm. The service never writes
    // the second one itself (its NOT EXISTS), so this state is seeded directly.
    insertText("n1", "macos-chat-1", "one", "2026-01-01T10:00:00Z", "guid-m1");
    insertText("n2", "macos-chat-1", "two", "2026-01-02T10:00:00Z", "guid-m2");
    insertText("n3", "macos-chat-1", "three", "2026-01-03T10:00:00Z", "guid-m3");
    await linkThread(T1, "macos-chat-1");
    const seed = db.prepare(
      `INSERT INTO transaction_hidden_texts (transaction_id, message_id, message_external_id, hidden_by) VALUES (?, ?, 'guid-m2', ?)`,
    );
    seed.run(T1, "m2-before-reimport", USER);
    seed.run(T1, "m2-before-that", USER);

    const rows = (await getCommunicationsWithMessages(T1, "text", 3)) as unknown as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["n1", "n2", "n3"]);
    expect(await markers(T1, "text", 3)).toEqual({ n1: 0, n2: 1, n3: 0 });
  });
});

describe("BACKLOG-3366 C7/C8 — hiding changes nothing but the hide", () => {
  function linkAndMessageRows(): { messages: number; communications: number } {
    return {
      messages: (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
      communications: (db.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?").get(T1) as { n: number }).n,
    };
  }
  function counts(): { text_thread_count: number; message_count: number } {
    return db
      .prepare("SELECT text_thread_count, message_count FROM transactions WHERE id = ?")
      .get(T1) as { text_thread_count: number; message_count: number };
  }

  it("C7 messages and communications rows are all still present after hide and after unhide", async () => {
    threeTexts();
    await linkMessage(T1, "m1");
    await linkThread(T1, "macos-chat-1");
    const before = linkAndMessageRows();
    expect(before).toEqual({ messages: 3, communications: 2 });

    await hide(T1, "m1");
    await hide(T1, "m2");
    expect(linkAndMessageRows()).toEqual(before);

    expect(await unhideTextFromExport({ transactionId: T1, messageId: "m1" })).toBe(1);
    expect(linkAndMessageRows()).toEqual(before);
  });

  it("C8 the stored text_thread_count and message_count are untouched by hide and unhide", async () => {
    threeTexts();
    await linkThread(T1, "macos-chat-1");
    // Sentinels no recount could produce, so ANY rewrite of either column shows.
    db.prepare("UPDATE transactions SET text_thread_count = 7, message_count = 42 WHERE id = ?").run(T1);

    await hide(T1, "m2");
    expect(counts()).toEqual({ text_thread_count: 7, message_count: 42 });

    await unhideTextFromExport({ transactionId: T1, messageId: "m2" });
    expect(counts()).toEqual({ text_thread_count: 7, message_count: 42 });
  });

  it("unhide clears the marker; a repeat hide adds no second row", async () => {
    threeTexts();
    await linkThread(T1, "macos-chat-1");
    expect(await hide(T1, "m2")).toBe(true);
    expect(await hide(T1, "m2")).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM transaction_hidden_texts").get() as { n: number }).n).toBe(1);

    expect(await unhideTextFromExport({ transactionId: T1, messageId: "m2" })).toBe(1);
    expect(await markers(T1, "text")).toEqual({ m1: 0, m2: 0, m3: 0 });
  });
});
