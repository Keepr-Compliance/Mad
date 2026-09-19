/**
 * @jest-environment node
 *
 * `syncMacChatThreadNames` reconciliation counts — BACKLOG-2960 wave 1 lane A.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS: A BLIND SPOT, FOUND BEFORE IT WAS NEEDED
 * ===========================================================================
 * `syncMacChatThreadNames` returns `{ named, cleared }`. At `int/epic9-close`
 * `116601c1b` NOTHING in the tree asserted either number: the three real-driver
 * thread-name suites assert stored rows only, and the sole production consumer
 * (`macOSMessagesImportService.ts`) writes them to a log line and discards them.
 *
 * That matters for the conversion this PR performs. The natural defect —
 * calling the promise-returning `deleteThreadNamesByIds` from inside the
 * `db.transaction` body instead of `deleteThreadNamesByIdsSync` — still DELETES
 * THE ROWS, because the wrapper is a plain function whose work is synchronous.
 * The only observable damage is that `cleared` becomes a `Promise` rather than a
 * count. With no assertion on it, the row-level suites stay green, `tsc` is
 * silent on the `void`-ed form, and `no-floating-promises` ignores it. A green
 * signal that cannot separate pass from fail is not a signal (PR-SOP §6.2c), so
 * the assertion is added FIRST and the defect is then shown red against it.
 *
 * ===========================================================================
 * THE FIXTURE
 * ===========================================================================
 * The real driver against the real `electron/database/schema.sql`, executed
 * whole — nothing transcribed, nothing invented. `message_thread_names` has a
 * foreign key to `users_local`, so the users are inserted rather than assumed.
 *
 * Both delete branches are covered, because they are different statements:
 *   - `keep.length === 0` takes `DELETE_MACOS_THREAD_NAMES_SQL` (one bind);
 *   - `keep.length > 0` collects the doomed ids and takes the chunked
 *     `deleteThreadNamesByIdsSync` path, which is the one this PR converts.
 *
 * Names are asserted as SETS of `thread_id`, never as counts alone: a count can
 * be right while the wrong row was removed.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  UPSERT_THREAD_NAME_SQL,
  SELECT_MACOS_THREAD_IDS_SQL,
} from "../db/messageThreadNameSql";
import {
  macChatThreadId,
  syncMacChatThreadNames,
} from "../macOSMessagesImportService/importHelpers";

const SCHEMA = path.join(__dirname, "..", "..", "database", "schema.sql");
// Neither id is a PREFIX of the other, so `ORDER BY user_id` below is plain
// alphabetical and not a property of how the two constants happen to nest. The
// sibling suite (`db/__tests__/messageThreadNameSql.test.ts`) records the run
// where that went wrong.
const USER = "user-2960-a2-alpha";
const OTHER = "user-2960-a2-beta";

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

const macosIdsFor = (userId: string): string[] =>
  (db.prepare(SELECT_MACOS_THREAD_IDS_SQL).all(userId) as Array<{ thread_id: string }>)
    .map((r) => r.thread_id)
    .sort();

const allRows = (): Array<{ user_id: string; thread_id: string; display_name: string }> =>
  db
    .prepare(
      "SELECT user_id, thread_id, display_name FROM message_thread_names ORDER BY user_id, thread_id",
    )
    .all() as Array<{ user_id: string; thread_id: string; display_name: string }>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2960-a2-"));
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

describe("syncMacChatThreadNames reports what it actually did (BACKLOG-2960)", () => {
  it("counts every name written, and clears nothing on a first run", () => {
    const counts = syncMacChatThreadNames(
      db as never,
      USER,
      new Map([
        [1, "Closing Team"],
        [2, "Book Club"],
      ]),
    );

    expect(counts).toEqual({ named: 2, cleared: 0 });
    expect(macosIdsFor(USER)).toEqual(["macos-chat-1", "macos-chat-2"]);
  });

  it("counts the rows the CHUNKED delete removed — the statement this conversion touches", () => {
    // Three macOS threads exist; the next run names only one of them, so two are
    // doomed and go through `deleteThreadNamesByIdsSync`. A row of the same user
    // from another source, and a macOS row of a different user, must survive:
    // the delete is prefix- and user-scoped, and a count alone would not show it.
    name(USER, macChatThreadId(1), "Closing Team");
    name(USER, macChatThreadId(2), "Book Club");
    name(USER, macChatThreadId(3), "Weekend");
    name(USER, "manual-thread-9", "Hand named");
    name(OTHER, macChatThreadId(1), "Another user");

    const counts = syncMacChatThreadNames(
      db as never,
      USER,
      new Map([[1, "Closing Team (renamed)"]]),
    );

    // `cleared` is the assertion the tree did not have. `named` is 1 because the
    // pass names what chat.db still names, not what changed.
    expect(counts).toEqual({ named: 1, cleared: 2 });

    // IDENTITY, not a count: exactly which rows survived, and under which name.
    expect(allRows()).toEqual([
      { user_id: USER, thread_id: "macos-chat-1", display_name: "Closing Team (renamed)" },
      { user_id: USER, thread_id: "manual-thread-9", display_name: "Hand named" },
      { user_id: OTHER, thread_id: "macos-chat-1", display_name: "Another user" },
    ]);
  });

  it("counts the rows the UNCHUNKED delete removed when chat.db names nothing", () => {
    // The other branch: `keep.length === 0` takes DELETE_MACOS_THREAD_NAMES_SQL
    // rather than the chunked path, so the two branches are asserted separately.
    name(USER, macChatThreadId(1), "Closing Team");
    name(USER, macChatThreadId(2), "Book Club");
    name(USER, "manual-thread-9", "Hand named");

    const counts = syncMacChatThreadNames(db as never, USER, new Map());

    expect(counts).toEqual({ named: 0, cleared: 2 });
    expect(allRows()).toEqual([
      { user_id: USER, thread_id: "manual-thread-9", display_name: "Hand named" },
    ]);
  });

  it("reports a plain number, not a promise — the shape a floated seam call would produce", () => {
    // The conversion's own failure mode, pinned by type at runtime. If the
    // transaction body ever calls `deleteThreadNamesByIds` instead of its *Sync
    // twin, the rows still vanish and only this assertion notices.
    name(USER, macChatThreadId(7), "Doomed");

    const counts = syncMacChatThreadNames(db as never, USER, new Map([[8, "Kept"]]));

    expect(typeof counts.cleared).toBe("number");
    expect(typeof counts.named).toBe("number");
    expect(counts).toEqual({ named: 1, cleared: 1 });
  });
});
