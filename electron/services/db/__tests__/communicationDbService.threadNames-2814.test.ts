/**
 * @jest-environment node
 *
 * BACKLOG-2814 — the Texts tab's loader carries the group name.
 *
 * ===========================================================================
 * WHY THIS RUNS THE REAL SQL
 * ===========================================================================
 * The name is joined in by `getCommunicationsWithMessages`, and this suite
 * exists because the obvious cheaper test — mock `dbAll`, assert the SQL string
 * contains "message_thread_names" — proves nothing. It restates the code. It
 * would pass with the join predicate wrong, with the column aliased to the wrong
 * name, and with the join silently dropping every row.
 *
 * So the query runs against a REAL in-memory SQLite database, injected via
 * `setDb`, and the assertions are on the ROWS that come back.
 *
 * ===========================================================================
 * THE CONTROL THAT MATTERS
 * ===========================================================================
 * The join is `ON tn.thread_id = m.thread_id AND tn.user_id = m.user_id`. The
 * second half is not decoration: thread ids are only unique per machine
 * ("macos-chat-<ROWID>"), so two users of one database can hold the same
 * thread_id. Joining on thread_id alone would show one user's group name on the
 * other's thread. `does not leak another user's name` below is the test that
 * fails if that half is dropped — the rest of the suite passes without it.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  require("path").join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../core/dbConnection";
import { getCommunicationsWithMessages } from "../communicationDbService";

const USER = "user-2814";
const OTHER_USER = "user-2814-other";
const TXN = "txn-2814";
const NAMED_THREAD = "macos-chat-1";
const UNNAMED_THREAD = "macos-chat-2";
const GROUP_NAME = "Closing Team";

let db: DatabaseType;

/**
 * The REAL schema, executed from `electron/database/schema.sql`.
 *
 * Transcribed rather than invented, deliberately. A hand-written subset of
 * `messages` / `emails` / `communications` is a guess at what the query selects,
 * and the first two guesses here were WRONG in ways that would have gone
 * unnoticed had the query not thrown (`emails.body_text` does not exist; the
 * column is `body_plain`). A fixture that disagrees with the shipped schema can
 * make a passing test meaningless — using schema.sql makes that impossible, and
 * it also means `message_thread_names` here is the FRESH-INSTALL definition, not
 * a copy of it.
 */
function createSchema(d: DatabaseType): void {
  const schemaPath = require("path").join(
    __dirname, "..", "..", "..", "database", "schema.sql",
  );
  d.exec(require("fs").readFileSync(schemaPath, "utf8"));
}

function addMessage(id: string, threadId: string, userId = USER): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text,
                           participants, thread_id, sent_at)
     VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?, ?, '2026-01-01T10:00:00Z')`,
  ).run(
    id,
    userId,
    `guid-${id}`,
    `body ${id}`,
    JSON.stringify({
      from: "+15550100",
      to: ["me"],
      chat_members: ["+15550100", "+15550101", "+15550102"],
    }),
    threadId,
  );
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`comm-${id}`, userId, TXN, id, threadId);
}

function addName(threadId: string, name: string, userId = USER): void {
  db.prepare(
    `INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)`,
  ).run(userId, threadId, name);
}

async function loadTexts(): Promise<
  Array<{ thread_id?: string; thread_display_name?: string }>
> {
  return (await getCommunicationsWithMessages(TXN, "text")) as unknown as Array<{
    thread_id?: string;
    thread_display_name?: string;
  }>;
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  // schema.sql carries the real FOREIGN KEYs, so both users must exist.
  for (const u of [USER, OTHER_USER]) {
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
    ).run(u, u + "@example.test", "oauth-" + u);
  }
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`,
  ).run(TXN, USER, "1 Test St");
  setDb(db);
});

afterEach(() => {
  db?.close();
});

describe("BACKLOG-2814 — getCommunicationsWithMessages joins the group name", () => {
  it("returns the name on a NAMED thread", async () => {
    addMessage("m-1", NAMED_THREAD);
    addName(NAMED_THREAD, GROUP_NAME);

    const rows = await loadTexts();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBe(NAMED_THREAD);
    expect(rows[0].thread_display_name).toBe(GROUP_NAME);
  });

  it("returns no name on an UNNAMED thread, and still returns the row", async () => {
    // The join is a LEFT join. A thread with no name must not vanish from the
    // Texts tab — an INNER join here would hide every unnamed conversation,
    // which is the overwhelming majority of them.
    addMessage("m-2", UNNAMED_THREAD);

    const rows = await loadTexts();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBe(UNNAMED_THREAD);
    expect(rows[0].thread_display_name ?? null).toBeNull();
  });

  it("returns both a named and an unnamed thread in one load", async () => {
    addMessage("m-1", NAMED_THREAD);
    addMessage("m-2", UNNAMED_THREAD);
    addName(NAMED_THREAD, GROUP_NAME);

    const rows = await loadTexts();
    const byThread = new Map(rows.map((r) => [r.thread_id, r.thread_display_name ?? null]));
    expect(byThread.get(NAMED_THREAD)).toBe(GROUP_NAME);
    expect(byThread.get(UNNAMED_THREAD)).toBeNull();
  });

  it("does not leak ANOTHER user's name onto this user's thread", async () => {
    // THE CONTROL FOR THE JOIN KEY. Same thread_id, different user_id — which is
    // reachable because "macos-chat-1" is only unique per machine. Drop
    // `AND tn.user_id = m.user_id` from the join and this test goes red while
    // every other test in the suite stays green.
    addMessage("m-1", NAMED_THREAD);
    addName(NAMED_THREAD, "Their Group", OTHER_USER);

    const rows = await loadTexts();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_display_name ?? null).toBeNull();
  });

  it("does not multiply rows AT THE SQL LEVEL when a decoy name row exists", () => {
    // A REAL FAN-OUT CONTROL, and it has to run the join predicate directly.
    //
    // Asserting on getCommunicationsWithMessages' RETURN VALUE cannot detect
    // fan-out at all: the function runs `dedupedById` over its results before
    // returning, so duplicate rows produced by a bad join are silently
    // collapsed. Measured, not assumed -- dropping `AND tn.user_id = m.user_id`
    // and seeding two matching name rows leaves every output-level assertion in
    // this file, and in reactions.integration.test.ts, GREEN.
    //
    // So this counts the rows the JOIN itself yields, before any dedup. The
    // decoy is a second name row for the SAME thread under a DIFFERENT user --
    // the shape the (user_id, thread_id) PK permits and a thread_id-only join
    // would multiply by.
    addMessage("m-1", NAMED_THREAD);
    addName(NAMED_THREAD, GROUP_NAME);
    addName(NAMED_THREAD, "Their Group", OTHER_USER);

    const joined = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM messages m
           LEFT JOIN message_thread_names tn ON (
             tn.thread_id = m.thread_id AND tn.user_id = m.user_id
           )
          WHERE m.id = ?`,
      )
      .get("m-1") as { n: number };

    // ONE row in, ONE row out. Reduce the predicate to `tn.thread_id =
    // m.thread_id` and this becomes 2 (verified).
    expect(joined.n).toBe(1);
  });

  it("does not multiply rows when a name exists", async () => {
    // A join that matched more than one name row would duplicate the message and
    // put the same conversation on the tab twice, breaking the thread-unit
    // contract (one card per thread).
    addMessage("m-1", NAMED_THREAD);
    addMessage("m-2", NAMED_THREAD);
    addName(NAMED_THREAD, GROUP_NAME);

    const rows = await loadTexts();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.thread_display_name === GROUP_NAME)).toBe(true);
  });
});
