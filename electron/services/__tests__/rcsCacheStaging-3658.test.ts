/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 — the cache Sync's atomic, limit-aware import, against the REAL
 * SQL on the production schema and a real temp folder (run under Electron's
 * Node locally; the native module is built for Electron).
 *
 * Mutation controls (each turns at least one test red):
 *   A1 a staged chat written to messages before the commit      → "staging writes nothing to messages"
 *   A2 the commit not in ONE transaction (a throw keeps rows)    → "a failing commit leaves messages as they were"
 *   A3 the floor (months setting) not applied                   → "the months setting drops older messages"
 *   A4 the cap keeping the OLDEST, or counted per chat           → "the cap keeps the newest N across chats"
 *   A5 audit periods counted against the cap / dropped          → "messages in an audit period are always kept"
 *   A6 reactions or images of a dropped message kept            → "reactions and images follow their message"
 *   A7 a cancel / error leaving rows or files                   → "a discard leaves nothing"
 *   A8 a late chat/image of an ended job staged                 → "an ended job stages nothing"
 *   A9 placed files kept after a failed commit                  → "a failing commit leaves messages as they were"
 *   A10 the content guard / dedup skipped by the commit          → "the commit is the same writer"
 *   A11 schema.sql not re-runnable (IF NOT EXISTS)               → "schema.sql runs twice"
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
  getMessageIdMap,
  insertAttachment,
  insertReactionRows,
  markMessageHasAttachments,
  rcsStagingDbOps,
  repointLegacyRcsRemoval,
} from "../db/syncDbService";
import {
  importCacheChat,
  peopleFrom,
  rcsChatHash,
  rcsExternalId,
  storeCacheChatSync,
  type RcsIncomingChat,
  type RcsIncomingMessage,
} from "../rcsImportStore";
import { rcsImageFilename } from "../rcsImportMedia";
import {
  RcsCacheStaging,
  RcsStagingJobEndedError,
  selectForCommit,
  type CacheLimits,
  type RcsCommitWriter,
  type RcsStagingFs,
} from "../rcsCacheStaging";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3658s";
const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
const NUM_A = "+15555550101";
const NUM_B = "+15555550102";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

let db: DatabaseType;
let tmp: string;
let files: RcsStagingFs;
let staging: RcsCacheStaging;

const storeDeps = {
  batchInsertMessages,
  getMessageIdMap,
  insertReactionRows,
  findContentDuplicates: findRcsContentDuplicates,
  repointLegacyRemoval: repointLegacyRcsRemoval,
};

const writer: RcsCommitWriter = {
  storeChat: (chat, userId, people) => storeCacheChatSync(chat, userId, storeDeps, people),
  getMessageIdMap,
  getExistingAttachmentRecords,
  insertAttachment,
  markMessageHasAttachments,
  externalId: rcsExternalId,
  imageFilename: rcsImageFilename,
};

const ALL: CacheLimits = { floorMs: 0, cap: null, protectedSpans: [] };

function msg(id: string, sentAt: string, extra: Partial<RcsIncomingMessage> = {}): RcsIncomingMessage {
  return { msgId: id, direction: "inbound", sender: "x", text: `text ${id}`, sentAt, transport: "rcs", ...extra };
}

function chat(conv: string, messages: RcsIncomingMessage[]): RcsIncomingChat {
  return { conversationId: conv, title: "Test Contact A", messages };
}

const peopleA = peopleFrom([{ name: "Test Contact A", number: NUM_A }], [NUM_A]);
const peopleB = peopleFrom([{ name: "Test Contact B", number: NUM_B }], [NUM_B]);
const hashA = rcsChatHash(peopleA.numbers);
const hashB = rcsChatHash(peopleB.numbers);

const count = (q: string, ...p: unknown[]): number => (db.prepare(q).get(...p) as { n: number }).n;
const messageCount = () => count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", USER);
const stagedCount = () =>
  count("SELECT COUNT(*) AS n FROM rcs_cache_staging_messages") +
  count("SELECT COUNT(*) AS n FROM rcs_cache_staging_chats") +
  count("SELECT COUNT(*) AS n FROM rcs_cache_staging_images");
const listFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);
const bodies = () =>
  (db.prepare("SELECT body_text AS b FROM messages WHERE user_id = ? AND associated_message_type IS NULL ORDER BY sent_at").all(USER) as Array<{ b: string }>)
    .map((r) => r.b);

