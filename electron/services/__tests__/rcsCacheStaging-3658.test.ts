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
 *   A2 one chat's failure taking the others down (3671 P3)     → "a chat that fails rolls back alone"
 *   A3 the floor (months setting) not applied                   → "the months setting drops older messages"
 *   A4 the cap keeping the OLDEST, or counted per chat           → "the cap keeps the newest N across chats"
 *   A5 audit periods counted against the cap / dropped          → "messages in an audit period are always kept"
 *   A6 reactions or images of a dropped message kept            → "reactions and images follow their message"
 *   A7 a cancel / error leaving rows or files                   → "a discard leaves nothing"
 *   A8 a late chat/image of an ended job staged                 → "an ended job stages nothing"
 *   A9 placed files kept after a failed chat                    → "a chat that fails rolls back alone"
 *   A10 the content guard / dedup skipped by the commit          → "the commit is the same writer"
 *   A11 schema.sql not re-runnable (IF NOT EXISTS)               → "schema.sql runs twice"
 *   B1a a sweep during a commit deletes that commit's staging     → "a sweep never touches a commit in progress"
 *   B1b a failed commit unlinks a file another row now uses       → "a failed commit keeps a file another row now uses"
 *   S2a files moved without a journal row first                   → "journaled before the move"
 *   S2b the journal not cleared after the commit                  → "journaled before the move"
 *   S2c a crashed commit's files never recovered                  → "a crashed commit's files are recovered"
 *   T1  an abandoned (hung) commit still counted as in progress    → "an abandoned commit"
 *   T2  a slow commit abandoned meanwhile still writes             → "a slow commit abandoned meanwhile"
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

  // Founder (2026-10-01): "saved N chats" counts only chats with a message
  // kept. Mutation: count every staged chat → red.
  it("a chat whose messages are all older than the floor is not a saved chat (A3b)", async () => {
    stageTwoChats();
    // Every message of conv-a is older than the floor; conv-b keeps b2.
    const r = await staging.commit(JOB, USER, { floorMs: Date.parse("2026-09-29T12:00:00.000Z"), cap: null, protectedSpans: [] }, writer);
    expect(r).toMatchObject({ staged: 5, kept: 1, chats: 1, stored: 1 });
    expect(bodies()).toEqual(["text b2"]);
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
    // #14: the kept message's reaction is counted in the saved result. Mutation: not summed → red.
    expect(r).toMatchObject({ kept: 1, imagesStaged: 1, imagesStored: 1, reactions: 1 });
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

  // SR optional: the commit orders a chat's messages by time then id, not by
  // staging order (a retried chat is staged twice, its seq values mix).
  // Mutation: back to ORDER BY seq → red.
  it("a chat staged twice (a retry) commits its messages in time order", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [
      msg("10", "2026-09-29T12:00:00.000Z"),
      msg("9", "2026-09-29T11:00:00.000Z"),
    ]), peopleA, hashA);
    staging.stageChat(JOB, USER, chat("conv-a", [msg("8", "2026-09-29T10:00:00.000Z"), msg("11", "2026-09-29T11:00:00.000Z")]), peopleA, hashA);
    const order: string[] = [];
    const spy = { ...writer, storeChat: (c: RcsIncomingChat, u: string, p: RcsChatPeople) => {
      order.push(...c.messages.map((m) => m.msgId));
      return writer.storeChat(c, u, p);
    } };
    await staging.commit(JOB, USER, { floorMs: Date.parse("2026-07-01T00:00:00.000Z"), cap: null, protectedSpans: [] }, spy);
    expect(order).toEqual(["8", "9", "11", "10"]);
  });

  // Live (0.3.18): "0 reactions" while 52 were sent, "images 0 of 4": what
  // was already in Keepr counted as nothing. Mutations: reactionsKept /
  // imagesAlreadyThere not counted → red.
  it("a second Sync of the same chat: reactions and images already there are counted as such", async () => {
    const stageOnce = async (job: string) => {
      staging.stageChat(job, USER, chat("conv-a", [
        msg("new", "2026-09-29T10:00:00.000Z", { reactions: [{ emoji: "y", reactor: "me", word: "" }], images: 1 }),
      ]), peopleA, hashA);
      await staging.stageImage(job, { conversationId: "conv-a", msgId: "new", index: 0, mimeType: "image/png", base64: Buffer.from("image new").toString("base64") }, hashA);
      return staging.commit(job, USER, { floorMs: Date.parse("2026-07-01T00:00:00.000Z"), cap: null, protectedSpans: [] }, writer);
    };
    const first = await stageOnce(JOB);
    expect(first).toMatchObject({ reactions: 1, reactionsKept: 1, imagesStored: 1, imagesAlreadyThere: 0, imagesNoMessage: 0 });
    const second = await stageOnce(JOB.replace(/.$/, (c) => (c === "0" ? "1" : "0")));
    expect(second).toMatchObject({ stored: 0, alreadyPresent: 1, reactions: 0, reactionsKept: 1, imagesStaged: 1, imagesStored: 0, imagesAlreadyThere: 1 });
  });
});

