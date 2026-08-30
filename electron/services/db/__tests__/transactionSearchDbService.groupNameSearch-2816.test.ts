/**
 * @jest-environment node
 *
 * BACKLOG-2816 — a group chat the user NAMED must be findable by search.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS, AND WHY IT USES A REAL DATABASE
 * ===========================================================================
 * BACKLOG-2814 imported Apple's `chat.display_name` into `message_thread_names`
 * and put it on the thread card. Nothing in the search path read that table, so
 * the name the founder could SEE was the one thing he could not search for.
 *
 * The sibling suite (`transactionSearchDbService.test.ts`) injects a FAKE db that
 * routes by an inert marker comment and returns canned rows. That is the right
 * tool for shaping/scoping assertions, but it cannot prove a WHERE clause
 * matches anything: its `all()` ignores the SQL and the bound params entirely.
 * A group-name test written against it would pass with the clause deleted.
 *
 * So this suite executes the REAL builders against a REAL sqlite database
 * created from the REAL `electron/database/schema.sql` — no hand-written schema
 * subset that could drift from production, no canned rows.
 *
 * Every group name here is invented for the fixture.
 *
 * ===========================================================================
 * CONTROLS (run and recorded — see the PR body)
 * ===========================================================================
 * Per surface: delete `OR ${TEXT_THREAD_NAME_MATCH}` from that ONE builder ->
 * only that surface's "found by name" test goes red, and the unnamed / 1:1 /
 * body / participants tests stay green.
 *
 * Isolation: replace `tn.user_id = m.user_id` with `1=1` -> the three
 * cross-user tests go red. macOS thread ids are unique only per machine, so two
 * users of one database can hold the same thread_id; a thread_id-only join
 * would pull another user's conversation into these results.
 */

// The default Jest moduleNameMapper rewrites "better-sqlite3-multiple-ciphers"
// to a stub; require the real package via an explicit node_modules path so this
// suite exercises actual SQL. Same technique as phoneNormalizedJoin.test.ts.
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";

import {
  searchLinkedContent,
  searchGlobalContent,
  type SearchableDb,
} from "../transactionSearchDbService";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "database", "schema.sql"),
  "utf8",
);

const USER = "u-2816";
const OTHER_USER = "u-2816-other";
const TXN = "t-2816";

/** Invented group name. The query below matches ONLY this string. */
const GROUP_NAME = "Kingfisher Lane Closing";
/** Query that can match nothing but a group name in this fixture. */
const NAME_QUERY = "kingfisher";
/** Bodies and handles are deliberately free of the name query's letters. */
const NEUTRAL_BODY = "on my way";

/**
 * One message per thread, four thread shapes per scope:
 *   named   — a group with a name row owned by THIS user (findable by name)
 *   unnamed — a group with no name row at all (must be unaffected)
 *   solo    — a 1:1 thread (must be unaffected)
 *   leak    — a thread whose name row is owned by ANOTHER user (must NOT match)
 * plus two prior-behaviour controls: a body match and a participants match.
 */
/**
 * Migration v56's DDL, transcribed. `schema.sql` deliberately declares
 * removed_at/removed_reason on NEITHER contacts nor transaction_contacts —
 * migration v56 is documented as "THE ONLY SOURCE OF THESE COLUMNS ON BOTH
 * INSTALL PATHS", because a 16th column on contacts would break v36's
 * positional 15-column copy. So schema.sql alone produces a database the
 * BACKLOG-2366 contact query ("tc.removed_at IS NULL") cannot run against, and
 * this fixture replays the ALTERs the way a real install does.
 */