beforeEach(() => {
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rcs-staging-3658-"));
  files = {
    stagingRoot: nodePath.join(tmp, "rcs-cache-staging"),
    attachmentsDir: nodePath.join(tmp, "message-attachments"),
    mkdir: async (d) => {
      await fs.promises.mkdir(d, { recursive: true });
    },
    writeFile: (p, data) => fs.promises.writeFile(p, data),
    exists: async (p) => fs.existsSync(p),
    move: (from, to) => fs.promises.rename(from, to),
    unlink: async (p) => {
      await fs.promises.unlink(p).catch(() => undefined);
    },
    removeDir: async (d) => {
      await fs.promises.rm(d, { recursive: true, force: true });
    },
  };
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-3658s@example.test', 'google', 'oauth-3658s')").run(USER);
  setDb(db);
  staging = new RcsCacheStaging(rcsStagingDbOps(), files);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("staging (BACKLOG-3658 atomic import)", () => {
  it("staging writes nothing to messages; the reply keeps the /chat contract (A1)", async () => {
    const reply = staging.stageChat(JOB, USER, chat("conv-a", [
      msg("m1", "2026-09-20T10:00:00.000Z", { reactions: [{ emoji: "x", reactor: "me", word: "" }] }),
      msg("m2", "2026-09-21T10:00:00.000Z"),
    ]), peopleA, hashA);
    expect(reply).toMatchObject({ received: 2, stored: 0, linked: 0, reactions: 1, removedByUser: 0 });
    expect(await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "m1", index: 0, mimeType: "image/png", base64: PNG }, hashA))
      .toMatchObject({ stored: true });
    expect(messageCount()).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    expect(listFiles(files.attachmentsDir)).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_staging_messages WHERE job_id = ?", JOB)).toBe(2);
  });

  it("an image whose message was not staged is refused (message_not_found)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("m1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    expect(await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "nope", index: 0, mimeType: "image/png", base64: PNG }, hashA))
      .toEqual({ stored: false, reason: "message_not_found" });
  });

  it("the commit is the same writer: rows, key, participants, dedup and the content guard (A10)", async () => {
    // Already stored by an earlier Sync: m1 (same key) is not stored twice.
    await importCacheChat(chat("conv-a", [msg("m1", "2026-09-20T10:00:00.000Z")]), USER, storeDeps, peopleA);
    staging.stageChat(JOB, USER, chat("conv-a", [msg("m1", "2026-09-20T10:00:00.000Z"), msg("m2", "2026-09-21T10:00:00.000Z")]), peopleA, hashA);
    const r = await staging.commit(JOB, USER, ALL, writer);
    expect(r).toMatchObject({ staged: 2, kept: 2, chats: 1, stored: 1, alreadyPresent: 1 });
    const row = db.prepare("SELECT external_id AS e, thread_id AS t, participants AS p FROM messages WHERE body_text = 'text m2'").get() as
      { e: string; t: string; p: string };
    expect(row.e).toBe(rcsExternalId(hashA, "m2"));
    expect(row.t).toBe(`gmweb2-${hashA}`);
    expect(JSON.parse(row.p)).toEqual({ from: NUM_A, to: ["me"] });
    expect(messageCount()).toBe(2);
    expect(stagedCount()).toBe(0);
  });
});

describe("limits: the user's months and max-messages settings", () => {
  const stageTwoChats = () => {
    staging.stageChat(JOB, USER, chat("conv-a", [
      msg("a1", "2026-06-01T10:00:00.000Z"),
      msg("a2", "2026-09-01T10:00:00.000Z"),
      msg("a3", "2026-09-29T10:00:00.000Z"),
    ]), peopleA, hashA);
    staging.stageChat(JOB, USER, chat("conv-b", [
      msg("b1", "2026-08-15T10:00:00.000Z"),
      msg("b2", "2026-09-30T10:00:00.000Z"),
    ]), peopleB, hashB);
  };

  it("the months setting drops older messages (A3)", async () => {
    stageTwoChats();
    const r = await staging.commit(JOB, USER, { floorMs: Date.parse("2026-07-01T00:00:00.000Z"), cap: null, protectedSpans: [] }, writer);
    expect(r).toMatchObject({ staged: 5, kept: 4, droppedByDate: 1, droppedByCap: 0 });
    expect(bodies()).toEqual(["text b1", "text a2", "text a3", "text b2"]);
  });

  it("the cap keeps the newest N across chats (A4)", async () => {
    stageTwoChats();
    const r = await staging.commit(JOB, USER, { floorMs: 0, cap: 3, protectedSpans: [] }, writer);
    expect(r).toMatchObject({ kept: 3, droppedByCap: 2 });
    expect(bodies()).toEqual(["text a2", "text a3", "text b2"]);
  });

  it("messages in an audit period are always kept and never counted (A5)", async () => {
    stageTwoChats();
    const span = { startMs: Date.parse("2026-05-01T00:00:00.000Z"), endMs: Date.parse("2026-06-30T00:00:00.000Z") };
    const r = await staging.commit(JOB, USER, { floorMs: 0, cap: 2, protectedSpans: [span] }, writer);
    expect(r).toMatchObject({ kept: 3, droppedByCap: 2 });
    expect(bodies()).toEqual(["text a1", "text a3", "text b2"]);
  });

  it("selectForCommit: undated messages are dropped with the old ones", () => {
    const s = selectForCommit([{ chatHash: "h", msgId: "x", sentAt: "not a date" }], ALL);
    expect(s).toMatchObject({ staged: 1, droppedByDate: 1 });
    expect(s.kept.size).toBe(0);
  });
});

