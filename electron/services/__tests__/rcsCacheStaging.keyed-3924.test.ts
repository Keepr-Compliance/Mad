/**
 * @jest-environment node
 */
/**
 * BACKLOG-3924 — the cache commit resolves ids per chat with KEYED lookups and
 * yields between chats, against the REAL SQL on the production schema.
 *
 * Fixture shape transcribed from rcsCacheStaging-3658.test.ts (msg/chat/people
 * helpers and the A10 "already stored by an earlier Sync" scenario).
 *
 * Controls:
 *   K1 dedup parity: the commit's results and rows equal those of the old
 *      full-map writer (a superset map behind the same keyed calls).
 *   K2 the keyed lookups are chunked under SQLite's variable limit.
 *   Y1 a setImmediate callback runs between text-only chats (no file awaits).
 *   P1 timing on a 100k-message user with 30 chats (KEEPR_PERF_3924=1 only).
 *
 * The production-wiring spy (no full-table read) is in
 * electron/handlers/__tests__/rcsImportHandlers.commitKeyed-3924.test.ts.
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import {
  batchInsertMessages,
  findRcsContentDuplicates,
  getExistingAttachmentRecords,
  getExistingAttachmentRecordsForMessages,
  getMessageIdMap,
  getMessageIdsByExternalIds,
  insertAttachment,
  insertReactionRows,
  markMessageHasAttachments,
  rcsStagingDbOps,
} from "../db/syncDbService";
import {
  importCacheChat,
  peopleFrom,
  rcsChatHash,
  rcsExternalId,
  storeCacheChatSync,
  type RcsIncomingChat,
  type RcsChatPeople,
  type RcsIncomingMessage,
} from "../rcsImportStore";
import { rcsImageFilename } from "../rcsImportMedia";
import { RcsCacheStaging, type CacheLimits, type RcsCommitWriter, type RcsStagingFs } from "../rcsCacheStaging";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3924k";
const OTHER_USER = "user-3924other";
const JOB = "22222222-3333-4444-8555-666666666666"; // pii-allow-uuid: invented, not from any live row
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
const ALL: CacheLimits = { floorMs: 0, cap: null, protectedSpans: [] };

let db: DatabaseType;
let tmp: string;
let files: RcsStagingFs;
let staging: RcsCacheStaging;

const storeDeps = {
  batchInsertMessages,
  getMessageIdsByExternalIds,
  insertReactionRows,
  findContentDuplicates: findRcsContentDuplicates,
};

const writer: RcsCommitWriter = {
  storeChat: (chat, userId, people) => storeCacheChatSync(chat, userId, storeDeps, people),
  getMessageIdsByExternalIds,
  getExistingAttachmentRecordsForMessages,
  insertAttachment,
  markMessageHasAttachments,
  externalId: rcsExternalId,
  imageFilename: rcsImageFilename,
};

/** The pre-3924 reads behind the new keyed calls: the whole map / every record. */
const legacyStoreDeps = { ...storeDeps, getMessageIdsByExternalIds: (u: string) => getMessageIdMap(u) };
const legacyWriter: RcsCommitWriter = {
  ...writer,
  storeChat: (chat, userId, people) => storeCacheChatSync(chat, userId, legacyStoreDeps, people),
  getMessageIdsByExternalIds: (u: string) => getMessageIdMap(u),
  getExistingAttachmentRecordsForMessages: () => getExistingAttachmentRecords(),
};

function msg(id: string, sentAt: string, extra: Partial<RcsIncomingMessage> = {}): RcsIncomingMessage {
  return { msgId: id, direction: "inbound", sender: "x", text: `text ${id}`, sentAt, transport: "rcs", ...extra };
}
function chat(conv: string, messages: RcsIncomingMessage[]): RcsIncomingChat {
  return { conversationId: conv, title: "Test Contact A", messages };
}
function person(i: number): { people: RcsChatPeople; hash: string } {
  const n = `+1555555${String(1000 + i).padStart(4, "0")}`;
  const people = peopleFrom([{ name: `Test Contact ${i}`, number: n }], [n]);
  return { people, hash: rcsChatHash(people.numbers) };
}

