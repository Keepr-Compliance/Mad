/**
 * @jest-environment node
 *
 * BACKLOG-2816 — the attach-messages roster carries each contact's group chat
 * names, so the picker's search box has something to match on.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * The renderer half of this change is pinned by
 * `AttachMessagesModal.groupNameSearch-2816.test.tsx`, whose roster fixture
 * declares `threadNames: ["Kingfisher Lane Closing"]`. That fixture stands in
 * for THIS function's output. If `getMessageContacts` did not actually produce
 * the field, the modal suite would still be green and the founder would still
 * not find his group — the fixture would be describing a state the code cannot
 * emit.
 *
 * So this drives the REAL `getMessageContacts` against a REAL database built
 * from the REAL schema.sql, and the modal fixture is a transcription of what it
 * returns.
 *
 * ===========================================================================
 * CONTROLS (run and recorded — see the PR body)
 * ===========================================================================
 * Drop the `threadNames` field from the returned rows -> the first two tests go
 * red. Replace `tn.user_id = m.user_id` with `1=1` in the names query -> the
 * cross-user test goes red.
 *
 * Every group name and handle here is invented for the fixture.
 */

// The default Jest moduleNameMapper rewrites "better-sqlite3-multiple-ciphers"
// to a stub; require the real package via an explicit node_modules path.
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";

jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

import { setDb } from "../core/dbConnection";
import { getMessageContacts } from "../messageDbService";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "database", "schema.sql"),
  "utf8",
);

const USER = "u-2816-roster";
const OTHER_USER = "u-2816-roster-other";

const GROUP_NAME = "Kingfisher Lane Closing";
const SECOND_GROUP_NAME = "Harbor St Walkthrough";

/** Handles, all invented. */
const IN_GROUP_A = "+14155550100";
const IN_GROUP_B = "+14155550101";
const NO_GROUP = "+14155550102";
const SOLO = "+14155550103";
const LEAKED = "+14155550104";

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);

  const insertUser = db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google',?)",
  );
  insertUser.run(USER, "me@example.test", "o-me");
  insertUser.run(OTHER_USER, "them@example.test", "o-them");

  const insertMsg = db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text,
                           participants, participants_flat, thread_id, sent_at, created_at)
     VALUES (?, ?, 'imessage', 'inbound', 'hello', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  );
  const addMsg = (id: string, threadId: string, from: string, sentAt: string): void => {
    insertMsg.run(
      id,
      USER,
      JSON.stringify({ from, to: ["me"] }),
      from,
      threadId,
      sentAt,
    );
  };

  // A named group: two members, so the SAME name must land on BOTH roster rows.
  addMsg("m-a", "th-named", IN_GROUP_A, "2026-01-18T10:00:00.000Z");
  addMsg("m-b", "th-named", IN_GROUP_B, "2026-01-17T10:00:00.000Z");
  // The same contact in a SECOND named group — both names must reach the row.
  addMsg("m-a2", "th-named-2", IN_GROUP_A, "2026-01-19T10:00:00.000Z");
  // A group with no name row at all.
  addMsg("m-c", "th-unnamed", NO_GROUP, "2026-01-16T10:00:00.000Z");
  // A 1:1 thread.
  addMsg("m-d", "th-solo", SOLO, "2026-01-15T10:00:00.000Z");
  // This user's message; the name row on that thread belongs to ANOTHER user.
  addMsg("m-e", "th-leak", LEAKED, "2026-01-14T10:00:00.000Z");

  const insertName = db.prepare(
    "INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?,?,?)",
  );
  insertName.run(USER, "th-named", GROUP_NAME);
  insertName.run(USER, "th-named-2", SECOND_GROUP_NAME);
  insertName.run(OTHER_USER, "th-leak", GROUP_NAME);
}

describe("BACKLOG-2816 — getMessageContacts carries group chat names", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    seed(db);
    setDb(db);
  });

  afterEach(() => {
    db.close();
  });

  const namesFor = (contact: string): string[] => {
    const row = getMessageContacts(USER).find((c) => c.contact === contact);
    expect(row).toBeDefined();
    return [...(row?.threadNames ?? [])].sort();
  };

  it("puts the group's name on EVERY member's roster entry", () => {
    expect(namesFor(IN_GROUP_A)).toContain(GROUP_NAME);
    expect(namesFor(IN_GROUP_B)).toEqual([GROUP_NAME]);
  });

  it("carries every named group a contact belongs to", () => {
    expect(namesFor(IN_GROUP_A)).toEqual([SECOND_GROUP_NAME, GROUP_NAME].sort());
  });

  it("returns an empty list for an unnamed group and for a 1:1 contact", () => {
    expect(namesFor(NO_GROUP)).toEqual([]);
    expect(namesFor(SOLO)).toEqual([]);
  });

  it("does not carry a name row owned by another user on the same thread_id", () => {
    expect(namesFor(LEAKED)).toEqual([]);
  });

  it("leaves the roster itself unchanged — same contacts, same message counts", () => {
    const rows = getMessageContacts(USER);
    expect(rows.map((r) => r.contact).sort()).toEqual(
      [IN_GROUP_A, IN_GROUP_B, NO_GROUP, SOLO, LEAKED].sort(),
    );
    // The names query must not fan out the count: IN_GROUP_A has two messages
    // across two NAMED threads, which a join + aggregate would have doubled.
    const a = rows.find((r) => r.contact === IN_GROUP_A);
    expect(a?.messageCount).toBe(2);
    expect(rows.find((r) => r.contact === IN_GROUP_B)?.messageCount).toBe(1);
  });

  it("excludes messages already linked to a transaction, names included", () => {
    // messages.transaction_id is a real FK, so the transaction has to exist.
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, started_at)
       VALUES ('t-x', ?, '1 Test St', '2026-01-01T00:00:00.000Z')`,
    ).run(USER);
    db.prepare("UPDATE messages SET transaction_id = 't-x' WHERE thread_id = 'th-named'").run();
    const rows = getMessageContacts(USER);
    // IN_GROUP_B had only that thread, so the contact leaves the roster entirely.
    expect(rows.map((r) => r.contact)).not.toContain(IN_GROUP_B);
    // IN_GROUP_A still has the second group, and only that group's name.
    expect(namesFor(IN_GROUP_A)).toEqual([SECOND_GROUP_NAME]);
  });
});
