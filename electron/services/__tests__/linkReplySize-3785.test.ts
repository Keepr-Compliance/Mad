/**
 * @jest-environment node
 *
 * BACKLOG-3785 — reply-size bounds for the Attach Messages path at 100k scale.
 *
 * Measured before the fix on a 670k-message profile:
 *   transactions:get-communications after a link    107,149,810 bytes
 *   transactions:get-messages-by-contact (150 chats)  33,161,033 bytes
 * Electron structured-clones every reply onto the renderer's main thread, so
 * the reply size is the renderer freeze.
 *
 * Guards, on the real schema and real readers, sized with `v8.serialize` (the
 * encoding Electron uses for invoke replies):
 *   1. With 100,000 texts already linked, linking 10 more yields a delta reply
 *      bounded by the batch — and the full reread it replaces is not (control
 *      that the measure separates the two).
 *   2. Applying the delta to the held ids gives exactly the full reread's ids.
 *   3. The picker rows carry none of the columns the renderer never reads.
 */

import { readFileSync } from "fs";
import path from "path";
import v8 from "v8";
import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";

let realDb: TestDb | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => realDb,
  dbAll: (sql: string, params: unknown[] = []) => realDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) => realDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = realDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T,>(fn: () => T): T => realDb!.transaction(fn)(),
  dbExec: (sql: string) => realDb!.exec(sql),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
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

import { getCommunicationsWithMessages } from "../db/communicationDbService";
import { getMessagesByContact } from "../db/messageDbService";
import { computeCommunicationsDelta } from "../transactionService/communicationsDelta";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "3b8e1f40-2c6d-4a97-b5e3-9d0a6f2c4e18"; // pii-allow-uuid: invented for this fixture, not from any live row
const TX = "7c1d5a92-8e4f-4b30-a2d6-5f9e3b7c1a04"; // pii-allow-uuid: invented for this fixture, not from any live row
const LINKED = 100_000;
const BATCH = 10;
const PICKER_ROWS = 2_000;
const CONTACT = "+13125550150";

function seed(db: TestDb): void {
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner@example.com", "oauth-3785-size");
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, status, message_count) VALUES (?, ?, ?, 'active', ?)",
  ).run(TX, USER, "1 Example Way, Springfield", LINKED);

  // Row shape transcribed from the iPhone sync writer (participants JSON,
  // participants_flat digits, metadata.source) — see seed-large-history.js.
  const msg = db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat,
                           thread_id, sent_at, transaction_id, metadata, llm_analysis)
     VALUES (?, ?, 'imessage', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const comm = db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, link_confidence)
     VALUES (?, ?, ?, ?, 'manual', 1.0)`,
  );
  const meta = JSON.stringify({ source: "iphone_sync", guid: "x".repeat(40), service: "iMessage" });
  db.transaction(() => {
    for (let i = 0; i < LINKED + BATCH; i++) {
      const id = `m-${i}`;
      const phone = `+1206555${String(100 + (i % 100)).padStart(4, "0")}`;
      const sentAt = new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
      msg.run(
        id, USER, i % 2 ? "inbound" : "outbound", `synthetic body number ${i}`,
        JSON.stringify({ from: i % 2 ? phone : "me", to: [i % 2 ? "me" : phone] }), phone.slice(1),
        `ios-chat-${i % 2300}`, sentAt, i < LINKED ? TX : null, meta, null,
      );
      if (i < LINKED) comm.run(`c-${i}`, USER, TX, id);
    }
    for (let i = 0; i < PICKER_ROWS; i++) {
      msg.run(
        `p-${i}`, USER, "inbound", `picker body ${i}`,
        JSON.stringify({ from: CONTACT, to: ["me"] }), CONTACT.slice(1), `picker-chat-${i % 150}`,
        new Date(Date.UTC(2025, 5, 1) + i * 60_000).toISOString(), null, meta,
        JSON.stringify({ summary: "y".repeat(200) }),
      );
    }
  })();
}

beforeAll(() => {
  realDb = openTestDb();
  seed(realDb);
});
afterAll(() => {
  realDb?.close();
  realDb = null;
});

describe("Attach Messages reply sizes at 100k scale (BACKLOG-3785)", () => {
  it("the post-link delta is bounded by the batch; the full reread it replaces is not", async () => {
    const before = await getCommunicationsWithMessages(TX, "text");
    expect(before).toHaveLength(LINKED);
    const knownIds = before.map((c) => c.id);

    // Link the batch the way linkMessages does: pointer + junction row.
    for (let i = LINKED; i < LINKED + BATCH; i++) {
      realDb!.prepare("UPDATE messages SET transaction_id = ? WHERE id = ?").run(TX, `m-${i}`);
      realDb!
        .prepare(
          "INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, link_confidence) VALUES (?, ?, ?, ?, 'manual', 1.0)",
        )
        .run(`c-${i}`, USER, TX, `m-${i}`);
    }

    const after = await getCommunicationsWithMessages(TX, "text");
    const delta = computeCommunicationsDelta(after, knownIds);
    const deltaBytes = v8.serialize({ success: true, ...delta }).byteLength;
    const fullBytes = v8.serialize({ success: true, transaction: { communications: after } }).byteLength;

    expect(delta.added.map((c) => c.id).sort()).toEqual(
      Array.from({ length: BATCH }, (_, k) => `m-${LINKED + k}`).sort(),
    );
    expect(delta.removedIds).toEqual([]);
    // ~1 KB per row; 10 rows.
    expect(deltaBytes).toBeLessThan(50_000);
    // Control: the measure separates the two (the full reread is tens of MB).
    expect(fullBytes).toBeGreaterThan(10_000_000);

    // Held ids + delta == the full reread's ids.
    const removed = new Set(delta.removedIds);
    const merged = new Set([...knownIds.filter((id) => !removed.has(id)), ...delta.added.map((c) => c.id)]);
    expect(merged).toEqual(new Set(after.map((c) => c.id)));
  });

  it("the picker rows carry only the columns the renderer reads", () => {
    const rows = getMessagesByContact(USER, CONTACT) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(PICKER_ROWS);
    for (const dropped of ["metadata", "llm_analysis", "classification_method", "content_hash", "sync_session_id"]) {
      expect(rows[0]).not.toHaveProperty(dropped);
    }
    for (const kept of ["id", "thread_id", "participants", "body_text", "sent_at", "direction", "thread_display_name"]) {
      expect(rows[0]).toHaveProperty(kept);
    }
    const bytesPerRow = v8.serialize({ success: true, messages: rows }).byteLength / rows.length;
    // Measured on this fixture: 503 B/row with the projection, 1,160 B/row with `m.*`.
    expect(bytesPerRow).toBeLessThan(900);
  });
});