const count = (q: string, ...p: unknown[]): number => (db.prepare(q).get(...p) as { n: number }).n;

function openDb(): void {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const u of [USER, OTHER_USER]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(u, `${u}@example.test`, `oauth-${u}`);
  }
  setDb(db);
  staging = new RcsCacheStaging(rcsStagingDbOps(), files);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rcs-keyed-3924-"));
  files = {
    stagingRoot: nodePath.join(tmp, "rcs-cache-staging"),
    attachmentsDir: nodePath.join(tmp, "message-attachments"),
    mkdir: async (d) => {
      await fs.promises.mkdir(d, { recursive: true });
    },
    writeSealed: (p, data) => fs.promises.writeFile(p, data),
    exists: async (p) => fs.existsSync(p),
    move: (from, to) => fs.promises.rename(from, to),
    unlink: async (p) => {
      await fs.promises.unlink(p).catch(() => undefined);
    },
    removeDir: async (d) => {
      await fs.promises.rm(d, { recursive: true, force: true });
    },
    listDir: async (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
  };
  openDb();
});

afterEach(() => {
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Bulk history for a user: `n` stored messages (raw SQL, external ids of another source). */
function seedHistory(userId: string, n: number, withAttachments = 0): void {
  const ins = db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, sent_at, thread_id)
     VALUES (?, ?, 'sms', ?, 'inbound', ?, ?, ?)`,
  );
  const att = db.prepare(
    `INSERT INTO attachments (id, message_id, filename, mime_type, storage_path) VALUES (?, ?, ?, 'image/png', ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `${userId}-hist-${i}`;
      ins.run(id, userId, `hist:${userId}:${i}`, `history ${i}`, new Date(Date.UTC(2024, 0, 1) + i * 60000).toISOString(), `hist-thread-${i % 500}`);
      if (i < withAttachments) att.run(`${id}-att`, id, `h${i}.png`, `/x/h${i}.png`);
    }
  })();
}

/** Stage `chats` chats of `per` messages; the first `withImages` chats get one image each. */
async function stageChats(chats: number, per: number, withImages = 0): Promise<void> {
  for (let c = 0; c < chats; c++) {
    const { people, hash } = person(c);
    const messages = Array.from({ length: per }, (_, i) =>
      msg(`c${c}m${i}`, new Date(Date.UTC(2026, 8, 1) + (c * per + i) * 60000).toISOString(), i === 0 && c < withImages ? { images: 1 } : {}),
    );
    staging.stageChat(JOB, USER, chat(`conv-${c}`, messages), people, hash);
    if (c < withImages) {
      await staging.stageImage(JOB, { conversationId: `conv-${c}`, msgId: `c${c}m0`, index: 0, mimeType: "image/png", base64: PNG }, hash);
    }
  }
}

function snapshot(): unknown {
  const msgs = db
    .prepare(
      `SELECT external_id AS e, body_text AS b, thread_id AS t, direction AS d, has_attachments AS a
       FROM messages WHERE user_id = ? AND external_id NOT LIKE 'hist:%' ORDER BY external_id`,
    )
    .all(USER);
  const atts = db
    .prepare(
      `SELECT m.external_id AS e, a.filename AS f FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.user_id = ? ORDER BY e, f`,
    )
    .all(USER);
  return { msgs, atts };
}

/**
 * The K1 scenario: an earlier Sync stored c0m0 and c0m1 (one with its image
 * already attached), a content duplicate exists for c1m0 under another key;
 * three chats are staged, each with an image (c1m0's goes unmatched: the
 * guard linked that message to the older row, not stored under its key).
 */
