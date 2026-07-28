/**
 * @jest-environment node
 *
 * BACKLOG-2285 integration test for autoLinkService.expandAttachedThreadsForUser.
 *
 * Runs against a REAL in-memory better-sqlite3 database (wired through the real
 * dbConnection via setDb) so the full linking path exercises production SQL:
 * enumeration of attached (transaction, thread) pairs, sibling + cross-thread
 * candidate discovery, suppression, the manual-attach linking path
 * (linkMessageToTransaction + createCommunicationReference), the idx_comm_msg_txn
 * unique-index idempotency backstop, and text_thread_count recomputation.
 *
 * Cases (task-mandated), all asserting EXACT ID SETS (project rule):
 *   (a) backfilled older message in an attached thread is linked (no date floor)
 *   (b) message in a suppressed/ignored thread is NOT linked
 *   (c) an individually-removed message is NOT linked
 *   (d) idempotency — a second run links 0 and creates no duplicates
 *   (e) cross-thread same-contact backfill IS linked
 *   (f) an unrelated contact's messages are NOT linked
 *   (g) transaction text_thread_count is updated
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Mocks must come before importing the SUT.
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: { info: noop, warn: noop, error: noop, debug: noop },
  };
});

import { setDb } from "../db/core/dbConnection";
import { expandAttachedThreadsForUser } from "../autoLinkService";

const USER_ID = "user-2285";
const TXN_ID = "txn-2285";
const OTHER_TXN_ID = "txn-other";

// Contact phones (E.164) used across threads.
const PHONE_ROMINA = "+12065551234"; // last-10: 2065551234
const PHONE_UNRELATED = "+13105559999"; // last-10: 3105559999

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_at DATETIME,
      status TEXT,
      message_count INTEGER DEFAULT 0,
      text_thread_count INTEGER DEFAULT 0
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT,
      direction TEXT,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      participants TEXT,
      participants_flat TEXT,
      thread_id TEXT,
      sent_at DATETIME,
      received_at DATETIME,
      has_attachments INTEGER DEFAULT 0,
      duplicate_of TEXT,
      transaction_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      transaction_id TEXT,
      message_id TEXT,
      email_id TEXT,
      thread_id TEXT,
      link_source TEXT,
      link_confidence REAL,
      linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (message_id IS NOT NULL AND email_id IS NULL)
        OR (email_id IS NOT NULL AND message_id IS NULL)
        OR (message_id IS NULL AND email_id IS NULL AND thread_id IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX idx_comm_msg_txn ON communications(message_id, transaction_id)
      WHERE message_id IS NOT NULL;

    CREATE TABLE ignored_communications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      transaction_id TEXT,
      email_subject TEXT,
      email_sender TEXT,
      email_sent_at DATETIME,
      email_thread_id TEXT,
      email_id TEXT,
      thread_id TEXT,
      original_communication_id TEXT,
      reason TEXT,
      ignored_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

let db: DatabaseType;

function insertMessage(opts: {
  id: string;
  threadId: string;
  phone: string;
  sentAt: string;
  transactionId?: string | null;
  duplicateOf?: string | null;
}): void {
  const last10 = opts.phone.replace(/\D/g, "").slice(-10);
  const participants = JSON.stringify({ from: opts.phone, to: ["me"] });
  const participantsFlat = `${last10},me`;
  db.prepare(
    `INSERT INTO messages
      (id, user_id, channel, direction, participants, participants_flat, thread_id, sent_at, transaction_id, duplicate_of)
     VALUES (?, ?, 'imessage', 'inbound', ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    USER_ID,
    participants,
    participantsFlat,
    opts.threadId,
    opts.sentAt,
    opts.transactionId ?? null,
    opts.duplicateOf ?? null,
  );
}

/** Attach a message to a transaction the way manual attach does (per-message link). */
function manualAttach(messageId: string, transactionId: string): void {
  db.prepare(`UPDATE messages SET transaction_id = ? WHERE id = ?`).run(transactionId, messageId);
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, link_confidence)
     VALUES (?, ?, ?, ?, 'manual', 1.0)`
  ).run(`comm-${messageId}`, USER_ID, transactionId, messageId);
}

function linkedMessageIds(transactionId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT message_id FROM communications WHERE transaction_id = ? AND message_id IS NOT NULL`
    )
    .all(transactionId) as Array<{ message_id: string }>;
  return new Set(rows.map((r) => r.message_id));
}

