/**
 * Pins for `db/appleSmsDbSql` — BACKLOG-2990 chunk 2.
 *
 * Eight statements are byte-identical to their pre-move text (content hash).
 * Three are DELIBERATELY CHANGED: `LIMIT`/`OFFSET` used to be interpolated
 * (`LIMIT ${Math.floor(n)}`) and now bind. `Math.floor` made the old form safe,
 * so this is not a live injection — it is a values-into-SQL pattern that would
 * otherwise have moved into `db/` as precedent.
 *
 * Byte-identity is therefore unavailable for those three, and the control that
 * replaces it is DIFFERENTIAL: the pre-move statement is reconstructed and run
 * against the same database, and the two must return an identical exact ID SET
 * at every page shape. A count would pass while returning different rows.
 *
 * ## Stated limit of this fixture
 *
 * `sms.db` is Apple's and there is no real one in this repository. The schema
 * below carries the columns and joins the parser reads. It pins THE STATEMENTS'
 * behaviour, not Apple's schema: if Apple changes `message`, this stays green
 * and the real path breaks. Recorded, not hidden.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  ALL_CHATS_SQL,
  AUDIO_TRANSCRIPT_COLUMN_PROBE_SQL,
  CHAT_BY_ROWID_SQL,
  CHAT_MESSAGE_COUNT_SQL,
  CHAT_PARTICIPANT_HANDLES_SQL,
  messageSelectColumnsForTest,
  searchMessagesByText,
  selectChatMessages,
} from "../appleSmsDbSql";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const CHAT = 1;

function openSmsDb(withAudioTranscript: boolean): void {
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      ${withAudioTranscript ? "audio_transcript TEXT," : ""}
      handle_id INTEGER, is_from_me INTEGER, date INTEGER,
      date_read INTEGER, date_delivered INTEGER, service TEXT
    );
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  db.prepare("INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (?, 'g1', 'c1')").run(CHAT);
}

/** Messages 1..n in a chat, ascending date. */
function seedMessages(n: number): void {
  const m = db.prepare("INSERT INTO message (ROWID, guid, text, date) VALUES (?, ?, ?, ?)");
  const j = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)");
  for (let i = 1; i <= n; i++) {
    m.run(i, `guid-${i}`, `body ${i}`, i * 1000);
    j.run(CHAT, i);
  }
}

/**
 * The PRE-MOVE statement, reconstructed.
 *
 * Transcribed from `iosMessagesParser.ts` at `6be95799a` — the interpolated
 * form, built from the same projection so the only difference under test is
 * how the page bounds reach SQLite.
 */
function preMoveChatMessages(hasAudio: boolean, chatId: number, limit?: number, offset?: number) {
  let query = `
        SELECT
          ${messageSelectColumnsForTest(hasAudio)}
        FROM message
        JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
        WHERE chat_message_join.chat_id = ?
        ORDER BY message.date ASC
      `;
  if (limit !== undefined) {
    query += ` LIMIT ${Math.max(1, Math.floor(limit))}`;
    if (offset !== undefined) query += ` OFFSET ${Math.max(0, Math.floor(offset))}`;
  }
  return (db.prepare(query).all(chatId) as Array<{ ROWID: number }>).map((r) => r.ROWID);
}

