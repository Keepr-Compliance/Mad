/**
 * @jest-environment node
 *
 * BACKLOG-2302 — self-healing IN-PLACE re-tag of historical iMessage reactions.
 *
 * Reactions imported BEFORE BACKLOG-2280 were stored as ordinary text rows (Apple
 * summary text "Loved/Laughed at …", associated_message_type NULL). Post-2280 the
 * reaction columns are NULL for those rows, so they render as plain bubbles and
 * inflate counts. A normal re-import does NOT fix them: GUID dedup skips already-
 * stored rows, so associated_message_type is never back-filled — and a destructive
 * FORCE reimport (clear + reimport) cascade-deletes conversation attachments
 * (communications.message_id ON DELETE CASCADE), so it is NOT an acceptable fix.
 *
 * The fix: in storeMessages' dedup path, when a chat.db row's GUID matches an
 * EXISTING stored row AND the chat.db row is a reaction (associated_message_type in
 * [2000,3005]), UPDATE the existing row IN PLACE with the SAME reaction columns the
 * fresh-import path writes, instead of skipping it. The row then partitions to a
 * pill on the next render — self-healed on an ordinary sync, no force reimport.
 *
 * This drives the REAL storeMessages() against a REAL in-memory better-sqlite3 DB
 * (injected via a mocked databaseService.getRawDatabase), and asserts with EXACT
 * IDs that the row is UPDATED — not skipped, not duplicated — then partitions as a
 * reaction (excluded from the message list, present in reactionsByParentGuid). It
 * also proves a normal already-stored row is still skipped (no spurious update) and
 * that a second import re-tags nothing new (idempotent).
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Injected in-memory DB. Referenced lazily inside the databaseService mock — the
// `mock` name prefix satisfies jest's out-of-scope-variable guard.
let mockDb: DatabaseType;

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: () => mockDb },
}));
// storeMessages only extracts text for NON-existing rows; every row in these tests
// is already stored, so getMessageText is never reached. Stub it defensively so no
// native plist/typedstream parsing can run under jest.
jest.mock("../../utils/messageParser", () => ({
  __esModule: true,
  getMessageText: jest.fn(async () => ""),
}));

import macOSMessagesImportService from "../macOSMessagesImportService";
import { partitionReactions } from "../../utils/reactionUtils";
import type { RawMacMessage } from "../macOSMessagesImportService/types";

const USER = "user-2302";

interface StoreResult {
  stored: number;
  skipped: number;
  retagged: number;
  nullThreadIdCount: number;
  messageIdMap: Map<string, string>;
}
type StoreMessagesFn = (
  userId: string,
  messages: RawMacMessage[],
  chatMembersMap: Map<number, string[]>,
  chatAccountMap: Map<number, string>,
) => Promise<StoreResult>;

// storeMessages is private and uses `this` (this.abortController) — bind it to the
// singleton so production behavior is exercised faithfully.
const storeMessages = (
  macOSMessagesImportService as unknown as { storeMessages: StoreMessagesFn }
).storeMessages.bind(macOSMessagesImportService) as StoreMessagesFn;

const EMPTY_MEMBERS = new Map<number, string[]>();
const EMPTY_ACCOUNTS = new Map<number, string>();

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT,
      external_id TEXT,
      direction TEXT,
      body_text TEXT,
      participants TEXT,
      participants_flat TEXT,
      thread_id TEXT,
      sent_at DATETIME,
      has_attachments INTEGER DEFAULT 0,
      message_type TEXT,
      metadata TEXT,
      associated_message_type INTEGER,
      associated_message_guid TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

interface StoredRowOpts {
  id: string;
  external_id: string;
  body_text: string;
  message_type?: string | null;
  associated_message_type?: number | null;
  associated_message_guid?: string | null;
  thread_id?: string;
  sent_at?: string;
}

/** Seed a row that is ALREADY in the app DB (the historical-import state). */
function seedStoredRow(db: DatabaseType, o: StoredRowOpts): string {
  db.prepare(
    `INSERT INTO messages
       (id, user_id, channel, external_id, direction, body_text, participants,
        participants_flat, thread_id, sent_at, has_attachments, message_type,
        metadata, associated_message_type, associated_message_guid)
     VALUES (?, ?, 'imessage', ?, 'outbound', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    o.id,
    USER,
    o.external_id,
    o.body_text,
    JSON.stringify({ from: "me", to: ["+13105551234"] }),
    "13105551234",
    o.thread_id ?? "macos-chat-42",
    o.sent_at ?? "2026-01-01T10:05:00.000Z",
    o.message_type ?? null,
    JSON.stringify({ source: "macos_messages" }),
    o.associated_message_type ?? null,
    o.associated_message_guid ?? null,
  );
  return o.id;
}

/** Build a chat.db-shaped raw row (as fetched fresh from ~/Library/Messages). */
function rawRow(
  guid: string,
  associated_message_type: number | null,
  associated_message_guid: string | null,
): RawMacMessage {
  return {
    id: 1,
    guid,
    text: null,
    attributedBody: null,
    date: 725846400000000000, // arbitrary valid mac timestamp
    is_from_me: 1,
    handle_id: "+13105551234",
    service: "iMessage",
    chat_id: 42,
    cache_has_attachments: 0,
    associated_message_type,
    associated_message_guid,
  };
}

interface DbRow {
  id: string;
  external_id: string;
  body_text: string | null;
  message_type: string | null;
  associated_message_type: number | null;
  associated_message_guid: string | null;
}
function rowByExternalId(db: DatabaseType, externalId: string): DbRow[] {
  return db
    .prepare(
      `SELECT id, external_id, body_text, message_type, associated_message_type, associated_message_guid
       FROM messages WHERE user_id = ? AND external_id = ?`,
    )
    .all(USER, externalId) as DbRow[];
}
function allRows(db: DatabaseType): DbRow[] {
  return db
    .prepare(
      `SELECT id, external_id, body_text, message_type, associated_message_type, associated_message_guid
       FROM messages WHERE user_id = ? ORDER BY id`,
    )
    .all(USER) as DbRow[];
}

beforeEach(() => {
  mockDb = new Database(":memory:") as DatabaseType;
  createSchema(mockDb);
});

afterEach(() => {
  try { mockDb.close(); } catch { /* noop */ }
});

describe("BACKLOG-2302 — re-tag existing reactions in place (dedup → update-if-reaction)", () => {
  const PARENT_ID = "parent-msg";
  const PARENT_GUID = "GUID-PARENT";
  const REACTION_ID = "historical-reaction";
  const REACTION_GUID = "GUID-REACTION";

  function seedParentAndUntaggedReaction(): void {
    // Real parent message (a normal bubble).
    seedStoredRow(mockDb, {
      id: PARENT_ID,
      external_id: PARENT_GUID,
      body_text: "See you at 5",
      message_type: "text",
    });
    // Historical reaction stored BEFORE 2280: plain text bubble, reaction columns NULL.
    seedStoredRow(mockDb, {
      id: REACTION_ID,
      external_id: REACTION_GUID,
      body_text: 'Loved "See you at 5"',
      message_type: "text",
      associated_message_type: null,
      associated_message_guid: null,
    });
  }

  it("UPDATES the existing untagged reaction row in place — not skipped, not duplicated", async () => {
    seedParentAndUntaggedReaction();

    // chat.db re-read: same GUID, now carrying the real tapback association.
    // Part-guid prefix must be normalized to the bare parent guid.
    const result = await storeMessages(
      USER,
      [rawRow(REACTION_GUID, 2000, `p:0/${PARENT_GUID}`)],
      EMPTY_MEMBERS,
      EMPTY_ACCOUNTS,
    );

    // Neither a fresh insert nor an inert skip — it was re-tagged in place.
    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.retagged).toBe(1);

    // Exactly ONE row for the reaction GUID — no duplicate inserted.
    const rows = rowByExternalId(mockDb, REACTION_GUID);
    expect(rows).toHaveLength(1);

    // Row is now byte-identical to a freshly-imported reaction.
    const row = rows[0];
    expect(row.id).toBe(REACTION_ID); // same row, updated in place
    expect(row.associated_message_type).toBe(2000);
    expect(row.associated_message_guid).toBe(PARENT_GUID); // p:0/ prefix stripped
    expect(row.message_type).toBeNull();
    expect(row.body_text).toBe(""); // Apple summary text cleared

    // Total row set unchanged (parent + reaction), exact IDs.
    expect(new Set(allRows(mockDb).map((r) => r.id))).toEqual(
      new Set([PARENT_ID, REACTION_ID]),
    );
  });

  it("re-tagged row then partitions as a reaction — excluded from the message list, present under its parent", async () => {
    seedParentAndUntaggedReaction();

    await storeMessages(
      USER,
      [rawRow(REACTION_GUID, 2000, `p:0/${PARENT_GUID}`)],
      EMPTY_MEMBERS,
      EMPTY_ACCOUNTS,
    );

    const { messages, reactionsByParentGuid } = partitionReactions(allRows(mockDb));

    // Only the real parent surfaces as a displayable message.
    expect(new Set(messages.map((m) => m.id))).toEqual(new Set([PARENT_ID]));

    // The re-tagged reaction is keyed under the (normalized) parent GUID.
    const attached = reactionsByParentGuid.get(PARENT_GUID) ?? [];
    expect(new Set(attached.map((r) => r.id))).toEqual(new Set([REACTION_ID]));
  });

  it("leaves a normal already-stored (non-reaction) row untouched — still skipped, no spurious update", async () => {
    const NORMAL_ID = "normal-msg";
    const NORMAL_GUID = "GUID-NORMAL";
    seedStoredRow(mockDb, {
      id: NORMAL_ID,
      external_id: NORMAL_GUID,
      body_text: "hello there",
      message_type: "text",
    });

    // chat.db re-read of the same normal message (associated_message_type NULL).
    const result = await storeMessages(
      USER,
      [rawRow(NORMAL_GUID, null, null)],
      EMPTY_MEMBERS,
      EMPTY_ACCOUNTS,
    );

    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.retagged).toBe(0);

    // Row is completely unchanged — no reaction columns written, text preserved.
    const row = rowByExternalId(mockDb, NORMAL_GUID)[0];
    expect(row.body_text).toBe("hello there");
    expect(row.message_type).toBe("text");
    expect(row.associated_message_type).toBeNull();
    expect(row.associated_message_guid).toBeNull();
  });

  it("is idempotent — a second import re-tags nothing new", async () => {
    seedParentAndUntaggedReaction();
    const reactionRows = [rawRow(REACTION_GUID, 2000, `p:0/${PARENT_GUID}`)];

    const first = await storeMessages(USER, reactionRows, EMPTY_MEMBERS, EMPTY_ACCOUNTS);
    expect(first.retagged).toBe(1);

    // Second identical import: row is already tagged → the IS NULL guard matches
    // nothing → nothing re-tagged, counted as a plain skip.
    const second = await storeMessages(USER, reactionRows, EMPTY_MEMBERS, EMPTY_ACCOUNTS);
    expect(second.retagged).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.stored).toBe(0);

    // Still exactly one row, still tagged, still cleared.
    const rows = rowByExternalId(mockDb, REACTION_GUID);
    expect(rows).toHaveLength(1);
    expect(rows[0].associated_message_type).toBe(2000);
    expect(rows[0].body_text).toBe("");
  });
});
