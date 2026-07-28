/**
 * @jest-environment node
 *
 * BACKLOG-2285 integration test for autoLinkService.expandAttachedThreadsForUser.
 *
 * Runs against a REAL in-memory better-sqlite3 database (wired through the real
 * dbConnection via setDb) so the full linking path exercises production SQL:
 * enumeration of MANUALLY attached (transaction, thread) pairs, sibling
 * candidate discovery, suppression, the manual-attach linking path
 * (linkMessageToTransaction + createCommunicationReference), the idx_comm_msg_txn
 * unique-index idempotency backstop, and text_thread_count recomputation.
 *
 * Sibling expansion (same thread_id) AND cross-thread expansion (same 1:1 contact
 * under a DIFFERENT internal thread_id — BACKLOG-2287) are both covered. Cross-thread
 * is gated by a DIRECTION-AWARE 1:1 identity + a group-chat gate (SR review of PR
 * #2073): the user's own handle (macOS userAccountLogin in outbound `from` / inbound
 * `to`) is excluded so a genuine 1:1 resolves to exactly one external identity, and a
 * group thread that merely contains the contact resolves to >1 identity and is rejected.
 *
 * Cases, all asserting EXACT ID SETS (project rule):
 *   (a) backfilled older message in an attached thread is linked (no date floor)
 *   (b) message in a suppressed/ignored thread is NOT linked
 *   (c) an individually-removed message is NOT linked
 *   (d) idempotency — a second run links 0 and creates no duplicates
 *   (e) same-contact backfill under a DIFFERENT thread_id IS cross-linked (BACKLOG-2287)
 *  (I1) a thread-level (auto-link) attach is NOT converted to per-message rows
 *   (f) an unrelated contact's messages are NOT linked (also covers: not cross-linked)
 *   (g) transaction text_thread_count is updated
 *  BACKLOG-2287 cross-thread cases:
 *   (cross/group)       a GROUP thread merely containing the contact is NOT cross-linked
 *   (cross/macos)       a realistic macOS 1:1 (from=userAccountLogin) under another thread_id IS cross-linked
 *   (cross/suppression) a removed constituent thread is NOT cross-linked
 *   (cross/reaction)    a reaction row under another thread is NOT cross-linked
 *   (cross/idempotent)  a second cross-thread run links 0
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
const PHONE_OTHER = "+14155557777"; // last-10: 4155557777 — a 2nd group member
// The user's OWN macOS handle (userAccountLogin), written by the import into
// outbound `from` / inbound `to`. Direction-aware identity MUST exclude it so a
// genuine 1:1 resolves to exactly one external identity (BACKLOG-2287 C2).
const USER_HANDLE = "+15550000001";

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
      associated_message_type INTEGER,
      associated_message_guid TEXT,
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
  // BACKLOG-2280: when set, this row is a reaction (should NEVER be expansion-linked).
  associatedMessageType?: number | null;
  associatedMessageGuid?: string | null;
}): void {
  const last10 = opts.phone.replace(/\D/g, "").slice(-10);
  const participants = JSON.stringify({ from: opts.phone, to: ["me"] });
  const participantsFlat = `${last10},me`;
  db.prepare(
    `INSERT INTO messages
      (id, user_id, channel, direction, participants, participants_flat, thread_id, sent_at, transaction_id, duplicate_of,
       associated_message_type, associated_message_guid)
     VALUES (?, ?, 'imessage', 'inbound', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    USER_ID,
    participants,
    participantsFlat,
    opts.threadId,
    opts.sentAt,
    opts.transactionId ?? null,
    opts.duplicateOf ?? null,
    opts.associatedMessageType ?? null,
    opts.associatedMessageGuid ?? null,
  );
}

/**
 * Insert a message with explicit direction + macOS-realistic participants JSON
 * (BACKLOG-2287). Mirrors macOSMessagesImportService: outbound => from = the user's
 * own handle, to = [contact]; inbound => from = contact, to = [user handle].
 * `chatMembers` (>1) marks a GROUP chat (the import only writes chat_members for
 * multi-member chats). Used to prove direction-aware identity + the group gate.
 */