beforeEach(() => {
  db = new Database(":memory:") as DatabaseType;
  db.pragma("foreign_keys = ON");
  createSchema(db);
  setDb(db);

  db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  db.prepare(
    "INSERT INTO transactions (id, user_id, started_at, status) VALUES (?, ?, ?, 'active')"
  ).run(TXN_ID, USER_ID, "2026-05-01T00:00:00Z");
  db.prepare(
    "INSERT INTO transactions (id, user_id, started_at, status) VALUES (?, ?, ?, 'active')"
  ).run(OTHER_TXN_ID, USER_ID, "2026-05-01T00:00:00Z");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

describe("expandAttachedThreadsForUser (BACKLOG-2285)", () => {
  // (a) — sibling backfill with NO date floor
  it("(a) links a backfilled older message in an attached thread (no date floor)", async () => {
    // Attach a recent message in thread T1.
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // Backfill: an OLD message (years before the transaction started) in the same thread.
    insertMessage({ id: "m-old", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2020-01-01T00:00:00Z", transactionId: null });

    const res = await expandAttachedThreadsForUser(USER_ID);

    expect(res.messagesLinked).toBe(1);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-old"]));
    // messages.transaction_id was set the manual-attach way.
    const row = db.prepare("SELECT transaction_id FROM messages WHERE id = 'm-old'").get() as {
      transaction_id: string | null;
    };
    expect(row.transaction_id).toBe(TXN_ID);
  });

  // (b) — a message in a suppressed/ignored thread is NOT linked
  it("(b) does NOT link a message whose thread was removed (thread-level suppression)", async () => {
    // Attach thread T1 (contact Romina).
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // Same contact under a DIFFERENT thread T-ignored, but the user removed that thread.
    insertMessage({ id: "m-in-ignored", threadId: "T-ignored", phone: PHONE_ROMINA, sentAt: "2026-05-15T00:00:00Z", transactionId: null });
    db.prepare(
      "INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES ('ig1', ?, ?, 'T-ignored')"
    ).run(USER_ID, TXN_ID);

    const res = await expandAttachedThreadsForUser(USER_ID);

    // The ignored thread's message must NOT be linked.
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent"]));
    expect(res.skippedSuppressed).toBeGreaterThanOrEqual(1);
  });

  // (c) — an individually removed message is NOT linked
  it("(c) does NOT link an individually-removed message (per-message suppression)", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // Two backfill siblings in T1; one was individually removed by the user.
    insertMessage({ id: "m-ok", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-03-01T00:00:00Z", transactionId: null });
    insertMessage({ id: "m-removed", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-03-02T00:00:00Z", transactionId: null });
    db.prepare(
      "INSERT INTO ignored_communications (id, user_id, transaction_id, original_communication_id) VALUES ('ig2', ?, ?, 'm-removed')"
    ).run(USER_ID, TXN_ID);

    const res = await expandAttachedThreadsForUser(USER_ID);

    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-ok"]));
    expect(res.messagesLinked).toBe(1);
    expect(res.skippedSuppressed).toBeGreaterThanOrEqual(1);
  });

  // (d) — idempotency
  it("(d) is idempotent: a second run links 0 and creates no duplicate rows", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    insertMessage({ id: "m-old", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2020-01-01T00:00:00Z", transactionId: null });

    const first = await expandAttachedThreadsForUser(USER_ID);
    expect(first.messagesLinked).toBe(1);

    // A plain re-run links nothing new (m-old now has transaction_id set, so it is
    // filtered out before it even becomes a candidate — no wasted work).
    const second = await expandAttachedThreadsForUser(USER_ID);
    expect(second.messagesLinked).toBe(0);

    // Guard path: simulate m-old becoming a candidate again (transaction_id reset
    // to NULL) while its junction row persists — isMessageLinkedToTransaction must
    // catch it as already-linked and NOT create a duplicate.
    db.prepare("UPDATE messages SET transaction_id = NULL WHERE id = 'm-old'").run();
    const third = await expandAttachedThreadsForUser(USER_ID);
    expect(third.messagesLinked).toBe(0);
    expect(third.skippedAlreadyLinked).toBeGreaterThanOrEqual(1);

    // Exactly one junction row for m-old + txn (unique index backstop held).
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ? AND message_id = 'm-old'"
      )
      .get(TXN_ID) as { n: number };
    expect(count.n).toBe(1);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-old"]));
  });

  // (e) — cross-thread same-contact backfill
  it("(e) links same-contact backfill living under a DIFFERENT thread_id (cross-thread)", async () => {
    // Attach the Romina conversation via thread T1.
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // Backfill history for the SAME contact under a different internal thread (multi-chat_id).
    insertMessage({ id: "m-cross", threadId: "T-other-chatid", phone: PHONE_ROMINA, sentAt: "2019-08-01T00:00:00Z", transactionId: null });

    const res = await expandAttachedThreadsForUser(USER_ID);

    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-cross"]));
    expect(res.messagesLinked).toBe(1);
  });

  // (f) — unrelated contact is not linked
  it("(f) does NOT link an unrelated contact's messages", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // Unrelated contact, unattached thread — must be ignored entirely.
    insertMessage({ id: "m-unrelated", threadId: "T-unrelated", phone: PHONE_UNRELATED, sentAt: "2026-05-20T00:00:00Z", transactionId: null });

    const res = await expandAttachedThreadsForUser(USER_ID);

    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent"]));
    expect(res.messagesLinked).toBe(0);
    // Sanity: the unrelated message is still unlinked.
    const row = db.prepare("SELECT transaction_id FROM messages WHERE id = 'm-unrelated'").get() as {
      transaction_id: string | null;
    };
    expect(row.transaction_id).toBeNull();
  });

  // (g) — thread count updated
  it("(g) updates the transaction's text_thread_count after expansion", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    insertMessage({ id: "m-old", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2020-01-01T00:00:00Z", transactionId: null });
    // A second attached contact/thread so the count is a set, not a single value.
    insertMessage({ id: "m-cross", threadId: "T-other-chatid", phone: PHONE_ROMINA, sentAt: "2019-08-01T00:00:00Z", transactionId: null });

    await expandAttachedThreadsForUser(USER_ID);

    const txn = db.prepare("SELECT text_thread_count FROM transactions WHERE id = ?").get(TXN_ID) as {
      text_thread_count: number;
    };
    // Two distinct threads now carry linked texts: T1 and T-other-chatid.
    expect(txn.text_thread_count).toBe(2);
  });

  // Guard: only text messages (never emails/other channels) are expanded.
  it("(guard) does not touch a message linked to a different transaction", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // Same contact, but already linked to ANOTHER transaction — must not be stolen.
    insertMessage({ id: "m-elsewhere", threadId: "T-elsewhere", phone: PHONE_ROMINA, sentAt: "2026-04-01T00:00:00Z" });
    manualAttach("m-elsewhere", OTHER_TXN_ID);

    await expandAttachedThreadsForUser(USER_ID);

    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent"]));
    expect(linkedMessageIds(OTHER_TXN_ID)).toEqual(new Set(["m-elsewhere"]));
  });
});