describe("atomic: all or nothing", () => {
  // 3671 P3 (founder): per-chat atomicity. Mutation: one transaction for the
  // whole run again → red (the other chat lost); a failed chat's files kept → red.
  it("a chat that fails rolls back alone: its rows and placed files go, the other chat is saved (A2, A9)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    staging.stageChat(JOB, USER, chat("conv-b", [msg("b1", "2026-09-21T10:00:00.000Z")]), peopleB, hashB);
    await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    const failing: RcsCommitWriter = {
      ...writer,
      storeChat: (c, u, p) => {
        if (c.conversationId === "conv-a") throw new Error("disk I/O error");
        return writer.storeChat(c, u, p);
      },
    };
    const r = await staging.commit(JOB, USER, ALL, failing);
    expect(r).toMatchObject({ chats: 1, chatsFailed: 1, stopped: false });
    expect(messageCount()).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    expect(listFiles(files.attachmentsDir)).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_placed_files")).toBe(0);
    expect(stagedCount()).toBe(0);
  });

  // 3671 P3 (SR): a chat switched to Don't sync since it was read is not
  // saved; the run-level step runs only for a complete run with no failure.
  // Mutations: chatExcluded ignored → red; runDone run for an incomplete run → red.
  it("exclusions are re-checked per chat at commit; an incomplete run records no run", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    staging.stageChat(JOB, USER, chat("conv-b", [msg("b1", "2026-09-21T10:00:00.000Z")]), peopleB, hashB);
    const runs: number[] = [];
    const r = await staging.commit(JOB, USER, ALL, writer, {
      chatExcluded: (_u, hash) => hash === hashB,
      runDone: (out) => void runs.push(out.chats),
    }, { complete: false });
    expect(r).toMatchObject({ chats: 1, chatsExcluded: 1 });
    expect(messageCount()).toBe(1);
    expect(runs).toEqual([]);
  });

  // SR: the save timeout stops further chats and keeps the committed ones.
  // Mutation: abandon not checked between chats → red.
  it("abandoned (the save timeout) after the first chat: that chat stays, no further chat is written", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    staging.stageChat(JOB, USER, chat("conv-b", [msg("b1", "2026-09-21T10:00:00.000Z")]), peopleB, hashB);
    let first = "";
    const abandoning: RcsCommitWriter = {
      ...writer,
      storeChat: (c, u, p) => {
        const r = writer.storeChat(c, u, p);
        if (!first) {
          first = c.conversationId;
          void staging.abandon(JOB);
        }
        return r;
      },
    };
    const r = await staging.commit(JOB, USER, ALL, abandoning);
    expect(r).toMatchObject({ chats: 1, stopped: true });
    expect(messageCount()).toBe(1);
  });

  it("perChat runs inside that chat's transaction: a throw there rolls back that chat only", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    staging.stageChat(JOB, USER, chat("conv-b", [msg("b1", "2026-09-21T10:00:00.000Z")]), peopleB, hashB);
    const seen: string[] = [];
    const r = await staging.commit(JOB, USER, ALL, writer, {
      perChat: (c) => {
        seen.push(c.chatHash);
        if (c.chatHash === hashA) throw new Error("coverage write failed");
      },
    });
    expect(seen.sort()).toEqual([hashA, hashB].sort());
    expect(r.chatsFailed).toBe(1);
    expect(messageCount()).toBe(1);
  });

  it("the chat meta the page sent (floor, reached, read time) reaches perChat; the chat's own floor keeps its older texts", async () => {
    const older = "2026-01-20T10:00:00.000Z";
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", older), msg("a2", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    staging.noteChat(JOB, { chatHash: hashA, chatFloorMs: Date.parse("2026-01-10T00:00:00.000Z"), readFloorMs: Date.parse("2026-01-10T00:00:00.000Z"), reachedFloor: true, readAt: "2026-10-01T10:00:00.000Z" });
    // Read again later (the retry pass), not down to its floor this time:
    // "reached" sticks (its messages are staged), the later read time wins.
    staging.noteChat(JOB, { chatHash: hashA, chatFloorMs: null, readFloorMs: null, reachedFloor: false, readAt: "2026-10-01T11:00:00.000Z" });
    const metas: unknown[] = [];
    await staging.commit(JOB, USER, { floorMs: Date.parse("2026-08-01T00:00:00.000Z"), cap: null, protectedSpans: [] }, writer, {
      perChat: (c) => void metas.push(c.meta),
    });
    expect(metas).toEqual([{
      chatHash: hashA, chatFloorMs: Date.parse("2026-01-10T00:00:00.000Z"), readFloorMs: Date.parse("2026-01-10T00:00:00.000Z"),
      reachedFloor: true, readAt: "2026-10-01T11:00:00.000Z",
    }]);
    expect(messageCount()).toBe(2);
  });

  it("a discard returns the staging rows it deleted (for the cancel log line)", async () => {
    staging.stageChat(JOB, USER, chat("conv-c", [msg("c1", "2026-09-01T10:00:00.000Z"), msg("c2", "2026-09-02T10:00:00.000Z")]), peopleA, hashA);
    expect(await staging.discard(JOB)).toBe(3); // 1 chat + 2 messages
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

  it("a sweep never touches a commit in progress (B1a)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    staging.stageChat("stale-job", USER, chat("conv-b", [msg("b1", "2026-09-21T10:00:00.000Z")]), peopleB, hashB);
    await staging.stageImage("stale-job", { conversationId: "conv-b", msgId: "b1", index: 0, mimeType: "image/png", base64: PNG }, hashB);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let moving: () => void = () => undefined;
    const atMove = new Promise<void>((r) => {
      moving = r;
    });
    const realMove = files.move;
    files.move = async (from, to) => {
      moving();
      await gate;
      await realMove(from, to);
    };
    staging = new RcsCacheStaging(rcsStagingDbOps(), files);
    const committed = staging.commit(JOB, USER, ALL, writer);
    await atMove;
    expect(staging.isCommitting).toBe(true);
    await staging.discardAll(); // e.g. a new Sync starting now
    release();
    await expect(committed).resolves.toMatchObject({ stored: 1, imagesStored: 1 });
    expect(messageCount()).toBe(1);
    expect(listFiles(files.attachmentsDir)).toHaveLength(1);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_staging_messages WHERE job_id = 'stale-job'")).toBe(0);
    expect(staging.isCommitting).toBe(false);
  });

  it("an abandoned commit no longer counts as in progress; its staging goes (T1)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    let moving: () => void = () => undefined;
    const atMove = new Promise<void>((r) => {
      moving = r;
    });
    files.move = async () => {
      moving();
      await new Promise<void>(() => undefined); // never settles
    };
    staging = new RcsCacheStaging(rcsStagingDbOps(), files);
    void staging.commit(JOB, USER, ALL, writer);
    await atMove;
    expect(staging.isCommitting).toBe(true);
    await staging.abandon(JOB);
    expect(staging.isCommitting).toBe(false);
    expect(stagedCount()).toBe(0);
    expect(messageCount()).toBe(0);
  });

  it("a slow commit abandoned meanwhile writes nothing and leaves no file (T2)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let moving: () => void = () => undefined;
    const atMove = new Promise<void>((r) => {
      moving = r;
    });
    // The move does not need the staged file (abandon() drops it), so the
    // commit really reaches its transaction check.
    files.move = async (_from, to) => {
      moving();
      await gate;
      fs.writeFileSync(to, "x");
    };
    staging = new RcsCacheStaging(rcsStagingDbOps(), files);
    const committed = staging.commit(JOB, USER, ALL, writer);
    await atMove;
    await staging.abandon(JOB); // the save timeout fired
    release(); // ...and the slow move finishes after all
    // 3671 P3: the save timeout stops further chats; nothing of this one was written.
    expect((await committed).stopped).toBe(true);
    expect(messageCount()).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    expect(listFiles(files.attachmentsDir)).toEqual([]);
  });

  it("a failed commit keeps a file another row now uses (B1b)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    const realMove = files.move;
    files.move = async (from, to) => {
      await realMove(from, to);
      // Meanwhile another import attached the same content-addressed file.
      db.prepare("INSERT INTO messages (id, user_id, channel, external_id, direction, sent_at) VALUES ('other', ?, 'sms', 'other-1', 'inbound', '2026-09-01T00:00:00Z')").run(USER);
      db.prepare("INSERT INTO attachments (id, message_id, filename, storage_path) VALUES ('att-other', 'other', 'IMG.png', ?)").run(to);
    };
    staging = new RcsCacheStaging(rcsStagingDbOps(), files);
    const failing: RcsCommitWriter = { ...writer, storeChat: () => { throw new Error("disk I/O error"); } };
    expect((await staging.commit(JOB, USER, ALL, failing)).chatsFailed).toBe(1);
    expect(listFiles(files.attachmentsDir)).toHaveLength(1);
  });

  it("journaled before the move; the journal is cleared with the commit (S2a, S2b)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    await staging.stageImage(JOB, { conversationId: "conv-a", msgId: "a1", index: 0, mimeType: "image/png", base64: PNG }, hashA);
    const journaledAtMove: number[] = [];
    const realMove = files.move;
    files.move = async (from, to) => {
      journaledAtMove.push(count("SELECT COUNT(*) AS n FROM rcs_cache_placed_files WHERE path = ?", to));
      await realMove(from, to);
    };
    staging = new RcsCacheStaging(rcsStagingDbOps(), files);
    await staging.commit(JOB, USER, ALL, writer);
    expect(journaledAtMove).toEqual([1]);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_placed_files")).toBe(0);
  });

  it("a crashed commit's files are recovered: unreferenced deleted, referenced kept (S2c)", async () => {
    fs.mkdirSync(files.attachmentsDir, { recursive: true });
    const orphan = nodePath.join(files.attachmentsDir, "aaaa.png");
    const used = nodePath.join(files.attachmentsDir, "bbbb.png");
    fs.writeFileSync(orphan, "x");
    fs.writeFileSync(used, "y");
    db.prepare("INSERT INTO rcs_cache_placed_files (path, job_id) VALUES (?, 'crashed'), (?, 'crashed')").run(orphan, used);
    db.prepare("INSERT INTO messages (id, user_id, channel, external_id, direction, sent_at) VALUES ('m-ip', ?, 'sms', 'ip-1', 'inbound', '2026-09-01T00:00:00Z')").run(USER);
    db.prepare("INSERT INTO attachments (id, message_id, filename, storage_path) VALUES ('att-ip', 'm-ip', 'IMG.png', ?)").run(used);
    await staging.discardAll(); // the next Sync's sweep
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(used)).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM rcs_cache_placed_files")).toBe(0);
  });

  // BACKLOG-3663: the coverage is written in the commit's OWN transaction.
  // Mutation: the hook called after the transaction → red (a failure would
  // leave coverage without the texts).
  // 3671 P3: the run's records come after every chat, in their own
  // transaction; a failure there keeps the chats and is reported (the next
  // run is "Try again"). Mutation: thrown out of the commit → red.
  it("the run-level step runs after the chats; a throw there keeps the chats and is reported (V10)", async () => {
    staging.stageChat(JOB, USER, chat("conv-a", [msg("a1", "2026-09-20T10:00:00.000Z")]), peopleA, hashA);
    const seen: number[] = [];
    const r = await staging.commit(JOB, USER, ALL, writer, (out) => {
      seen.push(messageCount(), out.stored);
      throw new Error("coverage write failed");
    });
    expect(seen).toEqual([1, 1]);
    expect(r.runRecordFailed).toBe(true);
    expect(messageCount()).toBe(1);
  });

  it("schema.sql runs twice (CREATE ... IF NOT EXISTS) (A11)", () => {
    expect(() => db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"))).not.toThrow();
  });
});
