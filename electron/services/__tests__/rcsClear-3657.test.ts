/**
 * @jest-environment node
 */
/**
 * BACKLOG-3657 — Force re-import also clears the texts imported from Google
 * Messages for Web, against the REAL SQL on the production schema (the same
 * in-memory harness as checklistForceReimport-3475.test.ts).
 *
 * Mutation controls (each turns at least one test red):
 *   C1 a statement not scoped to the user          → "another user's rows are untouched"
 *   C2 reactions counted into message_count        → "message_count drops by the counted links only"
 *   C3 files deleted inside the transaction        → "a failing statement rolls back: no file deleted"
 *   C4 no attachments-folder check                 → "files outside message-attachments are never deleted"
 *   C5 the user's removals deleted                 → "ignored_communications are kept"
 *   C6 thread-level gmweb links not deleted        → "every gmweb link is gone"
 *   C7 delete order changed                        → "the reviewed order"
 *   C8 writes resume only on success               → "writes resume even when the clear throws"
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
import { rcsClearDbOps } from "../db/syncDbService";
import {
  clearGoogleMessagesWebData,
  runWithWritesPaused,
  type RcsClearDbOps,
  type RcsClearFs,
} from "../rcsClearService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3657";
const OTHER = "user-3657-b";
const THREAD = "gmweb-chat-conv3657aaaaaaaaaa";

let db: DatabaseType;
let tmp: string;
let attachmentsRoot: string;
let inside: string;
let outside: string;

const count = (q: string, ...p: unknown[]): number => (db.prepare(q).get(...p) as { n: number }).n;

function insertMsg(id: string, user: string, externalId: string, meta: Record<string, unknown>, opts: { thread?: string; reaction?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at, metadata,
       associated_message_type, associated_message_guid)
     VALUES (?, ?, 'sms', ?, 'inbound', 'x', '{"from":"Test Contact A","to":["me"]}', ?, '2026-09-20T13:05:00.000Z', ?, ?, ?)`,
  ).run(id, user, externalId, opts.thread ?? THREAD, JSON.stringify(meta), opts.reaction ? 2001 : null, opts.reaction ? "gmweb:x:1" : null);
}

function link(id: string, user: string, tx: string, messageId: string | null, thread?: string): void {
  db.prepare("INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id) VALUES (?, ?, ?, ?, ?)").run(
    id, user, tx, messageId, thread ?? null,
  );
}

function fsOps(): RcsClearFs {
  return {
    attachmentsRoot,
    resolve: (p) => (nodePath.isAbsolute(p) ? p : nodePath.join(tmp, p)),
    deleteFile: (abs) => {
      try {
        fs.unlinkSync(abs);
        return true;
      } catch {
        return false;
      }
    },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rcs-clear-3657-"));
  attachmentsRoot = nodePath.join(tmp, "message-attachments");
  fs.mkdirSync(attachmentsRoot);
  inside = nodePath.join(attachmentsRoot, "gmweb-1-0.png");
  outside = nodePath.join(tmp, "elsewhere.png");
  fs.writeFileSync(inside, "x");
  fs.writeFileSync(outside, "x");

  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [u, n] of [[USER, "a"], [OTHER, "b"]]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      u, `agent-3657-${n}@example.test`, `oauth-3657-${n}`,
    );
  }
  db.prepare("INSERT INTO transactions (id, user_id, property_address, message_count) VALUES ('tx-a', ?, '1 Test Street', 10)").run(USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address, message_count) VALUES ('tx-b', ?, '2 Test Street', 4)").run(OTHER);

  const gm = { source: "google_messages_web" };
  insertMsg("m1", USER, "gmweb:conv3657aaaaaaaaaa:1", gm);
  insertMsg("m2", USER, "gmweb:conv3657aaaaaaaaaa:2", gm);
  insertMsg("r1", USER, "gmweb:conv3657aaaaaaaaaa:1:react", gm, { reaction: true });
  insertMsg("android", USER, "android-1", { source: "android_wifi_sync" }, { thread: "android-thread" });
  insertMsg("b1", OTHER, "gmweb:conv3657bbbbbbbbbb:1", gm, { thread: "gmweb-chat-conv3657bbbbbbbbbb" });

  link("c-m1", USER, "tx-a", "m1");
  link("c-m2", USER, "tx-a", "m2");
  link("c-r1", USER, "tx-a", "r1");
  link("c-thread", USER, "tx-a", null, THREAD);
  link("c-android", USER, "tx-a", "android");
  link("c-b1", OTHER, "tx-b", "b1");
  link("c-b-thread", OTHER, "tx-b", null, "gmweb-chat-conv3657bbbbbbbbbb");

  db.prepare("INSERT INTO attachments (id, message_id, filename, storage_path) VALUES ('a-in', 'm1', 'p.png', ?), ('a-out', 'm2', 'q.png', ?)").run(inside, outside);
  db.prepare(
    "INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id, reason) VALUES ('ic-1', ?, 'tx-a', ?, 'Manually unlinked by user')",
  ).run(USER, THREAD);
  setDb(db);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("clearGoogleMessagesWebData on the real schema (BACKLOG-3657)", () => {
  it("deletes the user's gmweb texts, reactions, links and attachments; leaves Android alone", () => {
    const result = clearGoogleMessagesWebData(USER, rcsClearDbOps(), fsOps());
    expect(result).toMatchObject({ messagesDeleted: 3, attachmentsDeleted: 2, transactionsUpdated: 1 });
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND external_id LIKE 'gmweb:%'", USER)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id = 'android'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM communications WHERE id = 'c-android'")).toBe(1);
  });

  it("every gmweb link is gone — per message and thread-level (C6)", () => {
    clearGoogleMessagesWebData(USER, rcsClearDbOps(), fsOps());
    expect(count("SELECT COUNT(*) AS n FROM communications WHERE user_id = ? AND id != 'c-android'", USER)).toBe(0);
  });

  it("message_count drops by the counted links only — reactions were never counted (C2)", () => {
    clearGoogleMessagesWebData(USER, rcsClearDbOps(), fsOps());
    expect(count("SELECT message_count AS n FROM transactions WHERE id = 'tx-a'")).toBe(8);
  });

  it("another user's rows are untouched (C1)", () => {
    clearGoogleMessagesWebData(USER, rcsClearDbOps(), fsOps());
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", OTHER)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM communications WHERE user_id = ?", OTHER)).toBe(2);
    expect(count("SELECT message_count AS n FROM transactions WHERE id = 'tx-b'")).toBe(4);
  });

  it("ignored_communications are kept — the user's removals stay (C5)", () => {
    clearGoogleMessagesWebData(USER, rcsClearDbOps(), fsOps());
    expect(count("SELECT COUNT(*) AS n FROM ignored_communications WHERE id = 'ic-1'")).toBe(1);
  });

  it("files are deleted after the commit, and never outside message-attachments (C4)", () => {
    const result = clearGoogleMessagesWebData(USER, rcsClearDbOps(), fsOps());
    expect(fs.existsSync(inside)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(result.filesDeleted).toBe(1);
  });

  it("a failing statement rolls back: no file deleted, rows and counts unchanged (C3)", () => {
    const real = rcsClearDbOps();
    const failing: RcsClearDbOps = {
      ...real,
      deleteMessages: () => {
        throw new Error("disk I/O error");
      },
    };
    expect(() => clearGoogleMessagesWebData(USER, failing, fsOps())).toThrow("disk I/O error");
    expect(fs.existsSync(inside)).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM attachments")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM communications WHERE user_id = ?", USER)).toBe(5);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", USER)).toBe(4);
    expect(count("SELECT message_count AS n FROM transactions WHERE id = 'tx-a'")).toBe(10);
  });
});

describe("order and the write gate (fakes)", () => {
  it("the reviewed order: read, attachments, links (message, thread), messages, then counts; files last (C7)", () => {
    const order: string[] = [];
    const ops: RcsClearDbOps = {
      inTransaction: (fn) => {
        order.push("begin");
        const r = fn();
        order.push("commit");
        return r;
      },
      attachmentPaths: () => (order.push("read paths"), ["message-attachments/x.png"]),
      countedLinks: () => (order.push("read counts"), [{ transactionId: "tx-a", counted: 2 }]),
      messageCount: () => 3,
      deleteAttachments: () => (order.push("attachments"), 1),
      deleteMessageLinks: () => (order.push("message links"), 2),
      deleteThreadLinks: () => (order.push("thread links"), 1),
      deleteMessages: () => (order.push("messages"), 2),
      setMessageCount: (_u, _t, n) => {
        order.push(`count=${n}`);
      },
    };
    clearGoogleMessagesWebData(USER, ops, {
      attachmentsRoot: "/data/message-attachments",
      resolve: (p) => nodePath.join("/data", p),
      deleteFile: () => (order.push("file"), true),
    });
    expect(order).toEqual([
      "begin", "read paths", "read counts", "attachments", "message links", "thread links", "messages", "count=1", "commit", "file",
    ]);
  });

  it("writes are paused before the clear and resume after it — even when the clear throws (C8)", async () => {
    const order: string[] = [];
    const gate = {
      pauseWrites: async () => {
        order.push("pause");
      },
      resumeWrites: () => {
        order.push("resume");
      },
    };
    await expect(runWithWritesPaused(gate, () => (order.push("clear"), 1))).resolves.toBe(1);
    await expect(runWithWritesPaused(gate, () => {
      order.push("clear");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(order).toEqual(["pause", "clear", "resume", "pause", "clear", "resume"]);
  });
});