async function parityScenario(w: RcsCommitWriter): Promise<{ result: unknown; snap: unknown }> {
  seedHistory(USER, 50, 10);
  seedHistory(OTHER_USER, 50, 10);
  const p0 = person(0);
  const p1 = person(1);
  await importCacheChat(
    chat("conv-0", [msg("c0m0", "2026-09-01T00:00:00.000Z", { images: 1 }), msg("c0m1", "2026-09-01T00:01:00.000Z")]),
    USER,
    storeDeps,
    p0.people,
  );
  const c0m0 = db.prepare("SELECT id FROM messages WHERE external_id = ?").get(rcsExternalId(p0.hash, "c0m0")) as { id: string };
  db.prepare(`INSERT INTO attachments (id, message_id, filename, mime_type, storage_path) VALUES ('pre-att', ?, ?, 'image/png', '/x/pre.png')`)
    .run(c0m0.id, rcsImageFilename("c0m0", 0, "image/png"));
  // Same content as c1m0, stored by an older key (the BACKLOG-3630 content guard).
  await importCacheChat(chat("conv-1", [msg("c1m0", "2026-09-01T00:03:00.000Z")]), USER, storeDeps, p1.people);
  db.prepare("UPDATE messages SET external_id = 'gmweb2:legacy-key' WHERE external_id = ?").run(rcsExternalId(p1.hash, "c1m0"));

  await stageChats(3, 3, 3);
  const result = await staging.commit(JOB, USER, ALL, w);
  return { result, snap: snapshot() };
}

describe("BACKLOG-3924 keyed commit", () => {
  it("K1 dedup parity: same results and rows as the old full-map reads", async () => {
    const keyed = await parityScenario(writer);
    // Fresh database, same scenario, the pre-3924 reads.
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    openDb();
    const legacy = await parityScenario(legacyWriter);

    expect(keyed.result).toEqual(legacy.result);
    expect(keyed.snap).toEqual(legacy.snap);
    // The scenario exercises what it claims: existing rows (2) + the content guard (1), an existing image,
    // a guarded message's image, a new image.
    expect(keyed.result).toMatchObject({ chats: 3, stored: 6, alreadyPresent: 3, imagesStored: 1, imagesAlreadyThere: 1, imagesNoMessage: 1 });
  });

  it("K2 keyed lookups are chunked under SQLite's variable limit", async () => {
    const seen: number[] = [];
    const counting: RcsCommitWriter = {
      ...writer,
      storeChat: (c, u, p) =>
        storeCacheChatSync(c, u, { ...storeDeps, getMessageIdsByExternalIds: (uid, ids) => (seen.push(ids.length), getMessageIdsByExternalIds(uid, ids)) }, p),
    };
    await stageChats(1, 1200);
    const r = await staging.commit(JOB, USER, ALL, counting);
    expect(r).toMatchObject({ chats: 1, stored: 1200 });
    expect(seen.length).toBeGreaterThan(1);
    expect(Math.max(...seen)).toBeLessThanOrEqual(500);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(1200);
  });

  it("Y1 the event loop runs between text-only chats", async () => {
    await stageChats(4, 2);
    let ticks = 0;
    let stop = false;
    const tick = (): void => {
      ticks += 1;
      if (!stop) setImmediate(tick);
    };
    setImmediate(tick);
    const seenAtChat: number[] = [];
    const r = await staging.commit(JOB, USER, ALL, writer, { perChat: () => seenAtChat.push(ticks) });
    stop = true;
    expect(r).toMatchObject({ chats: 4, chatsFailed: 0 });
    expect(seenAtChat).toHaveLength(4);
    // Every chat after the first sees the loop has turned since the one before it.
    for (let i = 1; i < seenAtChat.length; i++) expect(seenAtChat[i]).toBeGreaterThan(seenAtChat[i - 1]);
  });

  const perf = process.env.KEEPR_PERF_3924 ? it : it.skip;
  perf("P1 timing: 100k-message user, 30 chats (10 with an image)", async () => {
    seedHistory(USER, 100_000, 20_000);
    await stageChats(30, 20, 10);
    const t0 = process.hrtime.bigint();
    const r = await staging.commit(JOB, USER, ALL, writer);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r).toMatchObject({ chats: 30, stored: 600, imagesStored: 10 });
    process.stderr.write(`[3924 P1] commit of 30 chats over 100k messages: ${ms.toFixed(0)} ms\n`);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", USER)).toBe(100_600);
  }, 120_000);
});