const V56_TOMBSTONE_COLUMNS = `
`;

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(V56_TOMBSTONE_COLUMNS);

  const insertUser = db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google',?)",
  );
  insertUser.run(USER, "me@example.test", "o-me");
  insertUser.run(OTHER_USER, "them@example.test", "o-them");

  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, started_at, closed_at)
     VALUES (?,?,?,?,?)`,
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");

  const insertMsg = db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text,
                           participants, participants_flat, thread_id, sent_at, created_at)
     VALUES (?, ?, 'imessage', 'inbound', ?, ?, ?, ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  );
  const addMsg = (
    id: string,
    threadId: string,
    body: string,
    members: string[],
  ): void => {
    insertMsg.run(
      id,
      USER,
      body,
      JSON.stringify({ from: members[0], to: ["me"], chat_members: members }),
      members.join(","),
      threadId,
    );
  };

  const insertName = db.prepare(
    "INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?,?,?)",
  );
  const linkThread = db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source)
     VALUES (?, ?, ?, ?, NULL, 'manual')`,
  );

  const group = ["+15550100", "+15550101", "+15550102"];

  // ---- LINKED to TXN (drives buildTextQuery and buildGlobalTextQuery) ------
  const linkedIds = [
    "m-linked-named",
    "m-linked-unnamed",
    "m-linked-solo",
    "m-linked-body",
    "m-linked-leak",
  ];
  addMsg("m-linked-named", "th-linked-named", NEUTRAL_BODY, group);
  addMsg("m-linked-unnamed", "th-linked-unnamed", NEUTRAL_BODY, group);
  addMsg("m-linked-solo", "th-linked-solo", NEUTRAL_BODY, ["+15550177"]);
  addMsg("m-linked-body", "th-linked-body", "wire instructions attached", group);
  addMsg("m-linked-leak", "th-linked-leak", NEUTRAL_BODY, group);
  for (const id of linkedIds) linkThread.run(`c-${id}`, USER, TXN, id);

  insertName.run(USER, "th-linked-named", GROUP_NAME);
  // Same shape, WRONG owner: this user's message, another user's name row.
  insertName.run(OTHER_USER, "th-linked-leak", GROUP_NAME);

  // ---- UNATTACHED (no communications row — drives buildUnattachedTextQuery) --
  addMsg("m-unatt-named", "th-unatt-named", NEUTRAL_BODY, group);
  addMsg("m-unatt-unnamed", "th-unatt-unnamed", NEUTRAL_BODY, group);
  addMsg("m-unatt-solo", "th-unatt-solo", NEUTRAL_BODY, ["+15550188"]);
  addMsg("m-unatt-body", "th-unatt-body", "wire instructions attached", group);
  addMsg("m-unatt-leak", "th-unatt-leak", NEUTRAL_BODY, group);

  insertName.run(USER, "th-unatt-named", GROUP_NAME);
  insertName.run(OTHER_USER, "th-unatt-leak", GROUP_NAME);
}

