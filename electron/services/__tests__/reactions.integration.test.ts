/**
 * @jest-environment node
 *
 * BACKLOG-2280 — reaction storage + partition integration test.
 *
 * Runs against a REAL in-memory better-sqlite3 database (wired through the real
 * dbConnection via setDb) so every reader exercises production SQL.
 *
 * Two guarantees, both asserted with EXACT ID SETS (project rule):
 *
 *   C2 LEAKAGE ENFORCEMENT — a stored reaction row (associated_message_type in
 *     [2000,3005]) must NEVER surface in any list / count / search / contact /
 *     earliest-date reader. Each reader is seeded with a real message + a reaction
 *     and asserted to return ONLY the real message.
 *
 *   I1/I2 INCLUDE + NO-DEDUP — getCommunicationsWithMessages must RETURN reactions
 *     (so the renderer can attach pills) AND must NOT content-dedup two empty-body
 *     rows that share the same second (a reaction + a caption-less media message).
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import { getCommunicationsWithMessages } from "../db/communicationDbService";
import {
  getUnlinkedTextMessages,
  getMessageContacts,
  getMessagesByContact,
  getConversationsFromMessages,
  getMessagesForLLMAnalysis,
  getPendingLLMAnalysisCount,
} from "../db/messageDbService";
import { getMessageDerivedContacts, getMessagesForContact } from "../db/contactDbService";
import { getEarliestCommunicationDate } from "../transactionService/getEarliestCommunicationDate";
import { buildUnattachedTextQuery } from "../db/transactionSearchDbService";

const USER = "user-2280";
const TXN = "txn-2280";
const PHONE_UNLINKED = "+13105559999"; // last-10 3105559999

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);
    CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT);

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_account_id TEXT,
      external_id TEXT,
      channel TEXT,
      direction TEXT,
      subject TEXT,
      body_html TEXT,
      body_text TEXT,
      participants TEXT,
      participants_flat TEXT,
      thread_id TEXT,
      sent_at DATETIME,
      received_at DATETIME,
      has_attachments INTEGER DEFAULT 0,
      is_transaction_related INTEGER,
      transaction_id TEXT,
      message_type TEXT,
      duplicate_of TEXT,
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
      -- BACKLOG-2319 merge: getCommunicationsWithMessages now SELECTs c.match_reason
      -- (Needs-review surface). Mirror the real schema so this fixture matches.
      match_reason TEXT
    );

    -- emails (LEFT-JOINed by getCommunicationsWithMessages) — empty but present.
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, user_id TEXT, subject TEXT, sender TEXT, recipients TEXT,
      cc TEXT, bcc TEXT, body_plain TEXT, body_html TEXT, thread_id TEXT,
      sent_at DATETIME, received_at DATETIME, has_attachments INTEGER, direction TEXT,
      external_id TEXT, source TEXT, attachment_count INTEGER
    );
    CREATE TABLE email_participants (email_id TEXT, email_address TEXT);

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT, is_imported INTEGER DEFAULT 0
    );
    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, phone_e164 TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, email TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- attachments (referenced by the search queries' attachment-match subquery).
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, external_message_id TEXT, filename TEXT
    );
  `);
}

interface MsgOpts {
  id: string;
  external_id: string;
  thread_id: string;
  direction?: "inbound" | "outbound";
  body_text?: string;
  participants_flat?: string;
  fromField?: string;
  toField?: string;
  sent_at: string;
  transaction_id?: string | null;
  associated_message_type?: number | null;
  associated_message_guid?: string | null;
  has_attachments?: number;
}

function insertMsg(db: DatabaseType, o: MsgOpts): string {
  const direction = o.direction ?? "inbound";
  const participants = JSON.stringify({
    from: o.fromField ?? (direction === "inbound" ? o.participants_flat : "me"),
    to: [o.toField ?? (direction === "inbound" ? "me" : o.participants_flat)],
  });
  db.prepare(
    `INSERT INTO messages
       (id, user_id, external_id, channel, direction, body_text, participants, participants_flat,
        thread_id, sent_at, has_attachments, transaction_id, associated_message_type, associated_message_guid)
     VALUES (?, ?, ?, 'imessage', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id, USER, o.external_id, direction, o.body_text ?? "", participants,
    o.participants_flat ?? "", o.thread_id, o.sent_at, o.has_attachments ?? 0,
    o.transaction_id ?? null, o.associated_message_type ?? null, o.associated_message_guid ?? null,
  );
  return o.id;
}

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:") as DatabaseType;
  createSchema(db);
  setDb(db);
  db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER);
  db.prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)").run(TXN, USER);
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  setDb(null as unknown as DatabaseType);
});

describe("getCommunicationsWithMessages — INCLUDE reactions + I2 no-dedup (BACKLOG-2280)", () => {
  beforeEach(() => {
    // Thread linked to TXN via thread-based communication.
    insertMsg(db, {
      id: "PL1", external_id: "GL1", thread_id: "th-linked", direction: "inbound",
      body_text: "hello there", participants_flat: "12065551234", sent_at: "2026-01-01T10:00:00.000Z",
    });
    // Reaction on PL1 (outbound = "me" reacted). Empty body, same second as the
    // caption-less media message below → exercises the I2 dedup exemption.
    insertMsg(db, {
      id: "RL1", external_id: "RL1", thread_id: "th-linked", direction: "outbound",
      body_text: "", participants_flat: "12065551234", sent_at: "2026-01-01T10:05:00.000Z",
      associated_message_type: 2000, associated_message_guid: "GL1",
    });
    // Caption-less media message, SAME second as RL1, ALSO empty body.
    insertMsg(db, {
      id: "PLm", external_id: "GLm", thread_id: "th-linked", direction: "inbound",
      body_text: "", participants_flat: "12065551234", sent_at: "2026-01-01T10:05:00.000Z",
      has_attachments: 1,
    });
    // Thread-based linkage row.
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source)
       VALUES ('c1', ?, ?, 'th-linked', 'manual')`,
    ).run(USER, TXN);
  });

  it("returns the parent AND the reaction row (so pills can attach)", async () => {
    const rows = await getCommunicationsWithMessages(TXN);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids).toEqual(new Set(["PL1", "RL1", "PLm"]));
    const reaction = rows.find((r) => r.id === "RL1");
    expect(reaction?.associated_message_type).toBe(2000);
    expect(reaction?.associated_message_guid).toBe("GL1");
  });

  it("does NOT content-dedup two empty-body rows sharing the same second (I2)", async () => {
    const rows = await getCommunicationsWithMessages(TXN);
    // RL1 (reaction) and PLm (caption-less media) both have body_text "" and the
    // same sent_at. Pre-2280 the `bodyText|sentAt` key collapsed them to one.
    expect(rows.filter((r) => r.id === "RL1")).toHaveLength(1);
    expect(rows.filter((r) => r.id === "PLm")).toHaveLength(1);
  });
});

describe("C2 leakage enforcement — reactions never surface in list/count/search/contact readers", () => {
  beforeEach(() => {
    // Unlinked real parent + its reaction, same thread, same contact phone.
    insertMsg(db, {
      id: "PU1", external_id: "GU1", thread_id: "th-unlinked", direction: "inbound",
      body_text: "world", participants_flat: "13105559999", sent_at: "2026-02-02T10:00:00.000Z",
    });
    // Reaction is OUTBOUND ("me" reacted) so its participants.to[0] is the phone —
    // this is exactly the shape that would pollute getMessageContacts if not excluded.
    insertMsg(db, {
      id: "RU1", external_id: "RU1", thread_id: "th-unlinked", direction: "outbound",
      body_text: "", participants_flat: "13105559999",
      // EARLIER than PU1 → would wrongly become the "earliest communication" if counted.
      sent_at: "2026-01-01T00:00:00.000Z",
      associated_message_type: 2001, associated_message_guid: "GU1",
    });
    // Contact for the unlinked thread (for getMessagesForContact / earliest-date).
    db.prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES ('c-u', ?, 'Unlinked Person', 1)").run(USER);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES ('cp-u', 'c-u', ?)").run(PHONE_UNLINKED);
  });

  it("getUnlinkedTextMessages returns the real message only", () => {
    const ids = getUnlinkedTextMessages(USER).map((m) => m.id);
    expect(new Set(ids)).toEqual(new Set(["PU1"]));
  });

  it("getMessagesForLLMAnalysis / getPendingLLMAnalysisCount exclude reactions", () => {
    const ids = getMessagesForLLMAnalysis(USER).map((m) => m.id);
    expect(new Set(ids)).toEqual(new Set(["PU1"]));
    expect(getPendingLLMAnalysisCount(USER)).toBe(1);
  });

  it("getMessageContacts counts the real message only (reaction to[0]=phone excluded)", () => {
    const contacts = getMessageContacts(USER);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].messageCount).toBe(1);
  });

  it("getConversationsFromMessages counts the real message only", () => {
    const convs = getConversationsFromMessages(USER);
    const conv = convs.find((c) => c.id === "th-unlinked");
    expect(conv?.messageCount).toBe(1);
  });

  it("getMessagesByContact returns the real message only (in-memory partition)", () => {
    const ids = getMessagesByContact(USER, "13105559999").map((m) => m.id);
    expect(new Set(ids)).toEqual(new Set(["PU1"]));
  });

  it("getMessagesForContact excludes reactions from the bubble thread", async () => {
    const threads = await getMessagesForContact("c-u");
    const allIds = threads.flatMap((t) => t.messages.map((m) => m.id));
    expect(new Set(allIds)).toEqual(new Set(["PU1"]));
  });

  it("getEarliestCommunicationDate ignores the earlier reaction", () => {
    const earliest = getEarliestCommunicationDate(["c-u"], USER);
    // RU1 is earlier (2026-01-01) but is a reaction — the earliest must be PU1.
    expect(earliest).toBe("2026-02-02T10:00:00.000Z");
  });

  it("buildUnattachedTextQuery SQL excludes reactions from search results", () => {
    const q = buildUnattachedTextQuery(USER, "3105559999", 50);
    const rows = db.prepare(q.sql).all(...q.params) as Array<{ id: string }>;
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["PU1"]));
    const count = db.prepare(q.countSql).get(...q.countParams) as { total: number };
    expect(count.total).toBe(1);
  });

  it("getMessageDerivedContacts excludes a reaction with a name-like sender", () => {
    // A real inbound message from a name-like sender → becomes a derived contact.
    insertMsg(db, {
      id: "PN1", external_id: "GN1", thread_id: "th-name", direction: "inbound",
      body_text: "hi", fromField: "RealPerson", participants_flat: "", sent_at: "2026-03-01T00:00:00.000Z",
    });
    // A REACTION from a name-like sender → must NOT become a derived contact.
    insertMsg(db, {
      id: "RN1", external_id: "RN1", thread_id: "th-name", direction: "inbound",
      body_text: "", fromField: "ReactBot", participants_flat: "", sent_at: "2026-03-01T00:00:01.000Z",
      associated_message_type: 2000, associated_message_guid: "GN1",
    });
    const names = getMessageDerivedContacts(USER).map((c) => c.display_name);
    expect(names).toContain("RealPerson");
    expect(names).not.toContain("ReactBot");
  });
});