describe("reactions and images follow their message (A6)", () => {
  it("a dropped message drops its reactions and images; a kept one keeps them", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [
      msg("old", "2026-06-01T10:00:00.000Z", { reactions: [{ emoji: "x", reactor: "me", word: "" }], images: 1 }),
      msg("new", "2026-09-29T10:00:00.000Z", { reactions: [{ emoji: "y", reactor: "me", word: "" }], images: 1 }),
    ]), peopleA, hashA);
    for (const id of ["old", "new"]) {
      const bytes = Buffer.from(`image ${id}`).toString("base64");
      expect(await staging.stageImage(JOB, { conversationId: "conv-a", msgId: id, index: 0, mimeType: "image/png", base64: bytes }, hashA))
        .toMatchObject({ stored: true });
    }
    const r = await staging.commit(JOB, USER, { floorMs: Date.parse("2026-07-01T00:00:00.000Z"), cap: null, protectedSpans: [] }, writer);
    expect(r).toMatchObject({ kept: 1, imagesStaged: 1, imagesStored: 1 });
    const reactions = db.prepare("SELECT associated_message_guid AS g FROM messages WHERE associated_message_type IS NOT NULL").all() as Array<{ g: string }>;
    expect(reactions.map((x) => x.g)).toEqual([rcsExternalId(hashA, "new")]);
    const att = db.prepare("SELECT filename, storage_path AS p FROM attachments").all() as Array<{ filename: string; p: string }>;
    expect(att.map((a) => a.filename)).toEqual(["gmweb-new-0.png"]);
    expect(fs.existsSync(att[0].p)).toBe(true);
    expect(listFiles(files.attachmentsDir)).toHaveLength(1);
    expect(count("SELECT has_attachments AS n FROM messages WHERE body_text = 'text new'")).toBe(1);
    // The staging folder is gone (the dropped image's file with it).
    expect(fs.existsSync(files.stagingRoot) ? listFiles(files.stagingRoot) : []).toEqual([]);
  });
});

describe("atomic: all or nothing", () => {
  it("a failing commit leaves messages as they were, deletes the placed files and the staging (A2, A9)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    staging.stageChat(JOB, USER, chat("conv-b", [msg("b1", "2026-09-21T10:00:00.000Z")]), peopleB, hashB);
    await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    let calls = 0;
    const failing: RcsCommitWriter = {
      ...writer,
      storeChat: (c, u, p) => {
        calls += 1;
        if (calls === 2) throw new Error("disk I/O error");
        return writer.storeChat(c, u, p);
      },
    };
    await expect(staging.commit(JOB, USER, ALL, failing)).rejects.toThrow("disk I/O error");
    expect(calls).toBe(2);
    expect(messageCount()).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    expect(listFiles(files.attachmentsDir)).toEqual([]);
    expect(stagedCount()).toBe(0);
  });

  it("a discard (cancel / error / user switch) leaves nothing (A7)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    await staging.discard(JOB);
    expect(stagedCount()).toBe(0);
    expect(messageCount()).toBe(0);
    expect(listFiles(files.stagingRoot)).toEqual([]);
  });

  it("an ended job stages nothing: a late chat or image is refused (A8)", async () => {
    await staging.discard(JOB);
    expect(() => staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA))
      .toThrow(RcsStagingJobEndedError);
    await expect(staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA))
      .rejects.toThrow(RcsStagingJobEndedError);
    expect(stagedCount()).toBe(0);
  });

  it("a new job sweeps stale staging (a crash, a quit)", async () => {
    staging.stageChat("stale-job", USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    await staging.stageImage("stale-job", { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    await staging.discardAll();
    expect(stagedCount()).toBe(0);
    expect(fs.existsSync(files.stagingRoot)).toBe(false);
  });

  it("schema.sql runs twice (CREATE ... IF NOT EXISTS) (A11)", () => {
    expect(() => db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"))).not.toThrow();
  });
});
