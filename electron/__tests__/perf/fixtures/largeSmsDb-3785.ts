/**
 * BACKLOG-3785: a generated iPhone sms.db at the founder's PC scale, written into an
 * iOS-backup layout (`<dir>/3d/3d0d7e5f…`) so `iOSMessagesParser.open(dir)` reads it.
 *
 * Shape: TOTAL messages over CHATS chats, chat sizes Zipf-like (s = 1.1), so a few
 * chats are very large and most are small (< 500 messages). ATTR_SHARE of the rows
 * have an empty `text` and an `attributedBody` typedstream (iOS 16+ shape).
 *
 * Indexes: the join-table primary keys and the message_id index an iPhone sms.db
 * carries (transcribed from the public iOS schema, not from any user's database).
 *
 * Handles are reserved 555-01xx numbers (public repo). No user data.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

export const SMS_DB_HASH = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";

const SCHEMA = `
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT);
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, style INTEGER,
    chat_identifier TEXT, display_name TEXT);
  CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
    text TEXT, attributedBody BLOB, handle_id INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
    date INTEGER, date_read INTEGER, date_delivered INTEGER, service TEXT,
    cache_has_attachments INTEGER DEFAULT 0);
  CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, filename TEXT,
    mime_type TEXT, transfer_name TEXT);
  CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, message_id));
  CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER,
    UNIQUE(message_id, attachment_id));
  CREATE INDEX chat_message_join_idx_message_id_only ON chat_message_join(message_id);
  CREATE INDEX chat_message_join_idx_message_date_id_chat_id ON chat_message_join(chat_id, message_date, message_id);
  CREATE INDEX message_attachment_join_idx_message_id ON message_attachment_join(message_id);
  CREATE INDEX message_idx_handle ON message(handle_id, date);
`;

function typedstream(text: string): Buffer {
  const t = Buffer.from(text, "utf8");
  const len = t.length < 128 ? Buffer.from([t.length]) : Buffer.from([0x81, t.length & 0xff, (t.length >> 8) & 0xff]);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from("streamtyped"),
    Buffer.alloc(10),
    Buffer.from("NSString"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    len,
    t,
  ]);
}

export interface LargeSmsDbOptions {
  total: number;
  chats: number;
  /** Share of rows with empty text + attributedBody. */
  attrShare?: number;
  /** One attachment every N messages. */
  attachmentEvery?: number;
  /** Explicit chat sizes (overrides the Zipf split; must sum to `total`). */
  sizes?: number[];
}

export interface LargeSmsDbInfo {
  dir: string;
  total: number;
  chats: number;
  largestChat: number;
  chatsUnder500: number;
  /** guid of every message, in ROWID order. */
  guids: () => string[];
}

/** Chat sizes summing exactly to `total`, Zipf-like, each >= 1. */
export function chatSizes(total: number, chats: number): number[] {
  const w = Array.from({ length: chats }, (_, i) => 1 / Math.pow(i + 1, 1.1));
  const sum = w.reduce((a, b) => a + b, 0);
  const sizes = w.map((x) => Math.max(1, Math.floor((x / sum) * total)));
  let diff = total - sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % chats) {
    if (diff > 0) {
      sizes[i]++;
      diff--;
    } else if (sizes[i] > 1) {
      sizes[i]--;
      diff++;
    }
  }
  return sizes;
}

export function buildLargeSmsDb(
  Database: new (file: string) => DatabaseType,
  dir: string,
  opts: LargeSmsDbOptions,
): LargeSmsDbInfo {
  const attrShare = opts.attrShare ?? 0.3;
  const attachmentEvery = opts.attachmentEvery ?? 40;
  const sub = nodePath.join(dir, SMS_DB_HASH.substring(0, 2));
  nodeFs.mkdirSync(sub, { recursive: true });
  const file = nodePath.join(sub, SMS_DB_HASH);
  if (nodeFs.existsSync(file)) nodeFs.unlinkSync(file);
  const db = new Database(file);
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");
  db.exec(SCHEMA);

  const sizes = opts.sizes ?? chatSizes(opts.total, opts.chats);
  if (sizes.length !== opts.chats || sizes.reduce((a, b) => a + b, 0) !== opts.total) {
    throw new Error("largeSmsDb-3785: sizes must have `chats` entries summing to `total`");
  }
  const insHandle = db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, 'iMessage')");
  const insChat = db.prepare("INSERT INTO chat (ROWID, guid, style, chat_identifier, display_name) VALUES (?, ?, 45, ?, NULL)");
  const insCHJ = db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
  const insMsg = db.prepare(
    `INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, date, date_read, date_delivered, service, cache_has_attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'iMessage', ?)`,
  );
  const insCMJ = db.prepare("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)");
  const insAtt = db.prepare("INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name) VALUES (?, ?, ?, 'image/jpeg', ?)");
  const insMAJ = db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)");

  // Apple epoch nanoseconds; spread over ~6 years.
  const START = 500_000_000 * 1e9;
  const SPAN = 190_000_000 * 1e9;
  let rowid = 0;
  let attId = 0;
  const fill = db.transaction(() => {
    for (let c = 0; c < opts.chats; c++) {
      const chatId = c + 1;
      const phone = `+1${200 + Math.floor(c / 100)}5550${String(100 + (c % 100)).padStart(3, "0")}`;
      insHandle.run(chatId, phone);
      insChat.run(chatId, `iMessage;-;${phone}`, phone);
      insCHJ.run(chatId, chatId);
      const n = sizes[c];
      for (let k = 0; k < n; k++) {
        rowid++;
        // Interleave dates across chats so ROWID order != date order within a chat.
        const date = START + Math.floor(((k + 0.5) / n) * SPAN) + (rowid % 997) * 1e6;
        const useAttr = (rowid * 2654435761) % 1000 < attrShare * 1000;
        const body = `Message ${rowid} in chat ${chatId}, a typical line of text.`;
        const hasAtt = rowid % attachmentEvery === 0 ? 1 : 0;
        insMsg.run(
          rowid,
          `G-3785-${rowid}`,
          useAttr ? null : body,
          useAttr ? typedstream(body) : null,
          rowid % 2 === 0 ? 0 : chatId,
          rowid % 2 === 0 ? 1 : 0,
          date,
          date,
          date,
          hasAtt,
        );
        insCMJ.run(chatId, rowid, date);
        if (hasAtt) {
          attId++;
          insAtt.run(attId, `A-3785-${attId}`, `~/Library/SMS/Attachments/aa/${attId}/IMG_${attId}.jpeg`, `IMG_${attId}.jpeg`);
          insMAJ.run(rowid, attId);
        }
      }
    }
  });
  fill();
  db.close();
  const largestChat = Math.max(...sizes);
  const chatsUnder500 = sizes.filter((s) => s < 500).length;
  return {
    dir,
    total: opts.total,
    chats: opts.chats,
    largestChat,
    chatsUnder500,
    guids: () => Array.from({ length: opts.total }, (_, i) => `G-3785-${i + 1}`),
  };
}