function insertMacMessage(opts: {
  id: string;
  threadId: string;
  direction: "inbound" | "outbound";
  contact: string; // the external contact handle
  userHandle?: string; // userAccountLogin written by the macOS import
  chatMembers?: string[]; // present only for group chats (>1 member)
  sentAt: string;
  transactionId?: string | null;
  associatedMessageType?: number | null;
  associatedMessageGuid?: string | null;
}): void {
  const user = opts.userHandle ?? USER_HANDLE;
  const participantsObj: Record<string, unknown> =
    opts.direction === "outbound"
      ? { from: user, to: [opts.contact] }
      : { from: opts.contact, to: [user] };
  if (opts.chatMembers && opts.chatMembers.length > 1) {
    participantsObj.chat_members = opts.chatMembers;
  }
  const participants = JSON.stringify(participantsObj);
  const participantsFlat = [opts.contact, ...(opts.chatMembers ?? [])]
    .map((h) => h.replace(/\D/g, ""))
    .filter(Boolean)
    .join(",");
  db.prepare(
    `INSERT INTO messages
      (id, user_id, channel, direction, participants, participants_flat, thread_id, sent_at, transaction_id, duplicate_of,
       associated_message_type, associated_message_guid)
     VALUES (?, ?, 'imessage', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    USER_ID,
    opts.direction,
    participants,
    participantsFlat,
    opts.threadId,
    opts.sentAt,
    opts.transactionId ?? null,
    null,
    opts.associatedMessageType ?? null,
    opts.associatedMessageGuid ?? null,
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

  // (a2, BACKLOG-2280 C2) — a REACTION sibling of an attached thread must NOT be
  // expansion-linked. Otherwise the re-sync would set its transaction_id + write a
  // communications junction row, polluting the compliance junction (and
  // getMessagesByTransaction). The reaction still renders as a pill via the
  // thread-join in getCommunicationsWithMessages, so nothing is hidden.
  it("(a2) does NOT expansion-link a reaction sibling of an attached thread (no junction pollution)", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // A real backfill sibling (SHOULD link) + a reaction sibling (must NOT link).
    insertMessage({ id: "m-old", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-03-01T00:00:00Z", transactionId: null });
    insertMessage({
      id: "m-react",
      threadId: "T1",
      phone: PHONE_ROMINA,
      sentAt: "2026-03-02T00:00:00Z",
      transactionId: null,
      associatedMessageType: 2000,
      associatedMessageGuid: "GUID-m-old",
    });

    const res = await expandAttachedThreadsForUser(USER_ID);

    // Exact ID set: the real sibling is linked, the reaction is NOT.
    expect(res.messagesLinked).toBe(1);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-old"]));

    // The reaction stays fully unlinked: no transaction_id AND no junction row.
    const react = db
      .prepare("SELECT transaction_id FROM messages WHERE id = 'm-react'")
      .get() as { transaction_id: string | null };
    expect(react.transaction_id).toBeNull();
    const commCount = db
      .prepare("SELECT COUNT(*) AS n FROM communications WHERE message_id = 'm-react'")
      .get() as { n: number };
    expect(commCount.n).toBe(0);
  });

  // (b) — a backfill sibling of a REMOVED thread is NOT linked (thread-level suppression)
  it("(b) does NOT re-link siblings of a thread the user removed (thread-level suppression)", async () => {
    // T1 has a surviving per-message link (m-recent) so it is enumerated, but the
    // user removed the conversation — the thread is in the ignored set.
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // A backfill sibling in that same (removed) thread must stay removed.
    insertMessage({ id: "m-old", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2020-01-01T00:00:00Z", transactionId: null });
    db.prepare(
      "INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES ('ig1', ?, ?, 'T1')"
    ).run(USER_ID, TXN_ID);

    const res = await expandAttachedThreadsForUser(USER_ID);

    // The removed thread is skipped wholesale — the backfill sibling is NOT re-linked.
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent"]));
    expect(res.messagesLinked).toBe(0);
    const row = db.prepare("SELECT transaction_id FROM messages WHERE id = 'm-old'").get() as {
      transaction_id: string | null;
    };
    expect(row.transaction_id).toBeNull();
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

  // (e) — BACKLOG-2287: cross-thread expansion. A same-contact message under a
  // DIFFERENT internal thread_id (macOS multi-chat_id) IS linked, because the
  // attached thread and the constituent thread both resolve to the SAME 1:1 identity.
  it("(e) cross-links same-contact backfill under a DIFFERENT thread_id (BACKLOG-2287)", async () => {
    // Attach the Romina conversation via thread T1.
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // Backfill history for the SAME contact under a different internal thread (multi-chat_id).
    insertMessage({ id: "m-cross", threadId: "T-other-chatid", phone: PHONE_ROMINA, sentAt: "2019-08-01T00:00:00Z", transactionId: null });

    const res = await expandAttachedThreadsForUser(USER_ID);

    // Cross-thread: the same 1:1 contact's other-thread backfill is now linked.
    expect(res.messagesLinked).toBe(1);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-cross"]));
    const row = db.prepare("SELECT transaction_id FROM messages WHERE id = 'm-cross'").get() as {
      transaction_id: string | null;
    };
    expect(row.transaction_id).toBe(TXN_ID);
  });

  // (cross/group) — C1 GROUP GATE (worst failure mode of the first attempt).
  // An UNATTACHED group thread that merely CONTAINS the contact must NOT be
  // cross-linked — otherwise the OTHER members' messages leak into a compliance
  // export. The group resolves (direction-aware) to >1 external identity, so it is
  // never a 1:1 candidate. Exact IDs: the group's messages keep transaction_id NULL
  // and produce 0 communications rows.
  it("(cross/group) does NOT cross-link a GROUP thread that merely contains the contact", async () => {
    // Attach Romina's real 1:1 thread T1.
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    // UNATTACHED group thread (Romina + another person). chat_members => 2 identities.
    insertMacMessage({
      id: "m-group-1",
      threadId: "T-group",
      direction: "inbound",
      contact: PHONE_ROMINA,
      chatMembers: [PHONE_ROMINA, PHONE_OTHER],
      sentAt: "2026-03-01T00:00:00Z",
      transactionId: null,
    });
    insertMacMessage({
      id: "m-group-2",
      threadId: "T-group",
      direction: "outbound",
      contact: PHONE_OTHER,
      chatMembers: [PHONE_ROMINA, PHONE_OTHER],
      sentAt: "2026-03-02T00:00:00Z",
      transactionId: null,
    });

    const res = await expandAttachedThreadsForUser(USER_ID);

    // No group message enters the junction (not even the contact's own group message).
    expect(res.messagesLinked).toBe(0);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent"]));
    for (const gid of ["m-group-1", "m-group-2"]) {
      const row = db.prepare("SELECT transaction_id FROM messages WHERE id = ?").get(gid) as {
        transaction_id: string | null;
      };
      expect(row.transaction_id).toBeNull();
      const n = db
        .prepare("SELECT COUNT(*) AS n FROM communications WHERE message_id = ?")
        .get(gid) as { n: number };
      expect(n.n).toBe(0);
    }
  });

  // (cross/macos) — C2 DIRECTION-AWARE IDENTITY on REALISTIC macOS data.
  // Both the attached thread and the backfill thread carry the user's own handle in
  // outbound `from` / inbound `to`. A naive from+to+chat_members identity would see
  // {Romina, user} = 2 on every message and never fire; direction-aware identity
  // resolves each thread to exactly {Romina} so the backfill IS cross-linked.
  it("(cross/macos) cross-links a realistic macOS 1:1 under a DIFFERENT thread_id (direction-aware)", async () => {
    // Attach T1 with realistic macOS participants (outbound from = user handle).
    insertMacMessage({ id: "m-recent-out", threadId: "T1", direction: "outbound", contact: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent-out", TXN_ID);
    // Backfill under a DIFFERENT internal thread_id, also realistic macOS shape.
    insertMacMessage({ id: "m-cross-in", threadId: "T2", direction: "inbound", contact: PHONE_ROMINA, sentAt: "2019-08-01T00:00:00Z", transactionId: null });
    insertMacMessage({ id: "m-cross-out", threadId: "T2", direction: "outbound", contact: PHONE_ROMINA, sentAt: "2019-08-02T00:00:00Z", transactionId: null });

    const res = await expandAttachedThreadsForUser(USER_ID);

    expect(res.messagesLinked).toBe(2);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent-out", "m-cross-in", "m-cross-out"]));
    for (const cid of ["m-cross-in", "m-cross-out"]) {
      const row = db.prepare("SELECT transaction_id FROM messages WHERE id = ?").get(cid) as {
        transaction_id: string | null;
      };
      expect(row.transaction_id).toBe(TXN_ID);
    }
  });

  // (cross/suppression) — a same-contact constituent thread the user REMOVED for this
  // transaction stays removed (suppression applies to constituents, not just the target).
  it("(cross/suppression) does NOT cross-link a constituent thread the user removed", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    insertMacMessage({ id: "m-cross", threadId: "T2", direction: "inbound", contact: PHONE_ROMINA, sentAt: "2019-08-01T00:00:00Z", transactionId: null });
    db.prepare(
      "INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES ('ig-cross', ?, ?, 'T2')"
    ).run(USER_ID, TXN_ID);

    const res = await expandAttachedThreadsForUser(USER_ID);

    expect(res.messagesLinked).toBe(0);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent"]));
    const row = db.prepare("SELECT transaction_id FROM messages WHERE id = 'm-cross'").get() as {
      transaction_id: string | null;
    };
    expect(row.transaction_id).toBeNull();
  });

  // (cross/reaction) — BACKLOG-2280: a reaction row under a DIFFERENT thread_id must
  // NEVER be auto-linked into the junction. The normal backfill sibling IS linked;
  // the reaction is not (no transaction_id, no communications row).
  it("(cross/reaction) does NOT cross-link a reaction row under a DIFFERENT thread_id", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    insertMacMessage({ id: "m-cross-ok", threadId: "T2", direction: "inbound", contact: PHONE_ROMINA, sentAt: "2019-08-01T00:00:00Z", transactionId: null });
    insertMacMessage({
      id: "m-cross-react",
      threadId: "T2",
      direction: "inbound",
      contact: PHONE_ROMINA,
      sentAt: "2019-08-02T00:00:00Z",
      transactionId: null,
      associatedMessageType: 2000,
      associatedMessageGuid: "GUID-m-cross-ok",
    });

    const res = await expandAttachedThreadsForUser(USER_ID);

    expect(res.messagesLinked).toBe(1);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-cross-ok"]));
    const react = db
      .prepare("SELECT transaction_id FROM messages WHERE id = 'm-cross-react'")
      .get() as { transaction_id: string | null };
    expect(react.transaction_id).toBeNull();
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM communications WHERE message_id = 'm-cross-react'")
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  // (cross/idempotent) — a second cross-thread run links 0 and creates no duplicates.
  it("(cross/idempotent) cross-thread expansion is idempotent — a second run links 0", async () => {
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    insertMacMessage({ id: "m-cross", threadId: "T2", direction: "inbound", contact: PHONE_ROMINA, sentAt: "2019-08-01T00:00:00Z", transactionId: null });

    const first = await expandAttachedThreadsForUser(USER_ID);
    expect(first.messagesLinked).toBe(1);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-cross"]));

    // Plain re-run: m-cross now has transaction_id set, so it is filtered before it
    // can become a candidate again.
    const second = await expandAttachedThreadsForUser(USER_ID);
    expect(second.messagesLinked).toBe(0);

    // Guard path: m-cross becomes a candidate again (transaction_id reset to NULL)
    // while its junction row persists — isMessageLinkedToTransaction must catch it.
    db.prepare("UPDATE messages SET transaction_id = NULL WHERE id = 'm-cross'").run();
    const third = await expandAttachedThreadsForUser(USER_ID);
    expect(third.messagesLinked).toBe(0);
    expect(third.skippedAlreadyLinked).toBeGreaterThanOrEqual(1);

    // Exactly one junction row for m-cross + txn (unique index backstop held).
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ? AND message_id = 'm-cross'"
      )
      .get(TXN_ID) as { n: number };
    expect(count.n).toBe(1);
  });

  // (I1) — thread-level (auto-link) attaches are NOT converted to per-message rows.
  // getTransactionMessages already surfaces the whole thread via the c.thread_id
  // join; expanding them would break thread-level unlink (SR review, I1).
  it("(I1) does NOT expand a thread-level (auto-link) attach into per-message rows", async () => {
    // Thread-level link shape: communications row with thread_id set, message_id NULL.
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source, link_confidence)
       VALUES ('comm-threadlevel', ?, ?, 'T-auto', 'auto', 0.9)`
    ).run(USER_ID, OTHER_TXN_ID);
    // A backfilled message in that thread.
    insertMessage({ id: "m-auto-backfill", threadId: "T-auto", phone: PHONE_ROMINA, sentAt: "2020-03-01T00:00:00Z", transactionId: null });

    const res = await expandAttachedThreadsForUser(USER_ID);

    // The thread-level attach is not even enumerated as a pair (per-message only).
    expect(res.pairsExamined).toBe(0);
    // No per-message rows created; the thread-level link is left untouched.
    expect(linkedMessageIds(OTHER_TXN_ID)).toEqual(new Set());
    const row = db.prepare("SELECT transaction_id FROM messages WHERE id = 'm-auto-backfill'").get() as {
      transaction_id: string | null;
    };
    expect(row.transaction_id).toBeNull();
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
    // Two separately (manually) attached threads in the same transaction, each with
    // a backfilled sibling — so the recomputed count is a set, not a single value.
    insertMessage({ id: "m-recent", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2026-06-01T00:00:00Z" });
    manualAttach("m-recent", TXN_ID);
    insertMessage({ id: "m-recent2", threadId: "T2", phone: PHONE_UNRELATED, sentAt: "2026-06-02T00:00:00Z" });
    manualAttach("m-recent2", TXN_ID);
    insertMessage({ id: "m-old", threadId: "T1", phone: PHONE_ROMINA, sentAt: "2020-01-01T00:00:00Z", transactionId: null });
    insertMessage({ id: "m-old2", threadId: "T2", phone: PHONE_UNRELATED, sentAt: "2020-02-01T00:00:00Z", transactionId: null });

    const res = await expandAttachedThreadsForUser(USER_ID);

    expect(res.messagesLinked).toBe(2);
    expect(linkedMessageIds(TXN_ID)).toEqual(new Set(["m-recent", "m-recent2", "m-old", "m-old2"]));

    const txn = db.prepare("SELECT text_thread_count FROM transactions WHERE id = ?").get(TXN_ID) as {
      text_thread_count: number;
    };
    // Two distinct attached threads now carry linked texts: T1 and T2.
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