describe("BACKLOG-2816 — group chat names are a search match target", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    seed(db);
  });

  afterEach(() => {
    db.close();
  });

  const asSearchable = (): SearchableDb => db as unknown as SearchableDb;

  const scopedTextIds = (query: string): string[] =>
    searchLinkedContent(asSearchable(), TXN, query).texts.items.map((t) => t.id).sort();

  const globalTextIds = (query: string): string[] =>
    searchGlobalContent(asSearchable(), USER, query).texts.items.map((t) => t.id).sort();

  const unattachedTextIds = (query: string): string[] =>
    searchGlobalContent(asSearchable(), USER, query)
      .unattached.items.filter((u) => u.kind === "text")
      .map((u) => u.id)
      .sort();

  // BACKLOG-2858: a group-NAME hit is no longer a Texts row. It is a Group chats
  // row, and the `*TextIds` accessors above now see message-level hits only.
  const scopedGroupChatIds = (query: string): string[] =>
    searchLinkedContent(asSearchable(), TXN, query).groupChats.items
      .map((t) => t.id)
      .sort();

  const globalGroupChatIds = (query: string): string[] =>
    searchGlobalContent(asSearchable(), USER, query).groupChats.items
      .map((t) => t.id)
      .sort();

  // =========================================================================
  // Surface 1 — transaction-scoped search (Overview tab), buildTextQuery
  // =========================================================================
  describe("transaction-scoped search (buildTextQuery)", () => {
    it("finds a thread whose ONLY possible match is its group name", () => {
      // BACKLOG-2858: the hit is real, and it is in Group chats now.
      expect(scopedGroupChatIds(NAME_QUERY)).toEqual(["m-linked-named"]);
      // Asserted in BOTH directions by identity: "it is in Group chats" alone
      // would still pass if the row were ALSO left behind in Texts.
      expect(scopedTextIds(NAME_QUERY)).toEqual([]);
    });

    it("leaves the unnamed group, the 1:1 thread and the body-match thread out of a name query", () => {
      const hits = [...scopedGroupChatIds(NAME_QUERY), ...scopedTextIds(NAME_QUERY)];
      expect(hits).not.toContain("m-linked-unnamed");
      expect(hits).not.toContain("m-linked-solo");
      expect(hits).not.toContain("m-linked-body");
    });

    it("does not match a name row owned by another user on the same thread_id", () => {
      expect(scopedGroupChatIds(NAME_QUERY)).not.toContain("m-linked-leak");
      expect(scopedTextIds(NAME_QUERY)).not.toContain("m-linked-leak");
    });

    it("still matches on body text exactly as before", () => {
      expect(scopedTextIds("wire instructions")).toEqual(["m-linked-body"]);
    });

    it("still matches on participants exactly as before", () => {
      expect(scopedTextIds("15550177")).toEqual(["m-linked-solo"]);
    });

    it("puts the conversation under Group chats and NOT under Texts", () => {
      // SUPERSEDED BY BACKLOG-2858: this used to assert one Texts hit, the
      // message inside the name-matching thread. That row moved to Group chats.
      // BACKLOG-2863 removed the badges, so the claim is made by IDENTITY on the
      // rows — which is stronger than the two numbers it replaces.
      const res = searchLinkedContent(asSearchable(), TXN, NAME_QUERY);
      expect(res.groupChats.items.map((t) => t.id)).toEqual(["m-linked-named"]);
      expect(res.texts.items).toEqual([]);
    });
  });

  // =========================================================================
  // Surface 2 — global search, Texts group, buildGlobalTextQuery
  // =========================================================================
  describe("global search, Texts group (buildGlobalTextQuery)", () => {
    it("finds a thread whose ONLY possible match is its group name", () => {
      expect(globalGroupChatIds(NAME_QUERY)).toEqual(["m-linked-named"]);
      expect(globalTextIds(NAME_QUERY)).toEqual([]);
    });

    it("leaves the unnamed group, the 1:1 thread and the body-match thread out of a name query", () => {
      const hits = [...globalGroupChatIds(NAME_QUERY), ...globalTextIds(NAME_QUERY)];
      expect(hits).not.toContain("m-linked-unnamed");
      expect(hits).not.toContain("m-linked-solo");
      expect(hits).not.toContain("m-linked-body");
    });

    it("does not match a name row owned by another user on the same thread_id", () => {
      expect(globalGroupChatIds(NAME_QUERY)).not.toContain("m-linked-leak");
      expect(globalTextIds(NAME_QUERY)).not.toContain("m-linked-leak");
    });

    it("still matches on body text exactly as before", () => {
      expect(globalTextIds("wire instructions")).toEqual(["m-linked-body"]);
    });

    it("still matches on participants exactly as before", () => {
      expect(globalTextIds("15550177")).toEqual(["m-linked-solo"]);
    });

    it("puts the conversation under Group chats and NOT under Texts", () => {
      // SUPERSEDED BY BACKLOG-2858 — see the scoped surface above.
      const res = searchGlobalContent(asSearchable(), USER, NAME_QUERY);
      expect(res.groupChats.items.map((t) => t.id)).toEqual(["m-linked-named"]);
      expect(res.texts.items).toEqual([]);
    });
  });

  // =========================================================================
  // Surface 2b — global search, Unattached bucket, buildUnattachedTextQuery
  // =========================================================================
  describe("global search, Unattached bucket (buildUnattachedTextQuery)", () => {
    it("finds an unattached thread whose ONLY possible match is its group name", () => {
      expect(unattachedTextIds(NAME_QUERY)).toEqual(["m-unatt-named"]);
    });

    it("leaves the unnamed group, the 1:1 thread and the body-match thread out of a name query", () => {
      const hits = unattachedTextIds(NAME_QUERY);
      expect(hits).not.toContain("m-unatt-unnamed");
      expect(hits).not.toContain("m-unatt-solo");
      expect(hits).not.toContain("m-unatt-body");
    });

    it("does not match a name row owned by another user on the same thread_id", () => {
      expect(unattachedTextIds(NAME_QUERY)).not.toContain("m-unatt-leak");
    });

    it("still matches on body text exactly as before", () => {
      expect(unattachedTextIds("wire instructions")).toEqual(["m-unatt-body"]);
    });

    it("still matches on participants exactly as before", () => {
      expect(unattachedTextIds("15550188")).toEqual(["m-unatt-solo"]);
    });
  });

  // =========================================================================
  // Shared semantics — the rule must be the one the neighbouring clauses use
  // =========================================================================
  describe("match semantics match the surrounding filter", () => {
    it("is case-insensitive and matches a substring, like the body clause", () => {
      expect(scopedGroupChatIds("KINGFISHER")).toEqual(["m-linked-named"]);
      expect(scopedGroupChatIds("fisher lane")).toEqual(["m-linked-named"]);
    });

    it("treats LIKE wildcards in the query as literal text", () => {
      // "%" must not become a match-everything pattern.
      expect(scopedGroupChatIds("%")).toEqual([]);
      expect(scopedGroupChatIds("King_isher")).toEqual([]);
      expect(scopedTextIds("%")).toEqual([]);
      expect(scopedTextIds("King_isher")).toEqual([]);
    });

    it("a group named with no query still returns nothing (empty query short-circuit)", () => {
      expect(scopedTextIds("   ")).toEqual([]);
    });
  });
});
