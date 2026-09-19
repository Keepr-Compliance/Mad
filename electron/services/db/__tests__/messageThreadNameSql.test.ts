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
  deleteThreadNamesByIdsSync,
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

  it("width 0 — answered without touching the database", async () => {
    // `IN ()` is valid SQLite that matches nothing, so building one would
    // delete nothing by accident rather than by design.
    const spy = { prepare: jest.fn() };
    await expect(deleteThreadNamesByIds(spy as never, USER, [])).resolves.toBe(0);
    expect(spy.prepare).not.toHaveBeenCalled();
  });

  it("width 1, 2 and N remove exactly the named ids", async () => {
    await expect(deleteThreadNamesByIds(db as never, USER, ["macos-chat-1"])).resolves.toBe(1);
    expect(idsFor(USER)).toEqual(["macos-chat-2", "macos-chat-3", "macos-chat-4"]);

    await expect(
      deleteThreadNamesByIds(db as never, USER, ["macos-chat-2", "macos-chat-3"]),
    ).resolves.toBe(2);
    expect(idsFor(USER)).toEqual(["macos-chat-4"]);
  });

  it("is scoped to the user, so a shared thread id is not collateral", async () => {
    await deleteThreadNamesByIds(db as never, USER, ["macos-chat-1"]);
    expect(idsFor(OTHER)).toEqual(["macos-chat-1"]);
  });

  it("ignores ids that are not present rather than failing", async () => {
    await expect(
      deleteThreadNamesByIds(db as never, USER, ["macos-chat-1", "nope"]),
    ).resolves.toBe(1);
    expect(idsFor(USER)).toEqual(["macos-chat-2", "macos-chat-3", "macos-chat-4"]);
  });
});

/**
 * BACKLOG-2960 — the twin, and the one property that decides its shape.
 *
 * The seam export above is promise-returning. Its only production caller lives
 * inside the `db.transaction(...)` body `syncMacChatThreadNames` opens, and
 * `better-sqlite3` commits when that callback RETURNS — so that call site uses
 * `deleteThreadNamesByIdsSync` and the wrapper exists for everyone else.
 *
 * The rollback test below is the reason the wrapper is a PLAIN function rather
 * than an `async` one, executed rather than asserted in prose. It deliberately
 * makes the wrong call — floating the promise-returning wrapper inside a
 * synchronous body — and shows that even then the enclosing transaction still
 * rolls back, because a plain `Promise.resolve(...)` over a synchronous
 * primitive does all its work, INCLUDING ITS THROW, before the promise exists.
 * Make the wrapper `async` and this test does NOT report `INSIDE-TX`. That was
 * measured, not assumed: the test floats the wrapper with `void`, so under an
 * `async` wrapper the rejection is unhandled — the jest worker dies on an
 * unhandled `SqliteError` from the driver, and the run prints no `Tests:` line
 * and no assertion output at all. Someone who follows that instruction sees a
 * crash and learns nothing about commit-vs-rollback. The contrast itself is
 * real, and is stated in the seam module's docblock: it was measured on this
 * module in PR #2546 with a probe that attaches a `.catch` to the floated call,
 * and on `llmSettingsDbService` in the #2544 SR review. But THIS test is not
 * the instrument that demonstrates it.
 *
 * The forced failure is a real driver error at a real boundary, not a stub:
 * SQLite's parameter limit is 32,766 (measured on this build — 32,766 binds
 * succeed, 32,767 raise `SQLITE_ERROR: too many SQL variables`), which is
 * exactly the hazard `syncMacChatThreadNames`' `CHUNK = 400` exists to avoid.
 *
 * Table state is asserted, never the error object. `SqliteError` has no
 * `[[ErrorData]]` slot, so every `.rejects.*` matcher — including the message
 * and regex forms — dies in jest's `isError` before it compares anything
 * (BACKLOG-3152). Nothing here goes near that path.
 */
describe("deleteThreadNamesByIdsSync — the synchronous twin the transaction body calls", () => {
  const SQLITE_MAX_VARIABLES = 32766;

  beforeEach(() => {
    for (let i = 1; i <= 4; i++) name(USER, `macos-chat-${i}`, `Thread ${i}`);
    name(OTHER, "macos-chat-1", "Another user");
  });

  it("removes the same rows and returns the same count as the promise wrapper", async () => {
    // Parity by execution over both widths that matter, as ID SETS rather than
    // counts: the wrapper must be a pass-through, not a second implementation.
    expect(deleteThreadNamesByIdsSync(db as never, USER, [])).toBe(0);
    expect(deleteThreadNamesByIdsSync(db as never, USER, ["macos-chat-1"])).toBe(1);
    expect(idsFor(USER)).toEqual(["macos-chat-2", "macos-chat-3", "macos-chat-4"]);

    await expect(deleteThreadNamesByIds(db as never, USER, ["macos-chat-2"])).resolves.toBe(1);
    expect(idsFor(USER)).toEqual(["macos-chat-3", "macos-chat-4"]);
    expect(idsFor(OTHER)).toEqual(["macos-chat-1"]);
  });

  it("a driver throw inside a transaction body rolls that body's own write back", () => {
    const displayName = (threadId: string): string | undefined =>
      (
        db
          .prepare("SELECT display_name FROM message_thread_names WHERE user_id = ? AND thread_id = ?")
          .get(USER, threadId) as { display_name: string } | undefined
      )?.display_name;

    expect(displayName("macos-chat-1")).toBe("Thread 1");

    // Over the limit by one, so the driver refuses the statement.
    const tooMany = Array.from({ length: SQLITE_MAX_VARIABLES + 1 }, (_, i) => `macos-chat-absent-${i}`);

    const body = db.transaction((): void => {
      db.prepare(
        "UPDATE message_thread_names SET display_name = ? WHERE user_id = ? AND thread_id = ?",
      ).run("INSIDE-TX", USER, "macos-chat-1");

      // Deliberately the WRONG call for this position — the promise-returning
      // wrapper, floated. The point is that it still throws synchronously.
      void deleteThreadNamesByIds(db as never, USER, tooMany);
    });

    let threw = false;
    try {
      body();
    } catch {
      threw = true;
    }

    // Both facts in one assertion, so a failure prints BOTH: whether the
    // transaction saw the error at all, and what the row holds afterwards. The
    // second is the one that matters — not that it threw, but that the write the
    // body had already made is gone. With the wrapper made `async` this reads
    // `{ threw: false, after: "INSIDE-TX" }`: the transaction committed over the
    // error and the failure arrived later as a rejection.
    expect({ threw, after: displayName("macos-chat-1") }).toEqual({
      threw: true,
      after: "Thread 1",
    });
  });
});