function preMoveSearch(hasAudio: boolean, pattern: string, limit?: number) {
  let sql = `
        SELECT
          ${messageSelectColumnsForTest(hasAudio)}
        FROM message
        WHERE message.text LIKE ?
        ORDER BY message.date DESC
      `;
  if (limit !== undefined && limit > 0) sql += ` LIMIT ${Math.floor(limit)}`;
  return (db.prepare(sql).all(pattern) as Array<{ ROWID: number }>).map((r) => r.ROWID);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2990-sms-"));
  db = new RealDatabase(path.join(tmpRoot, "sms.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("DIFFERENTIAL — binding the page bounds selects exactly what interpolating did", () => {
  beforeEach(() => {
    openSmsDb(true);
    seedMessages(8);
  });

  // Boundary sweep, not a sample: undefined, 0, 1, 2, N, and the fractional /
  // negative inputs the clamps exist for.
  const pages: Array<[string, number | undefined, number | undefined]> = [
    ["no page", undefined, undefined],
    ["limit 0", 0, undefined],
    ["limit 1", 1, undefined],
    ["limit 2", 2, undefined],
    ["limit 8 (all)", 8, undefined],
    ["limit 99 (over)", 99, undefined],
    ["limit 2.7 (fractional)", 2.7, undefined],
    ["limit -5 (negative)", -5, undefined],
    ["limit 3 offset 0", 3, 0],
    ["limit 3 offset 2", 3, 2],
    ["limit 3 offset 2.9", 3, 2.9],
    ["limit 3 offset -1", 3, -1],
    ["limit 3 offset 99", 3, 99],
  ];

  it.each(pages)("selectChatMessages agrees with the pre-move form: %s", (_label, limit, offset) => {
    const before = preMoveChatMessages(true, CHAT, limit, offset);
    const after = selectChatMessages<{ ROWID: number }>(db as never, true, CHAT, {
      limit,
      offset,
    }).map((r) => r.ROWID);

    // Exact ID set, in order. Two offsetting errors produce the same count.
    expect(after).toEqual(before);
  });

  it("limit 0 returns ONE row, not zero — the clamp is load-bearing", () => {
    // `Math.max(1, ...)`. Binding the RAW limit would return zero rows here,
    // which is why the clamped value is what binds.
    expect(selectChatMessages<{ ROWID: number }>(db as never, true, CHAT, { limit: 0 })).toHaveLength(1);
  });

  it("an offset without a limit is ignored, exactly as before", () => {
    const before = preMoveChatMessages(true, CHAT, undefined, 5);
    const after = selectChatMessages<{ ROWID: number }>(db as never, true, CHAT, {
      offset: 5,
    }).map((r) => r.ROWID);
    expect(after).toEqual(before);
    expect(after).toHaveLength(8);
  });
});

describe("DIFFERENTIAL — searchMessagesByText, whose clamp differs on purpose", () => {
  beforeEach(() => {
    openSmsDb(false);
    seedMessages(6);
  });

  const limits: Array<number | undefined> = [undefined, 0, 1, 3, 99, 2.7, -4];

  it.each(limits)("agrees with the pre-move form at limit=%s", (limit) => {
    const before = preMoveSearch(false, "%body%", limit);
    const after = searchMessagesByText<{ ROWID: number }>(db as never, false, "%body%", limit).map(
      (r) => r.ROWID,
    );
    expect(after).toEqual(before);
  });

  it("limit 0 returns EVERYTHING here, unlike selectChatMessages", () => {
    /**
     * The two call sites clamped differently and the difference is observable:
     * `searchMessages` gates on `limit > 0`, so zero means "no limit"; while
     * `getMessages` uses `Math.max(1, …)`, so zero means "one row".
     *
     * Two rules, preserved separately. Unifying them would have been a third
     * rule matching neither caller — the kind of tidy-up a mechanical move is
     * the wrong place for.
     */
    expect(searchMessagesByText(db as never, false, "%body%", 0)).toHaveLength(6);
    expect(selectChatMessages(db as never, false, CHAT, { limit: 0 })).toHaveLength(1);
  });

  it("orders newest first, the opposite of the chat read", () => {
    const ids = searchMessagesByText<{ ROWID: number }>(db as never, false, "%body%").map(
      (r) => r.ROWID,
    );
    expect(ids).toEqual([6, 5, 4, 3, 2, 1]);
  });
});

describe("the audio_transcript projection", () => {
  it("selects the column when the backup has it", () => {
    openSmsDb(true);
    seedMessages(1);
    db.prepare("UPDATE message SET audio_transcript = 'hi' WHERE ROWID = 1").run();

    const present = db.prepare(AUDIO_TRANSCRIPT_COLUMN_PROBE_SQL).all() as unknown[];
    expect(present).toHaveLength(1);

    const row = selectChatMessages<Record<string, unknown>>(db as never, true, CHAT)[0];
    expect(row.audio_transcript).toBe("hi");
  });

  it("omits it on an older backup instead of failing the whole query", () => {
    openSmsDb(false);
    seedMessages(2);

    expect(db.prepare(AUDIO_TRANSCRIPT_COLUMN_PROBE_SQL).all()).toEqual([]);

    // Selecting it unconditionally would throw "no such column" and return no
    // messages at all — the degrade-vs-fail distinction this probe exists for.
    const rows = selectChatMessages<Record<string, unknown>>(db as never, false, CHAT);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty("audio_transcript");
  });
});

describe("the static statements", () => {
  beforeEach(() => {
    openSmsDb(true);
    seedMessages(3);
  });

  it("ALL_CHATS_SQL and CHAT_BY_ROWID_SQL share a projection, so both build the same object", () => {
    const all = db.prepare(ALL_CHATS_SQL).all() as Array<Record<string, unknown>>;
    const one = db.prepare(CHAT_BY_ROWID_SQL).get(CHAT) as Record<string, unknown>;
    expect(Object.keys(one).sort()).toEqual(Object.keys(all[0]).sort());
    expect(one).toEqual(all[0]);
  });

  it("CHAT_MESSAGE_COUNT_SQL counts this chat only", () => {
    db.prepare("INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (2, 'g2', 'c2')").run();
    db.prepare("INSERT INTO message (ROWID, text, date) VALUES (99, 'other', 9000)").run();
    db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 99)").run();

    expect(db.prepare(CHAT_MESSAGE_COUNT_SQL).get(CHAT)).toEqual({ count: 3 });
  });

  it("CHAT_PARTICIPANT_HANDLES_SQL de-duplicates a handle joined twice", () => {
    // A chat that changed service carries the same handle twice in the join
    // table; without DISTINCT the participant appears twice.
    db.prepare("INSERT INTO handle (ROWID, id) VALUES (1, '+15555550101')").run();
    const j = db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
    j.run(CHAT, 1);
    j.run(CHAT, 1);

    expect(db.prepare(CHAT_PARTICIPANT_HANDLES_SQL).all(CHAT)).toEqual([{ id: "+15555550101" }]);
  });
});
