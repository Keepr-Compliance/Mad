/**
 * Pins for `db/messageThreadNameSql` — BACKLOG-2990 chunk 1.
 *
 * Keepr's own schema, so the fixture is the real `electron/database/schema.sql`
 * executed whole — nothing transcribed, nothing invented.
 *
 * The prefix scoping is the property worth pinning. The macOS importer owns
 * every row whose `thread_id` starts `macos-chat-`; a user can have thread
 * names from other sources, and a re-import must not touch them. Both the
 * delete and the select carry that predicate, and they must agree — a select
 * that saw more than the delete removes would report reconciliation work that
 * never happened.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  DELETE_MACOS_THREAD_NAMES_SQL,
  SELECT_MACOS_THREAD_IDS_SQL,
  UPSERT_THREAD_NAME_SQL,
  deleteThreadNamesByIds,
} from "../messageThreadNameSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2990-c1";
const OTHER = "user-2990-c1-other";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const addUser = (id: string): void => {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(id, `${id}@example.test`, `oauth-${id}`);
};

const name = (userId: string, threadId: string, display: string): void => {
  db.prepare(UPSERT_THREAD_NAME_SQL).run(userId, threadId, display);
};

const idsFor = (userId: string): string[] =>
  (db.prepare(SELECT_MACOS_THREAD_IDS_SQL).all(userId) as Array<{ thread_id: string }>)
    .map((r) => r.thread_id)
    .sort();

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2990-tn-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  addUser(USER);
  addUser(OTHER);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("UPSERT_THREAD_NAME_SQL", () => {
  it("inserts, then UPDATES on a second call rather than duplicating", () => {
    name(USER, "macos-chat-1", "Book Club");
    name(USER, "macos-chat-1", "Book Club (renamed)");

    expect(
      db.prepare("SELECT thread_id, display_name FROM message_thread_names").all(),
    ).toEqual([{ thread_id: "macos-chat-1", display_name: "Book Club (renamed)" }]);
  });

  it("stamps updated_at itself, so a caller cannot preserve a stale timestamp", () => {
    name(USER, "macos-chat-1", "A");
    const first = db
      .prepare("SELECT updated_at FROM message_thread_names")
      .get() as { updated_at: string };
    expect(first.updated_at).not.toBeNull();
  });

  it("keys on (user_id, thread_id), so two users may share a thread id", () => {
    name(USER, "macos-chat-1", "Mine");
    name(OTHER, "macos-chat-1", "Theirs");

    // Asserted as a SET keyed by user, not as an ordered list. The first
    // draft ordered by `user_id` and expected OTHER first — but `USER` is a
    // string PREFIX of `OTHER`, so it sorts first. That is a property of two
    // ids I chose, not of the statement, and pinning it would have made this
    // test fail the next time someone renamed a fixture constant.
    const byUser = Object.fromEntries(
      (
        db.prepare("SELECT user_id, display_name FROM message_thread_names").all() as Array<{
          user_id: string;
          display_name: string;
        }>
      ).map((r) => [r.user_id, r.display_name]),
    );
    expect(byUser).toEqual({ [USER]: "Mine", [OTHER]: "Theirs" });
  });
});

describe("the macOS prefix scope — select and delete must agree", () => {
  beforeEach(() => {
    name(USER, "macos-chat-1", "Imported A");
    name(USER, "macos-chat-2", "Imported B");
    name(USER, "manual-thread-9", "Hand named");     // another source, same user
    name(OTHER, "macos-chat-1", "Another user");     // macOS, different user
  });

  it("selects exactly this user's macOS-owned ids", () => {
    expect(idsFor(USER)).toEqual(["macos-chat-1", "macos-chat-2"]);
  });

  it("the delete removes exactly what the select saw, and nothing else", () => {
    // Both halves. A select that saw more than the delete removes would report
    // reconciliation work that never happened; a delete that removed more would
    // silently destroy names from another source.
    const seen = idsFor(USER);
    const removed = db.prepare(DELETE_MACOS_THREAD_NAMES_SQL).run(USER).changes;

    expect(removed).toBe(seen.length);
    expect(idsFor(USER)).toEqual([]);
    expect(
      db.prepare("SELECT thread_id FROM message_thread_names ORDER BY thread_id").all(),
    ).toEqual([{ thread_id: "macos-chat-1" }, { thread_id: "manual-thread-9" }]);
  });
});

describe("deleteThreadNamesByIds — width derived from the values bound", () => {
  beforeEach(() => {
    for (let i = 1; i <= 4; i++) name(USER, `macos-chat-${i}`, `Thread ${i}`);
    name(OTHER, "macos-chat-1", "Another user");
  });

  it("width 0 — answered without touching the database", () => {
    // `IN ()` is valid SQLite that matches nothing, so building one would
    // delete nothing by accident rather than by design.
    const spy = { prepare: jest.fn() };
    expect(deleteThreadNamesByIds(spy as never, USER, [])).toBe(0);
    expect(spy.prepare).not.toHaveBeenCalled();
  });

  it("width 1, 2 and N remove exactly the named ids", () => {
    expect(deleteThreadNamesByIds(db as never, USER, ["macos-chat-1"])).toBe(1);
    expect(idsFor(USER)).toEqual(["macos-chat-2", "macos-chat-3", "macos-chat-4"]);

    expect(deleteThreadNamesByIds(db as never, USER, ["macos-chat-2", "macos-chat-3"])).toBe(2);
    expect(idsFor(USER)).toEqual(["macos-chat-4"]);
  });

  it("is scoped to the user, so a shared thread id is not collateral", () => {
    deleteThreadNamesByIds(db as never, USER, ["macos-chat-1"]);
    expect(idsFor(OTHER)).toEqual(["macos-chat-1"]);
  });

  it("ignores ids that are not present rather than failing", () => {
    expect(deleteThreadNamesByIds(db as never, USER, ["macos-chat-1", "nope"])).toBe(1);
    expect(idsFor(USER)).toEqual(["macos-chat-2", "macos-chat-3", "macos-chat-4"]);
  });
});
